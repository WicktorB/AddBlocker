/**
 * Differential oracle: compares our blocking decisions against
 * @adguard/tsurlfilter's on the same corpus.
 *
 * tsurlfilter has years of maturity on edge cases we cannot hope to match by
 * inspection. It is not the arbiter of truth — it has its own gaps, and DNR
 * genuinely cannot express some of what it does — but every divergence is a
 * question worth answering rather than a number to admire.
 *
 * Ours is measured through a real Chromium running the built extension, so the
 * comparison is against what actually happens, not what we think our rules mean.
 */

import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

import { EXTENSION_ENV, preprocess } from '@addblocker/filter-parser';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Engine, NetworkRuleOption, Request, RequestType } from '@adguard/tsurlfilter';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT = join(ROOT, 'dist', 'extension');
const STAGED = join(ROOT, 'dist', 'oracle-extension');
const CACHE_DIR = join(ROOT, '.filter-cache');
/**
 * Where to find a Chromium that can load extensions.
 *
 * Must always resolve to the *full* browser: with `headless: true` Playwright
 * would otherwise pick its headless shell, which ignores --load-extension —
 * every request would look unblocked and the comparison would be meaningless.
 */
function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;

    const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (existsSync(preinstalled)) return preinstalled;

    const managed = chromium.executablePath();
    if (existsSync(managed)) return managed;

    throw new Error(`no Chromium found (tried CHROMIUM_PATH, ${preinstalled}, ${managed})`);
}

/** How many domains to sample per category. Kept modest: each is a real fetch. */
const SAMPLE_SIZE = Number(process.env.ORACLE_SAMPLE ?? 300);

interface Probe {
    url: string;
    initiator: string;
    type: 'script' | 'image' | 'xmlhttprequest';
}

interface Divergence {
    probe: Probe;
    oracle: boolean;
    ours: boolean;
    /** Options carried by the oracle's matching rule. */
    oracleOptions?: { popup: boolean };
    /** Set when the divergence is a known, deliberate consequence of our design. */
    explanation?: string;
}

/**
 * Known, deliberate divergences.
 *
 * A divergence is only acceptable if we can say why. Anything that falls
 * through to "unexplained" is a bug to investigate, and fails the run.
 */
function explain(options: { popup: boolean } | undefined): string | null {
    if (options === undefined) return null;

    // We translate $popup to a main_frame block, so it correctly does not
    // match a script or image request; tsurlfilter matches it on any type.
    // Ours is the closer reading of what $popup means.
    if (options.popup) return 'popup→main_frame: does not apply to subresource requests';

    return null;
}

/** Deterministic sampling so runs are comparable. */
function sample<T>(items: T[], count: number): T[] {
    if (items.length <= count) return items;
    const step = items.length / count;
    return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]);
}

/**
 * Maps `rulesetId:ruleId` to the action that rule takes.
 *
 * onRuleMatchedDebug reports which rule fired but not what it does, so we
 * recover the action from the built rulesets.
 */
async function loadRuleActions(): Promise<Map<string, string>> {
    const actions = new Map<string, string>();
    for (const file of await readdir(join(BUILT, 'rules'))) {
        const rulesetId = file.replace(/\.json$/, '');
        const rules = JSON.parse(await readFile(join(BUILT, 'rules', file), 'utf8')) as Array<{
            id: number;
            action: { type: string };
        }>;
        for (const rule of rules) actions.set(`${rulesetId}:${rule.id}`, rule.action.type);
    }
    return actions;
}

async function loadCorpusDomains(): Promise<string[]> {
    const files = await readdir(join(BUILT, 'rules'));
    const domains = new Set<string>();

    for (const file of files) {
        const rules = JSON.parse(await readFile(join(BUILT, 'rules', file), 'utf8')) as Array<{
            action: { type: string };
            condition: { requestDomains?: string[] };
        }>;
        for (const rule of rules) {
            if (rule.action.type !== 'block') continue;
            for (const domain of rule.condition.requestDomains ?? []) domains.add(domain);
        }
    }

    return [...domains].sort();
}

/** Domains that must keep working — the false-positive half of the corpus. */
const CONTROL_DOMAINS = [
    'wikipedia.org', 'github.com', 'mozilla.org', 'debian.org', 'kernel.org',
    'lemonde.fr', 'service-public.fr', 'insee.fr', 'openstreetmap.org',
    'stackoverflow.com', 'archive.org', 'gnu.org', 'python.org', 'rust-lang.org',
];

async function buildOracle(): Promise<Engine> {
    const files = await readdir(CACHE_DIR);
    const filters = [];
    let id = 1;
    for (const file of files) {
        if (!file.endsWith('.txt')) continue;
        // Resolved exactly as the build resolves them, so both sides are
        // compiling the same filters.
        const content = preprocess(await readFile(join(CACHE_DIR, file), 'utf8'), EXTENSION_ENV).text;
        filters.push({ id: id++, content, ignoreCosmetic: true });
    }
    return Engine.createSync({ filters });
}

