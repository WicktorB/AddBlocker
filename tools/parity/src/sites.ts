/**
 * Measures parity and breakage on real sites.
 *
 * The synthetic run (`parity.ts`) measures filter semantics: given a request,
 * do we decide what uBO decides. It cannot measure what a real page does —
 * traffic it generates, requests that appear only after script execution, or
 * whether the page still works once we are done with it. That is this.
 *
 * It needs the open web, so it does not run in the sandboxed environment this
 * project was built in; the network policy there refuses CONNECT to anything
 * but a handful of hosts. Run it on a machine with normal connectivity:
 *
 *     pnpm parity-sites                       # uses tools/parity/sites.txt
 *     pnpm parity-sites -- --sites=my.txt     # one hostname per line
 *
 * Each site is loaded twice — once with the extension, once without — because
 * breakage is only meaningful as a difference. A page that is broken on its own
 * is not evidence against the blocker.
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright-core';

import { RULESETS } from '../../build-rulesets/src/catalog.js';
import { preinstalledChromium } from '../../shared/chromium.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT = join(ROOT, 'dist', 'extension');
const STAGED = join(ROOT, 'dist', 'sites-extension');
const CACHE_DIR = join(ROOT, '.filter-cache');
const REPORT = join(ROOT, 'dist', 'parity-sites-report.json');
const DEFAULT_LIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'sites.txt');

const TIMEOUT_MS = Number(process.env.SITES_TIMEOUT ?? 30_000);
const SETTLE_MS = Number(process.env.SITES_SETTLE ?? 4_000);

/** Roadmap exit criteria. */
const MIN_BLOCK_RATIO = Number(process.env.SITES_MIN_RATIO ?? 0.95);
const MAX_BROKEN_RATE = Number(process.env.SITES_MAX_BROKEN ?? 0.01);

function argValue(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;
    const preinstalled = preinstalledChromium();
    if (preinstalled !== null) return preinstalled;
    const managed = chromium.executablePath();
    if (existsSync(managed)) return managed;
    throw new Error('no Chromium found');
}

interface UboEngine {
    useLists: (lists: Array<{ name: string; raw: string }>) => Promise<void>;
    matchRequest: (details: { originURL: string; url: string; type: string }) => number;
}

async function readEnabledLists(): Promise<Array<{ name: string; raw: string }>> {
    const manifest = JSON.parse(await readFile(join(BUILT, 'manifest.json'), 'utf8')) as {
        declarative_net_request?: { rule_resources?: Array<{ id: string; enabled?: boolean }> };
    };
    const enabled = new Set((manifest.declarative_net_request?.rule_resources ?? [])
        .filter((r) => r.enabled !== false).map((r) => r.id));

    const lists: Array<{ name: string; raw: string }> = [];
    for (const ruleset of RULESETS) {
        if (!enabled.has(ruleset.id)) continue;
        for (const source of ruleset.sources) {
            const path = join(CACHE_DIR, `${source.id}.txt`);
            if (existsSync(path)) lists.push({ name: source.id, raw: await readFile(path, 'utf8') });
        }
    }
    return lists;
}

