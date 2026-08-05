/**
 * Verifies the user-facing flows end to end in a real Chromium.
 *
 * The exit criterion for this phase is behavioural: a user must be able to
 * unblock a broken site and create a filter without leaving the browser. So
 * that is what this drives — the settings, the resulting rules, and whether
 * the page's behaviour actually changes.
 */

import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT = join(ROOT, 'dist', 'extension');
const STAGED = join(ROOT, 'dist', 'ui-check-extension');

function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;
    const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (existsSync(preinstalled)) return preinstalled;
    const managed = chromium.executablePath();
    if (existsSync(managed)) return managed;
    throw new Error('no Chromium found');
}

/** A domain the build blocks, so "turn it off here" has something to undo. */
async function pickBlockedDomain(): Promise<string> {
    const rules = JSON.parse(await readFile(join(BUILT, 'rules', 'ads.json'), 'utf8')) as Array<{
        action: { type: string };
        condition: { requestDomains?: string[]; resourceTypes?: string[]; initiatorDomains?: string[] };
    }>;

    const candidate = rules
        .filter((r) => r.action.type === 'block'
            && r.condition.requestDomains !== undefined
            && r.condition.resourceTypes === undefined
            && r.condition.initiatorDomains === undefined)
        .sort((a, b) => (b.condition.requestDomains?.length ?? 0) - (a.condition.requestDomains?.length ?? 0))[0];

    const domain = candidate?.condition.requestDomains?.[0];
    if (domain === undefined) throw new Error('no blocked domain found in the build');
    return domain;
}

/**
 * A selector the generic sheet hides, taken from the build rather than
 * hard-coded so the check keeps testing something real as lists change.
 */
async function pickGenericId(): Promise<string> {
    const sheet = await readFile(join(BUILT, 'cosmetic', 'generic.js'), 'utf8');
    const match = /"#([A-Za-z][\w-]{2,40})"/.exec(sheet);
    if (match === null) throw new Error('no plain id selector found in the generic sheet');
    return match[1];
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

    return [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');
}

function startServer(blockedDomain: string, genericId: string): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
        if (req.url?.endsWith('.js')) {
            res.writeHead(200, {
                'content-type': 'application/javascript',
                'access-control-allow-origin': '*',
            });
            res.end('/* served */');
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><title>ui</title>
<div class="ab-target">an element to hide</div>
<div id="${genericId}">hidden by the generic sheet</div>
<div id="sentinel">stays visible</div>
<script>
window.__blocked = null;
fetch('http://${blockedDomain}/ads.js', {cache:'no-store'})
  .then(() => { window.__blocked = false; })
  .catch(() => { window.__blocked = true; });
</script>`);
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
        });
    });
}

/** Runs a message against the service worker from an extension page. */
async function send(context: BrowserContext, extensionId: string, message: unknown): Promise<unknown> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`, { timeout: 60_000 });
    const result = await page.evaluate(async (msg) => {
        const runtime = (globalThis as unknown as { chrome: typeof chrome }).chrome.runtime;
        return runtime.sendMessage(msg);
    }, message);
    await page.close();
    return result;
}

/** State of the test page, as the user would see it. */
interface PageState {
    blocked: boolean | null;
    userFilterHidden: boolean;
    genericHidden: boolean;
    sentinelVisible: boolean;
}

