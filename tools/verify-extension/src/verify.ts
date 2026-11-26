/**
 * Loads the built extension into a real Chromium and asserts that it works.
 *
 * Chrome disables an entire ruleset, silently, when any rule in it is invalid.
 * Static analysis cannot see that — only the browser can. This runs in CI as a
 * blocking check.
 */

import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preinstalledChromium } from '../../shared/chromium.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT = join(ROOT, 'dist', 'extension');
/** Chrome's static rule pool: the 30 000 guaranteed plus the 300 000 shared. */
const STATIC_RULE_POOL = 330_000;
const STAGED = join(ROOT, 'dist', 'verify-extension');

/**
 * Where to find a Chromium that can load extensions.
 *
 * This must always resolve to the *full* Chromium binary. Leaving it undefined
 * is not an option: with `headless: true` Playwright would pick its headless
 * shell, which silently ignores --load-extension — every request would then
 * appear unblocked and the check would pass for the wrong reason.
 *
 * `chromium.executablePath()` returns the full browser, never the shell.
 */
function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;

    // Preinstalled in this dev container.
    const preinstalled = preinstalledChromium();
    if (preinstalled !== null) return preinstalled;

    // Installed by `playwright-core install chromium`, as CI does.
    const managed = chromium.executablePath();
    if (existsSync(managed)) return managed;

    throw new Error(
        `no Chromium found (tried CHROMIUM_PATH, the preinstalled browsers, ${managed}). ` +
        'Run: pnpm --filter @addblocker/verify-extension exec playwright-core install chromium',
    );
}

/**
 * The headless shell ignores --load-extension without saying so, which would
 * turn this check into a rubber stamp. Refuse it outright.
 */
function assertNotHeadlessShell(executable: string): void {
    if (executable.includes('headless_shell') || executable.includes('headless-shell')) {
        throw new Error(
            `refusing to run against the headless shell (${executable}): it ignores ` +
            '--load-extension, so every request would look unblocked. Use the full Chromium build.',
        );
    }
}

interface Probe {
    domain: string;
    shouldBlock: boolean;
    why: string;
}

/**
 * Copies the build and gives it a fixed key so the extension id is
 * predictable — the shipped manifest stays untouched.
 */