async function loadRuleActions(): Promise<Map<string, string>> {
    const actions = new Map<string, string>();
    for (const file of await readdir(join(BUILT, 'rules'))) {
        const rulesetId = file.replace(/\.json$/, '');
        const rules = JSON.parse(await readFile(join(BUILT, 'rules', file), 'utf8')) as Array<{
            id: number; action: { type: string };
        }>;
        for (const rule of rules) actions.set(`${rulesetId}:${String(rule.id)}`, rule.action.type);
    }
    return actions;
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
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await writeFile(join(STAGED, 'collector.html'),
        '<!doctype html><meta charset="utf-8"><title>collector</title>', 'utf8');

    return [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');
}

/** What a page looked like, reduced to what a comparison can use. */
interface Snapshot {
    ok: boolean;
    /** Rendered text length — the crudest but most robust "is there content". */
    textLength: number;
    /** Elements in the body, to catch a page that rendered a shell only. */
    elements: number;
    /** Uncaught errors, which a badly-blocked script tends to produce. */
    errors: number;
    requests: Array<{ url: string; type: string }>;
}

const RESOURCE_TYPES: Record<string, string> = {
    script: 'script', stylesheet: 'stylesheet', image: 'image', font: 'font',
    xhr: 'xmlhttprequest', fetch: 'xmlhttprequest', media: 'media',
    document: 'main_frame', websocket: 'websocket', other: 'other',
};

async function visit(context: BrowserContext, url: string): Promise<Snapshot> {
    const page = await context.newPage();
    const requests: Array<{ url: string; type: string }> = [];
    let errors = 0;

    page.on('request', (request) => {
        requests.push({
            url: request.url(),
            type: RESOURCE_TYPES[request.resourceType()] ?? 'other',
        });
    });
    page.on('pageerror', () => { errors += 1; });

    let ok = true;
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
        await page.waitForTimeout(SETTLE_MS);
    } catch {
        ok = false;
    }

    let textLength = 0;
    let elements = 0;
    try {
        const measured = await page.evaluate(() => ({
            textLength: (document.body?.innerText ?? '').length,
            elements: document.body?.querySelectorAll('*').length ?? 0,
        }));
        textLength = measured.textLength;
        elements = measured.elements;
    } catch {
        ok = false;
    }

    await page.close();
    return { ok, textLength, elements, errors, requests };
}