async function main(): Promise<void> {
    const blockedDomain = await pickBlockedDomain();
    const genericId = await pickGenericId();
    const extensionId = await stageExtension();
    const { server, port } = await startServer(blockedDomain, genericId);
    const profile = join(ROOT, 'dist', 'ui-profile');
    await rm(profile, { recursive: true, force: true });

    const executable = resolveChromium();
    if (executable.includes('headless_shell')) throw new Error('headless shell cannot load extensions');
    console.log(`Chromium: ${executable}`);
    console.log(`Blocked domain used as the probe: ${blockedDomain}\n`);

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

    let failed = false;
    const check = (ok: boolean, label: string, detail = ''): void => {
        if (!ok) failed = true;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
    };

    const site = 'ui-test-site.example';

    /** Loads the test page once and reports what the user would see. */
    const readPage = async (): Promise<PageState> => {
        const page = await context.newPage();
        await page.goto(`http://${site}:${port}/`, { waitUntil: 'load' });
        await page.waitForTimeout(150);
        // No helper functions in here: tsx transpiles them with an esbuild
        // shim that does not exist in the page.
        const state = await page.evaluate((id) => {
            const target = document.querySelector('.ab-target');
            const generic = document.getElementById(id);
            const sentinel = document.getElementById('sentinel');
            return {
                blocked: (window as unknown as { __blocked: boolean | null }).__blocked,
                userFilterHidden: target === null || target.getBoundingClientRect().height === 0,
                genericHidden: generic === null || generic.getBoundingClientRect().height === 0,
                sentinelVisible: sentinel !== null && sentinel.getBoundingClientRect().height > 0,
            };
        }, genericId);
        await page.close();
        return state;
    };

    /**
     * Reloads until the page looks as expected, up to a budget.
     *
     * Settings do not all take effect at the same speed — a DNR rule lands in
     * milliseconds while rewriting script exclusions takes seconds — so a fixed
     * sleep would either be slow or flaky depending on the machine. Waiting for
     * the condition and reporting how long it took turns a latency regression
     * into a number instead of an intermittent failure.
     */
    const waitForPage = async (
        want: (state: PageState) => boolean,
        budgetMs = 30_000,
    ): Promise<{ state: PageState; ms: number }> => {
        const started = Date.now();
        let state = await readPage();
        while (!want(state) && Date.now() - started < budgetMs) {
            state = await readPage();
        }
        return { state, ms: Date.now() - started };
    };

    try {
        // Registering ~144 bucket scripts takes about 9 seconds on a fresh
        // profile. Probing before it lands would measure the race, not the
        // behaviour.
        const ready = await context.newPage();
        await ready.goto(`chrome-extension://${extensionId}/options.html`, { timeout: 60_000 });
        const registered = await ready.evaluate(async () => {
            const scripting = (globalThis as unknown as { chrome: typeof chrome }).chrome.scripting;
            for (let attempt = 0; attempt < 60; attempt += 1) {
                const scripts = await scripting.getRegisteredContentScripts();
                if (scripts.length >= 100) return scripts.length;
                await new Promise((r) => { setTimeout(r, 1000); });
            }
            return (await scripting.getRegisteredContentScripts()).length;
        });
        await ready.close();
        console.log(`Content scripts registered: ${registered}\n`);

        // The UI surfaces must exist at all before anything else can be tested.
        console.log('Surfaces');
        for (const page of ['popup.html', 'options.html']) {
            const tab = await context.newPage();
            const response = await tab.goto(`chrome-extension://${extensionId}/${page}`, { timeout: 60_000 });
            check(response !== null && response.status() < 400, `${page} loads`);
            await tab.close();
        }

        const state = await send(context, extensionId, { type: 'getState', payload: {} }) as {
            settings?: { disabledSites: string[]; userFilters: string[] };
        };
        check(state?.settings !== undefined, 'service worker answers getState');

        // Baseline: before touching anything, the request is blocked and the
        // generic sheet has hidden its element.
        console.log('\nBlocking a site, then turning it off there');
        const baseline = await waitForPage((s) => s.blocked === true && s.genericHidden);
        check(baseline.state.blocked === true, 'request is blocked before disabling',
            `__blocked=${baseline.state.blocked}`);
        check(baseline.state.genericHidden, `the generic sheet hides #${genericId}`);

        const toggleStarted = Date.now();
        const toggled = await send(context, extensionId, {
            type: 'toggleSite', payload: { hostname: site },
        }) as { ok?: boolean; disabled?: boolean };
        const toggleMs = Date.now() - toggleStarted;
        check(toggleMs < 5_000, 'toggleSite answers promptly', `${toggleMs}ms`);
        check(toggled?.ok === true && toggled.disabled === true, 'toggleSite disables the site');

        const afterSettings = await send(context, extensionId, { type: 'getState', payload: {} }) as {
            settings?: { disabledSites: string[] };
        };
        check(afterSettings?.settings?.disabledSites.includes(site) === true,
            'the site is recorded as disabled');

        // "Off here" has to mean off for both halves. The network half lands in
        // milliseconds; cosmetic filtering stops once the script exclusions are
        // rewritten, which is slower, so each is waited for on its own terms.
        const unblocked = await waitForPage((s) => s.blocked === false);
        check(unblocked.state.blocked === false, 'request goes through once the site is disabled',
            `__blocked=${unblocked.state.blocked} after ${unblocked.ms}ms`);

        const uncosmetic = await waitForPage((s) => !s.genericHidden);
        check(!uncosmetic.state.genericHidden,
            'cosmetic filtering stops on a disabled site', `after ${uncosmetic.ms}ms`);

        // And back off again, so the toggle is genuinely reversible.
        await send(context, extensionId, { type: 'toggleSite', payload: { hostname: site } });
        const reblocked = await waitForPage((s) => s.blocked === true);
        check(reblocked.state.blocked === true, 're-enabling restores blocking',
            `__blocked=${reblocked.state.blocked} after ${reblocked.ms}ms`);

        const recosmetic = await waitForPage((s) => s.genericHidden);
        check(recosmetic.state.genericHidden, 're-enabling restores cosmetic filtering',
            `after ${recosmetic.ms}ms`);

        // Creating a filter, as the picker does.
        console.log('\nCreating a filter');
        await send(context, extensionId, {
            type: 'addFilter', payload: { filter: `${site}##.ab-target` },
        });

        const withFilter = await send(context, extensionId, { type: 'getState', payload: {} }) as {
            settings?: { userFilters: string[] };
        };
        check(withFilter?.settings?.userFilters.includes(`${site}##.ab-target`) === true,
            'the filter is stored');

        const filtered = await waitForPage((s) => s.userFilterHidden);
        check(filtered.state.userFilterHidden, 'the element is hidden by the user filter',
            `after ${filtered.ms}ms`);
        check(filtered.state.sentinelVisible, 'other content is untouched');

        // The picker must be reachable — the popup injects it by URL.
        const pickerUrl = `chrome-extension://${extensionId}/picker.js`;
        const pickerPage = await context.newPage();
        const pickerResponse = await pickerPage.goto(pickerUrl, { timeout: 30_000 });
        check(pickerResponse !== null && pickerResponse.status() < 400, 'picker.js is web accessible');
        await pickerPage.close();
    } finally {
        await context.close();
        server.close();
        await rm(profile, { recursive: true, force: true });
        await rm(STAGED, { recursive: true, force: true });
    }

    console.log(`\n${failed ? 'UI CHECK FAILED' : 'UI CHECK PASSED'}`);
    if (failed) process.exitCode = 1;
}

await main();
