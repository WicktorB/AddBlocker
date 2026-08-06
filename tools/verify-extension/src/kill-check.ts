/**
 * Verifies the per-rule kill switch against a real browser.
 *
 * The claim being tested is narrow and behavioural: neutralising one rule lets
 * the request it was blocking through, without touching anything else, and
 * restoring it blocks again. Checking only that the setting was stored would
 * pass even if `updateStaticRules` were never called.
 */

import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT = join(ROOT, 'dist', 'extension');
const STAGED = join(ROOT, 'dist', 'kill-check-extension');

function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;
    const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (existsSync(preinstalled)) return preinstalled;
    const managed = chromium.executablePath();
    if (existsSync(managed)) return managed;
    throw new Error('no Chromium found');
}

interface Victim {
    ruleId: number;
    domain: string;
    /** A domain blocked by a *different* rule, to prove the kill is surgical. */
    bystander: string;
}

/**
 * Picks a rule to kill and an unrelated one to watch.
 *
 * They have to come from different rules: killing a rule that also covers the
 * bystander would look like a working kill switch while actually proving the
 * opposite of what is claimed.
 */
async function pickVictim(): Promise<Victim> {
    const rules = JSON.parse(await readFile(join(BUILT, 'rules', 'ads.json'), 'utf8')) as Array<{
        id: number;
        action: { type: string };
        condition: { requestDomains?: string[]; resourceTypes?: string[]; initiatorDomains?: string[] };
    }>;

    const plain = rules.filter((r) => r.action.type === 'block'
        && r.condition.requestDomains !== undefined
        && r.condition.requestDomains.length > 0
        && r.condition.resourceTypes === undefined
        && r.condition.initiatorDomains === undefined);

    const biggest = [...plain].sort(
        (a, b) => (b.condition.requestDomains?.length ?? 0) - (a.condition.requestDomains?.length ?? 0),
    )[0];
    const other = plain.find((r) => r.id !== biggest.id);
    if (biggest === undefined || other === undefined) throw new Error('not enough block rules');

    return {
        ruleId: biggest.id,
        domain: biggest.condition.requestDomains![0],
        bystander: other.condition.requestDomains![0],
    };
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

function startServer(victim: Victim): Promise<{ server: Server; port: number }> {
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
        res.end(`<!doctype html><meta charset="utf-8"><title>kill</title>
<script>
window.__victim = null; window.__bystander = null;
fetch('http://${victim.domain}/ads.js', {cache:'no-store'})
  .then(() => { window.__victim = false; }).catch(() => { window.__victim = true; });
fetch('http://${victim.bystander}/ads.js', {cache:'no-store'})
  .then(() => { window.__bystander = false; }).catch(() => { window.__bystander = true; });
</script>`);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
        });
    });
}

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

interface Probe { victim: boolean | null; bystander: boolean | null }

async function main(): Promise<void> {
    const victim = await pickVictim();
    const extensionId = await stageExtension();
    const { server, port } = await startServer(victim);
    const profile = join(ROOT, 'dist', 'kill-profile');
    await rm(profile, { recursive: true, force: true });

    const executable = resolveChromium();
    if (executable.includes('headless_shell')) throw new Error('headless shell cannot load extensions');
    console.log(`Chromium: ${executable}`);
    console.log(`Rule under test: ads #${victim.ruleId} blocking ${victim.domain}`);
    console.log(`Bystander (a different rule): ${victim.bystander}\n`);

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

    const probe = async (): Promise<Probe> => {
        const page = await context.newPage();
        await page.goto(`http://kill-test.example:${port}/`, { waitUntil: 'load' });
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => ({
            victim: (window as unknown as { __victim: boolean | null }).__victim,
            bystander: (window as unknown as { __bystander: boolean | null }).__bystander,
        }));
        await page.close();
        return state;
    };

    const waitFor = async (want: (p: Probe) => boolean, budgetMs = 20_000): Promise<Probe> => {
        const deadline = Date.now() + budgetMs;
        let state = await probe();
        while (!want(state) && Date.now() < deadline) state = await probe();
        return state;
    };

    try {
        console.log('Before');
        const before = await waitFor((p) => p.victim === true && p.bystander === true);
        check(before.victim === true, 'the rule blocks its domain', `__victim=${before.victim}`);
        check(before.bystander === true, 'the bystander is blocked too',
            `__bystander=${before.bystander}`);

        // The popup offers the user a list of what fired on the tab. If that
        // list is empty or missing the rule, the kill switch is unreachable
        // however well the underlying call works.
        const tab = await context.newPage();
        await tab.goto(`http://kill-test.example:${port}/`, { waitUntil: 'load' });
        await tab.waitForTimeout(500);

        const reporter = await context.newPage();
        await reporter.goto(`chrome-extension://${extensionId}/options.html`, { timeout: 60_000 });
        const listed = await reporter.evaluate(async () => {
            const api = (globalThis as unknown as { chrome: typeof chrome }).chrome;
            const tabs = await api.tabs.query({ url: 'http://kill-test.example/*' });
            const id = tabs[0]?.id;
            if (id === undefined) return null;
            return api.runtime.sendMessage({ type: 'getMatchedRules', payload: { tabId: id } });
        }) as { rules?: Array<{ rulesetId: string; ruleId: number; sampleUrl: string }> } | null;
        await reporter.close();
        await tab.close();

        check(listed !== null && (listed.rules?.length ?? 0) > 0,
            'the popup can list the rules that fired', `${listed?.rules?.length ?? 0} rule(s)`);
        check(listed?.rules?.some((r) => r.rulesetId === 'ads' && r.ruleId === victim.ruleId) === true,
            'the rule under test is among them');

        console.log('\nNeutralising one rule');
        const killed = await send(context, extensionId, {
            type: 'killRule', payload: { rulesetId: 'ads', ruleId: victim.ruleId },
        }) as { ok?: boolean; killedRules?: unknown[] };
        check(killed?.ok === true, 'killRule is accepted');
        check((killed?.killedRules?.length ?? 0) === 1, 'the kill is recorded');

        const after = await waitFor((p) => p.victim === false);
        check(after.victim === false, 'the neutralised rule no longer blocks',
            `__victim=${after.victim}`);
        check(after.bystander === true, 'every other rule keeps working',
            `__bystander=${after.bystander}`);

        console.log('\nRestoring it');
        const restored = await send(context, extensionId, {
            type: 'restoreRule', payload: { rulesetId: 'ads', ruleId: victim.ruleId },
        }) as { ok?: boolean; killedRules?: unknown[] };
        check(restored?.ok === true, 'restoreRule is accepted');
        check((restored?.killedRules?.length ?? 0) === 0, 'the kill list is empty again');

        const back = await waitFor((p) => p.victim === true);
        check(back.victim === true, 'the rule blocks again once restored',
            `__victim=${back.victim}`);
    } finally {
        await context.close();
        server.close();
        await rm(profile, { recursive: true, force: true });
        await rm(STAGED, { recursive: true, force: true });
    }

    console.log(`\n${failed ? 'KILL CHECK FAILED' : 'KILL CHECK PASSED'}`);
    if (failed) process.exitCode = 1;
}

await main();