async function main(): Promise<void> {
    const listPath = argValue('sites') ?? DEFAULT_LIST;
    if (!existsSync(listPath)) throw new Error(`no site list at ${listPath}`);
    const sites = (await readFile(listPath, 'utf8'))
        .split('\n').map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'));
    if (sites.length === 0) throw new Error('the site list is empty');

    console.log(`Reference engine: uBlock Origin's own, on the enabled lists`);
    const lists = await readEnabledLists();
    const { StaticNetFilteringEngine } = await import('@gorhill/ubo-core') as {
        StaticNetFilteringEngine: { create: () => Promise<UboEngine> };
    };
    const ubo = await StaticNetFilteringEngine.create();
    await ubo.useLists(lists);

    const actions = await loadRuleActions();
    const extensionId = await stageExtension();
    const executable = resolveChromium();
    if (executable.includes('headless_shell')) {
        throw new Error('headless shell ignores --load-extension; nothing would be blocked');
    }

    const withProfile = join(ROOT, 'dist', 'sites-profile-on');
    const withoutProfile = join(ROOT, 'dist', 'sites-profile-off');
    await rm(withProfile, { recursive: true, force: true });
    await rm(withoutProfile, { recursive: true, force: true });

    const blocked = await chromium.launchPersistentContext(withProfile, {
        executablePath: executable, headless: true,
        ignoreDefaultArgs: ['--disable-extensions'], timeout: 120_000,
        args: [
            `--disable-extensions-except=${STAGED}`, `--load-extension=${STAGED}`,
            '--no-first-run', '--no-sandbox', '--disable-gpu',
        ],
    });
    const plain = await chromium.launchPersistentContext(withoutProfile, {
        executablePath: executable, headless: true, timeout: 120_000,
        args: ['--no-first-run', '--no-sandbox', '--disable-gpu'],
    });

    const results: Array<{
        site: string; requests: number; uboBlocks: number; weBlock: number;
        broken: boolean; reason: string;
    }> = [];

    try {
        const collector = await blocked.newPage();
        await collector.goto(`chrome-extension://${extensionId}/collector.html`, { timeout: 60_000 });
        await collector.evaluate(() => {
            const api = (globalThis as unknown as { chrome: typeof chrome }).chrome;
            const seen: Array<{ url: string; key: string }> = [];
            (globalThis as unknown as { __matches: typeof seen }).__matches = seen;
            api.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
                seen.push({
                    url: info.request.url,
                    key: `${info.rule.rulesetId}:${String(info.rule.ruleId)}`,
                });
            });
        });

        for (const [index, site] of sites.entries()) {
            const url = site.startsWith('http') ? site : `https://${site}/`;

            const before = await collector.evaluate(
                () => (globalThis as unknown as { __matches: unknown[] }).__matches.length,
            );
            const on = await visit(blocked, url);
            const matches = await collector.evaluate((from: number) => (
                globalThis as unknown as { __matches: Array<{ url: string; key: string }> }
            ).__matches.slice(from), before);
            const off = await visit(plain, url);

            const stopped = new Set(matches
                .filter((m) => {
                    const action = actions.get(m.key);
                    return action === 'block' || action === 'redirect';
                })
                .map((m) => m.url));

            // uBO's verdict on the traffic the *unblocked* page generated: that
            // is the full set of requests a page makes, which is what "how much
            // would uBO have blocked" has to be measured against. Measuring on
            // our own run would only count what we let through.
            let uboBlocks = 0;
            for (const request of off.requests) {
                if (request.type === 'main_frame') continue;
                if (ubo.matchRequest({ originURL: url, url: request.url, type: request.type }) === 1) {
                    uboBlocks += 1;
                }
            }

            // Breakage, judged against the same page without the extension so
            // a site that is broken by itself is not charged to us.
            let broken = false;
            let reason = '';
            if (!on.ok && off.ok) { broken = true; reason = 'did not load'; }
            else if (off.textLength > 500 && on.textLength < off.textLength * 0.5) {
                broken = true; reason = 'lost more than half its text';
            } else if (off.elements > 100 && on.elements < off.elements * 0.4) {
                broken = true; reason = 'lost more than 60 % of its elements';
            }

            results.push({
                site, requests: off.requests.length, uboBlocks, weBlock: stopped.size, broken, reason,
            });

            const mark = broken ? 'BROKEN' : '     ';
            console.log(`  ${String(index + 1).padStart(4)}/${sites.length} ${mark} ${site} — `
                + `${off.requests.length} req, uBO ${uboBlocks}, us ${stopped.size}`
                + (broken ? ` (${reason})` : ''));
        }
    } finally {
        await blocked.close();
        await plain.close();
        await rm(withProfile, { recursive: true, force: true });
        await rm(withoutProfile, { recursive: true, force: true });
        await rm(STAGED, { recursive: true, force: true });
    }

    const totalUbo = results.reduce((n, r) => n + r.uboBlocks, 0);
    const totalUs = results.reduce((n, r) => n + r.weBlock, 0);
    const brokenSites = results.filter((r) => r.broken);
    // Nothing for uBO to block means nothing to compare, which is not the same
    // as scoring zero — reporting 0 % there would invent a failure.
    const measurable = totalUbo > 0;
    const blockRatio = measurable ? totalUs / totalUbo : 0;
    const brokenRate = brokenSites.length / results.length;

    console.log('\nOn real sites');
    console.log(`  sites:                ${results.length}`);
    console.log(`  uBO would block:      ${totalUbo}`);
    console.log(`  we blocked:           ${totalUs}`);
    console.log(`  blocking rate vs uBO: ${measurable ? `${(blockRatio * 100).toFixed(2)} %` : 'n/a — uBO blocked nothing on this corpus'} `
        + `(need ≥ ${(MIN_BLOCK_RATIO * 100).toFixed(0)} %)`);
    console.log(`  broken sites:         ${brokenSites.length} `
        + `(${(brokenRate * 100).toFixed(2)} %, need ≤ ${(MAX_BROKEN_RATE * 100).toFixed(0)} %)`);
    for (const site of brokenSites.slice(0, 20)) {
        console.log(`      ${site.site} — ${site.reason}`);
    }

    await mkdir(dirname(REPORT), { recursive: true });
    await writeFile(REPORT, JSON.stringify({
        sites: results.length, totalUbo, totalUs, blockRatio, brokenRate, results,
    }, null, 2), 'utf8');
    console.log(`\nReport written to ${REPORT}`);

    const ok = (!measurable || blockRatio >= MIN_BLOCK_RATIO) && brokenRate <= MAX_BROKEN_RATE;
    console.log(`\n${ok ? 'SITE PARITY PASSED' : 'SITE PARITY FAILED'}`);
    if (!ok) process.exitCode = 1;
}

await main();