const REQUEST_TYPES = {
    script: RequestType.Script,
    image: RequestType.Image,
    xmlhttprequest: RequestType.XmlHttpRequest,
} as const;

function oracleBlocks(engine: Engine, probe: Probe): { blocks: boolean; options?: { popup: boolean } } {
    const result = engine.matchRequest(
        new Request(probe.url, `http://${probe.initiator}/`, REQUEST_TYPES[probe.type]),
    );
    const rule = result.getBasicResult();
    if (rule === null || rule.isAllowlist()) return { blocks: false };
    return { blocks: true, options: { popup: rule.isOptionEnabled(NetworkRuleOption.Popup) } };
}

async function stageExtension(): Promise<string> {
    await rm(STAGED, { recursive: true, force: true });
    await cp(BUILT, STAGED, { recursive: true });

    const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const der = publicKey as unknown as Buffer;
    const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);

    const manifestPath = join(STAGED, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.key = der.toString('base64');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    // Extension page that stays open to collect onRuleMatchedDebug events.
    await writeFile(join(STAGED, 'collector.html'),
        '<!doctype html><meta charset="utf-8"><title>collector</title>', 'utf8');

    return [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');
}

function startServer(): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
        if (req.url?.startsWith('/__runner')) {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<!doctype html><meta charset="utf-8"><title>runner</title>');
            return;
        }
        res.writeHead(200, {
            'content-type': 'application/javascript',
            'access-control-allow-origin': '*',
        });
        res.end('/* served */');
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
        });
    });
}

