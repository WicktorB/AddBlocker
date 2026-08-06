/**
 * Verifies that `pnpm update-filters` really puts the rebuild into effect.
 *
 * This is the one step of an update that cannot be checked by looking at
 * files: either Chrome picks the new rules up, or the user goes on running the
 * old ones without noticing. So the check changes the rules on disk, reloads
 * through the same code path the update script uses, and looks for the *new*
 * behaviour in a page — not merely for a worker that restarted.
 *
 * How the extension is installed matters here, and it caught a real trap: an
 * extension loaded with `--load-extension` is gone for good after
 * `chrome.runtime.reload()` — the flag loads it once and nothing re-adds it.
 * Testing that way would have reported failure for a mechanism that works.
 * `Extensions.loadUnpacked` installs it the way the user's "Load unpacked"
 * button does, which is the configuration the update script targets.
 */

import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright-core';

import { reloadExtension } from '../../update-filters/src/reload.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT = join(ROOT, 'dist', 'extension');
const STAGED = join(ROOT, 'dist', 'reload-check-extension');
const DEBUG_PORT = 9333;

/** Not in any filter list, so it is only ever blocked by the rule added below. */
const NEW_DOMAIN = 'freshly-blocked-9f3a2b.test';

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;
    const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (existsSync(preinstalled)) return preinstalled;
    const managed = chromium.executablePath();
    if (existsSync(managed)) return managed;
    throw new Error('no Chromium found');
}

/** A domain the current build blocks, to show the baseline is real. */
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

function startServer(known: string): Promise<{ server: Server; port: number }> {
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
        res.end(`<!doctype html><meta charset="utf-8"><title>reload</title>
<script>
window.__known = null; window.__fresh = null;
fetch('http://${known}/ads.js', {cache:'no-store'})
  .then(() => { window.__known = false; }).catch(() => { window.__known = true; });
fetch('http://${NEW_DOMAIN}/ads.js', {cache:'no-store'})
  .then(() => { window.__fresh = false; }).catch(() => { window.__fresh = true; });
</script>`);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
        });
    });
}

interface Probe { known: boolean | null; fresh: boolean | null }

async function main(): Promise<void> {
    const knownDomain = await pickBlockedDomain();
    await rm(STAGED, { recursive: true, force: true });
    await cp(BUILT, STAGED, { recursive: true });

    const { server, port } = await startServer(knownDomain);
    const profile = join(ROOT, 'dist', 'reload-profile');
    await rm(profile, { recursive: true, force: true });

    const executable = resolveChromium();
    if (executable.includes('headless_shell')) throw new Error('headless shell cannot load extensions');
    console.log(`Chromium: ${executable}`);
    console.log(`Baseline blocked domain: ${knownDomain}\n`);

    const context = await chromium.launchPersistentContext(profile, {
        executablePath: executable,
        headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        timeout: 120_000,
        args: [
            `--remote-debugging-port=${DEBUG_PORT}`,
            // Required for the Extensions CDP domain, which is how the
            // extension gets installed rather than merely loaded.
            '--enable-unsafe-extension-debugging',
            `--host-resolver-rules=MAP * 127.0.0.1:${port},EXCLUDE localhost`,
            '--no-first-run', '--no-sandbox', '--disable-gpu',
        ],
    });

    let failed = false;
    const check = (ok: boolean, label: string, detail = ''): void => {
        if (!ok) failed = true;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
    };

    const probe = async (): Promise<Probe> => {
        const page = await context.newPage();
        await page.goto(`http://reload-test.example:${port}/`, { waitUntil: 'load' });
        await page.waitForTimeout(400);
        const state = await page.evaluate(() => ({
            known: (window as unknown as { __known: boolean | null }).__known,
            fresh: (window as unknown as { __fresh: boolean | null }).__fresh,
        }));
        await page.close();
        return state;
    };

    /** Reloads until the page shows what we expect, or the budget runs out. */
    const waitFor = async (want: (p: Probe) => boolean, budgetMs = 30_000): Promise<Probe> => {
        const deadline = Date.now() + budgetMs;
        let state = await probe();
        while (!want(state) && Date.now() < deadline) state = await probe();
        return state;
    };

    try {
        const browser = context.browser();
        if (browser === null) throw new Error('no browser handle');
        const session = await (browser as unknown as {
            newBrowserCDPSession: () => Promise<{ send: (m: string, p: unknown) => Promise<unknown> }>;
        }).newBrowserCDPSession();
        const installed = await session.send('Extensions.loadUnpacked', { path: STAGED }) as { id?: string };
        check(typeof installed.id === 'string', 'the extension installs as unpacked', installed.id ?? '');

        console.log('\nBefore the update');
        const before = await waitFor((p) => p.known === true);
        check(before.known === true, 'a list domain is blocked', `__known=${before.known}`);
        check(before.fresh === false, 'the new domain is not blocked yet', `__fresh=${before.fresh}`);

        // Stand in for a list update: a rule that did not exist before.
        const rulesPath = join(STAGED, 'rules', 'ads.json');
        const rules = JSON.parse(await readFile(rulesPath, 'utf8')) as Array<{ id: number }>;
        const nextId = Math.max(...rules.map((r) => r.id)) + 1;
        rules.push({
            id: nextId,
            priority: 1000,
            action: { type: 'block' },
            condition: { requestDomains: [NEW_DOMAIN] },
        } as unknown as { id: number });
        await writeFile(rulesPath, JSON.stringify(rules), 'utf8');
        console.log(`\nRules on disk changed — added a block rule for ${NEW_DOMAIN}`);

        // Nothing should change until the extension is reloaded; that is the
        // whole reason the update script has this step at all.
        const stale = await probe();
        check(stale.fresh === false, 'the change does nothing until the reload',
            `__fresh=${stale.fresh}`);

        console.log('\nReload through the DevTools protocol');
        const outcome = await reloadExtension('AddBlocker', DEBUG_PORT);
        check(outcome.ok, 'update-filters finds and reloads the extension',
            outcome.ok ? outcome.extensionId : outcome.reason);

        await sleep(1_000);
        const after = await waitFor((p) => p.fresh === true);
        check(after.fresh === true, 'the rebuilt rules are in effect', `__fresh=${after.fresh}`);
        check(after.known === true, 'the rules that were already there still apply',
            `__known=${after.known}`);
    } finally {
        await context.close();
        server.close();
        await rm(profile, { recursive: true, force: true });
        await rm(STAGED, { recursive: true, force: true });
    }

    console.log(`\n${failed ? 'RELOAD CHECK FAILED' : 'RELOAD CHECK PASSED'}`);
    if (failed) process.exitCode = 1;
}

await main();