async function stageExtension(): Promise<string> {
    await rm(STAGED, { recursive: true, force: true });
    await mkdir(dirname(STAGED), { recursive: true });
    await cp(BUILT, STAGED, { recursive: true });

    const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const der = publicKey as unknown as Buffer;
    const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);
    const id = [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');

    const manifestPath = join(STAGED, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.key = der.toString('base64');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await writeFile(join(STAGED, 'verify.html'), '<!doctype html><meta charset="utf-8"><title>verify</title>', 'utf8');

    return id;
}

/** Picks probe domains from the built rules so the test tracks the real data. */
async function pickProbes(): Promise<Probe[]> {
    const rules = JSON.parse(await readFile(join(BUILT, 'rules', 'ads.json'), 'utf8')) as Array<{
        action: { type: string };
        condition: { requestDomains?: string[]; resourceTypes?: string[]; initiatorDomains?: string[] };
    }>;

    // An unconditional third-party block is the cleanest thing to assert on.
    const candidate = rules
        .filter((r) => r.action.type === 'block'
            && r.condition.requestDomains !== undefined
            && r.condition.resourceTypes === undefined
            && r.condition.initiatorDomains === undefined)
        .sort((a, b) => (b.condition.requestDomains?.length ?? 0) - (a.condition.requestDomains?.length ?? 0))[0];

    const domains = candidate?.condition.requestDomains ?? [];
    const probes: Probe[] = [
        { domain: 'definitely-not-in-any-list-9f3a2b.test', shouldBlock: false, why: 'control, must stay reachable' },
    ];

    // Sample across the merged array rather than trusting one entry.
    for (const index of [0, Math.floor(domains.length / 2), domains.length - 1]) {
        const domain = domains[index];
        if (domain !== undefined && !probes.some((p) => p.domain === domain)) {
            probes.push({ domain, shouldBlock: true, why: `from a merged rule of ${domains.length} domains` });
        }
    }

    return probes;
}

function startServer(probes: Probe[]): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
        if (req.url === '/' || req.url?.startsWith('/index')) {
            const list = probes.map((p) => JSON.stringify({ domain: p.domain, shouldBlock: p.shouldBlock })).join(',');
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(`<!doctype html><meta charset="utf-8"><title>probe</title>
<script>
window.__results = (async () => {
  const out = [];
  for (const p of [${list}]) {
    let blocked = false;
    try { await fetch('http://' + p.domain + '/ads.js', {cache:'no-store'}); }
    catch (e) { blocked = true; }
    out.push({domain: p.domain, shouldBlock: p.shouldBlock, blocked});
  }
  return out;
})();
</script>`);
            return;
        }
        res.writeHead(200, { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' });
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
    const extensionId = await stageExtension();
    const probes = await pickProbes();
    const expectedRulesets = (JSON.parse(await readFile(join(BUILT, 'manifest.json'), 'utf8')) as {
        declarative_net_request: { rule_resources: Array<{ id: string; enabled: boolean }> };
    }).declarative_net_request.rule_resources.filter((r) => r.enabled).map((r) => r.id).sort();

    const { server, port } = await startServer(probes);
    const profile = join(ROOT, 'dist', 'verify-profile');
    await rm(profile, { recursive: true, force: true });

    let failed = false;
    const executable = resolveChromium();
    assertNotHeadlessShell(executable);
    console.log(`Chromium: ${executable}\n`);

    const context = await chromium.launchPersistentContext(profile, {
        executablePath: executable,
        headless: true,
        // Playwright passes --disable-extensions by default, which silently
        // defeats --load-extension.
        ignoreDefaultArgs: ['--disable-extensions'],
        timeout: 120_000,
        args: [
            `--disable-extensions-except=${STAGED}`,
            `--load-extension=${STAGED}`,
            // All hostnames resolve to the local server: real network requests
            // for DNR to act on, with no external traffic.
            `--host-resolver-rules=MAP * 127.0.0.1:${port},EXCLUDE localhost`,
            '--no-first-run',
            '--no-sandbox',
            '--disable-gpu',
        ],
    });

    try {
        const page = await context.newPage();
        try {
            await page.goto(`chrome-extension://${extensionId}/verify.html`, { timeout: 60_000 });
        } catch (err) {
            // The extension page is unreachable only when Chrome never loaded
            // the extension — usually a rejected ruleset or a browser build
            // that ignores --load-extension.
            throw new Error(
                `the extension did not load in ${executable}. Chrome rejects an entire ` +
                'ruleset when any rule in it is invalid, and the headless shell ignores ' +
                `--load-extension entirely. Original error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
            );
        }

        const state = await page.evaluate(async () => {
            const dnr = (globalThis as unknown as { chrome: typeof chrome }).chrome.declarativeNetRequest;
            return {
                enabled: (await dnr.getEnabledRulesets()).sort(),
                available: await dnr.getAvailableStaticRuleCount(),
            };
        });

        console.log('Rulesets');
        console.log(`  expected: ${expectedRulesets.join(', ')}`);
        console.log(`  enabled:  ${state.enabled.join(', ')}`);
        const allEnabled = JSON.stringify(state.enabled) === JSON.stringify(expectedRulesets);
        console.log(`  ${allEnabled ? 'PASS' : 'FAIL'}  every default ruleset accepted`);
        if (!allEnabled) failed = true;
        console.log(`  static rules still available: ${state.available}`);

        // Chrome accepts a ruleset and still drops individual rules from it: a
        // regex over its memory budget, a field it cannot parse. It says so
        // only on the extensions page, as warnings nobody reads in CI — which
        // is how 76 rules shipped dead until a user opened that page. Two
        // checks stand in for reading it.
        console.log('\nRules Chrome actually loaded');
        const shipped: Array<{ ruleset: string; id: number; regex?: string; caseSensitive: boolean }> = [];
        const enabledSet = new Set(state.enabled);
        for (const file of await readdir(join(BUILT, 'rules'))) {
            const ruleset = file.replace(/\.json$/, '');
            if (!enabledSet.has(ruleset)) continue;
            const rules = JSON.parse(await readFile(join(BUILT, 'rules', file), 'utf8')) as Array<{
                id: number; condition: { regexFilter?: string; isUrlFilterCaseSensitive?: boolean };
            }>;
            for (const rule of rules) {
                shipped.push({
                    ruleset, id: rule.id, regex: rule.condition.regexFilter,
                    caseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
                });
            }
        }

        // 1. Every regex, put to the browser's own judgement.
        const regexRules = shipped.filter((rule) => rule.regex !== undefined);
        const verdicts = await page.evaluate(async (rules) => {
            const dnr = (globalThis as unknown as { chrome: typeof chrome }).chrome.declarativeNetRequest;
            const out: Array<{ supported: boolean; reason: string }> = [];
            for (const rule of rules) {
                const result = await dnr.isRegexSupported({ regex: rule.regex, isCaseSensitive: rule.caseSensitive });
                out.push({ supported: result.isSupported, reason: result.reason ?? '' });
            }
            return out;
        }, regexRules.map((rule) => ({ regex: rule.regex ?? '', caseSensitive: rule.caseSensitive })));
        const refused = regexRules.filter((_, index) => !verdicts[index].supported);
        console.log(`  ${refused.length === 0 ? 'PASS' : 'FAIL'}  ${regexRules.length} regex rules, `
            + `${refused.length} refused by Chrome`);
        for (const rule of refused.slice(0, 5)) {
            console.log(`        ${rule.ruleset} #${rule.id}: ${(rule.regex ?? '').slice(0, 90)}`);
        }
        if (refused.length > 0) {
            failed = true;
            console.log('        the regex cost estimate in dnr-compiler/validate.ts let these through; lower its limit');
        }

        // 2. The count. Rules Chrome skipped for any other reason do not use
        // up quota, so the quota it reports as used must equal what we shipped.
        const loaded = STATIC_RULE_POOL - state.available;
        const countsMatch = loaded === shipped.length;
        console.log(`  ${countsMatch ? 'PASS' : 'FAIL'}  shipped ${shipped.length} rules, Chrome counts ${loaded}`
            + `${countsMatch ? '' : ` — ${shipped.length - loaded} skipped; see the extension's Errors page`}`);
        if (!countsMatch) failed = true;

        await page.close();

        const probePage = await context.newPage();
        await probePage.goto(`http://probe.test:${port}/`, { waitUntil: 'load' });
        const results = await probePage.evaluate(
            () => (window as unknown as { __results: Promise<unknown> }).__results,
        ) as Array<{ domain: string; shouldBlock: boolean; blocked: boolean }>;

        console.log('\nEnforcement');
        for (const result of results) {
            const ok = result.blocked === result.shouldBlock;
            if (!ok) failed = true;
            const why = probes.find((p) => p.domain === result.domain)?.why ?? '';
            console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${result.domain} — ${result.blocked ? 'blocked' : 'allowed'} (${why})`);
        }
    } finally {
        await context.close();
        server.close();
        await rm(profile, { recursive: true, force: true });
        await rm(STAGED, { recursive: true, force: true });
    }

    console.log(`\n${failed ? 'VERIFICATION FAILED' : 'VERIFICATION PASSED'}`);
    if (failed) process.exitCode = 1;
}

await main();