async function main(): Promise<void> {
    console.log('Building oracle engine from the same lists…');
    const engine = await buildOracle();

    const blockedDomains = sample(await loadCorpusDomains(), SAMPLE_SIZE);
    const probes: Probe[] = [
        ...blockedDomains.map((domain): Probe => ({
            url: `http://${domain}/ads.js`,
            initiator: 'example-publisher.test',
            type: 'script',
        })),
        ...CONTROL_DOMAINS.map((domain): Probe => ({
            url: `http://${domain}/app.js`,
            initiator: 'example-publisher.test',
            type: 'script',
        })),
    ];

    console.log(`Corpus: ${probes.length} requests (${blockedDomains.length} from block rules, ${CONTROL_DOMAINS.length} controls)\n`);

    const oracleVerdicts = probes.map((probe) => oracleBlocks(engine, probe));

    const extensionId = await stageExtension();
    const { server, port } = await startServer();
    const profile = join(ROOT, 'dist', 'oracle-profile');
    await rm(profile, { recursive: true, force: true });

    const executable = resolveChromium();
    if (executable.includes('headless_shell') || executable.includes('headless-shell')) {
        // The shell ignores --load-extension, so nothing would be blocked and
        // every probe would read as a divergence.
        throw new Error(`refusing to run against the headless shell (${executable})`);
    }
    console.log(`Chromium: ${executable}`);

    const context = await chromium.launchPersistentContext(profile, {
        executablePath: executable,
        headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        timeout: 120_000,
        args: [
            `--disable-extensions-except=${STAGED}`,
            `--load-extension=${STAGED}`,
            `--host-resolver-rules=MAP * 127.0.0.1:${port},EXCLUDE localhost`,
            '--no-first-run', '--no-sandbox', '--disable-gpu',
        ],
    });

    let ourVerdicts: boolean[] = [];
    try {
        const ruleActions = await loadRuleActions();

        // Listen for rule matches from an extension page.
        //
        // A failed fetch is NOT proof of blocking: HSTS upgrades, TLS failures
        // and plain network errors all throw the same way, and the browser's
        // behaviour there varies by version. onRuleMatchedDebug reports what
        // the extension actually did, which is the only sound measure.
        // It requires declarativeNetRequestFeedback and an unpacked extension —
        // both true here.
        const listener = await context.newPage();
        await listener.goto(`chrome-extension://${extensionId}/collector.html`, { timeout: 60_000 });
        await listener.evaluate(() => {
            const w = window as unknown as { __matches: Array<{ url: string; key: string }> };
            w.__matches = [];
            (globalThis as unknown as { chrome: typeof chrome }).chrome
                .declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
                    w.__matches.push({
                        url: info.request.url,
                        key: `${info.rule.rulesetId}:${info.rule.ruleId}`,
                    });
                });
        });

        const page = await context.newPage();
        await page.goto(`http://${probes[0].initiator}:${port}/__runner`, { waitUntil: 'load' });

        const fetchFailed = await page.evaluate(async (urls: string[]) => {
            const out: boolean[] = [];
            // As a <script>, not with fetch(): the probes are declared to the
            // oracle as script requests, and fetch() issues an xmlhttprequest.
            // A rule restricted to `$script` rightly ignores that, which showed
            // up as "the oracle blocks, we do not" for a rule that was correct.
            for (const url of urls) {
                out.push(await new Promise<boolean>((resolve) => {
                    const element = document.createElement('script');
                    element.onload = () => { element.remove(); resolve(false); };
                    element.onerror = () => { element.remove(); resolve(true); };
                    element.src = url;
                    document.documentElement.append(element);
                }));
            }
            return out;
        }, probes.map((p) => p.url));

        const matches = await listener.evaluate(
            () => (window as unknown as { __matches: Array<{ url: string; key: string }> }).__matches,
        );

        // A probe counts as blocked only when a rule whose action is `block`
        // fired for its URL.
        //
        // Compared without the scheme. A domain on Chrome's HSTS preload list
        // is upgraded to https before the request is made, so the rule fires
        // for `https://…` while the probe asked for `http://…` — the same
        // request, blocked, and an exact comparison would report it as let
        // through.
        const schemeless = (url: string): string => url.replace(/^https?:/, '');
        const blockedRequests = new Set(
            matches.filter((m) => ruleActions.get(m.key) === 'block').map((m) => schemeless(m.url)),
        );
        const blockedUrls = { has: (url: string): boolean => blockedRequests.has(schemeless(url)) };
        ourVerdicts = probes.map((p) => blockedUrls.has(p.url));

        // Surface the gap between the two signals: a fetch that failed without
        // a matching block rule is an environment artefact, not our doing.
        const artefacts = probes.filter((p, i) => fetchFailed[i] && !blockedUrls.has(p.url));
        if (artefacts.length > 0) {
            console.log(`\nNote: ${artefacts.length} request(s) failed without any block rule firing ` +
                '(HSTS upgrade, TLS or network error — not blocking):');
            for (const p of artefacts.slice(0, 5)) console.log(`  ${p.url}`);
        }
    } finally {
        await context.close();
        server.close();
        await rm(profile, { recursive: true, force: true });
        await rm(STAGED, { recursive: true, force: true });
    }

    const divergences: Divergence[] = [];
    let agree = 0;
    for (let i = 0; i < probes.length; i += 1) {
        const oracle = oracleVerdicts[i].blocks;
        if (oracle === ourVerdicts[i]) {
            agree += 1;
            continue;
        }
        const oracleOptions = oracleVerdicts[i].options;
        divergences.push({
            probe: probes[i],
            oracle,
            ours: ourVerdicts[i],
            oracleOptions,
            explanation: explain(oracleOptions) ?? undefined,
        });
    }

    const agreement = (100 * agree) / probes.length;
    console.log('Agreement');
    console.log(`  ${agree}/${probes.length} (${agreement.toFixed(2)}%)`);

    const weMissed = divergences.filter((d) => d.oracle && !d.ours);
    const weOverBlocked = divergences.filter((d) => !d.oracle && d.ours);
    const unexplained = divergences.filter((d) => d.explanation === undefined);

    console.log(`  oracle blocks, we do not:  ${weMissed.length}`);
    console.log(`  we block, oracle does not: ${weOverBlocked.length}`);
    console.log(`  explained:                 ${divergences.length - unexplained.length}/${divergences.length}`);

    const byExplanation = new Map<string, number>();
    for (const d of divergences) {
        const key = d.explanation ?? 'UNEXPLAINED';
        byExplanation.set(key, (byExplanation.get(key) ?? 0) + 1);
    }
    if (byExplanation.size > 0) {
        console.log('\nDivergences by cause');
        for (const [cause, count] of [...byExplanation].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${String(count).padStart(4)}  ${cause}`);
        }
    }

    if (unexplained.length > 0) {
        console.log('\nUnexplained (first 15)');
        for (const d of unexplained.slice(0, 15)) {
            console.log(`  oracle=${d.oracle ? 'block' : 'allow'} ours=${d.ours ? 'block' : 'allow'}  ` +
                `${d.probe.url}\n      oracle options: ${JSON.stringify(d.oracleOptions) ?? '(none)'}`);
        }
    }

    await mkdir(join(ROOT, 'dist'), { recursive: true });
    await writeFile(
        join(ROOT, 'dist', 'oracle-report.json'),
        JSON.stringify({ total: probes.length, agree, agreement, divergences }, null, 2),
        'utf8',
    );

    const failures: string[] = [];
    // Over-blocking is what breaks sites, so it always fails the run.
    if (weOverBlocked.length > 0) failures.push(`${weOverBlocked.length} request(s) blocked that the oracle allows`);
    // Phase 1's exit criterion: no divergence may go unexplained.
    if (unexplained.length > 0) failures.push(`${unexplained.length} unexplained divergence(s)`);

    if (failures.length > 0) {
        console.error('\nORACLE DIFF FAILED');
        for (const failure of failures) console.error(`  - ${failure}`);
        process.exitCode = 1;
        return;
    }

    console.log('\nORACLE DIFF PASSED — no over-blocking, every divergence explained');
}

await main();
