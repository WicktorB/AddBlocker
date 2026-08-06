/**
 * Verifies scriptlets in a real Chromium.
 *
 * A scriptlet only works if two things hold, and neither can be checked
 * statically:
 *   1. It runs in the page's own world — hooking `window.open` from the
 *      isolated world would change nothing the page can see.
 *   2. It runs *before* the page's scripts. A hook installed afterwards is
 *      useless: the page has already read the property.
 *
 * Each case below is served from a domain the build actually targets, and the
 * page's own inline script records what it observed.
 */

import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT = join(ROOT, 'dist', 'extension');
const STAGED = join(ROOT, 'dist', 'scriptlet-check-extension');

function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;
    const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (existsSync(preinstalled)) return preinstalled;
    const managed = chromium.executablePath();
    if (existsSync(managed)) return managed;
    throw new Error('no Chromium found');
}

interface Case {
    scriptlet: string;
    domain: string;
    /** Inline script the page runs; must set window.__result. */
    probe: string;
    /** What __result must equal for the scriptlet to have worked. */
    expected: string;
}

type Invocation = [string, ...string[]];

/** Finds a domain whose bucket invokes `name`, plus that invocation's args. */
async function findInvocation(name: string): Promise<{ domain: string; args: string[] } | null> {
    const files = (await readdir(join(BUILT, 'scriptlets')))
        .filter((f) => f.startsWith('scriptlets-'))
        .sort();

    for (const file of files) {
        const code = await readFile(join(BUILT, 'scriptlets', file), 'utf8');
        const match = /^const I = (\{.*\});$/m.exec(code);
        if (match === null) continue;
        const buckets = JSON.parse(match[1]) as Record<string, Invocation[]>;

        for (const [domain, invocations] of Object.entries(buckets)) {
            for (const invocation of invocations) {
                const [invoked, ...args] = invocation;
                // Keep the case readable: skip exotic arguments.
                if (invoked === name && args.every((a) => a.length < 40)) {
                    return { domain, args };
                }
            }
        }
    }
    return null;
}

async function buildCases(): Promise<Case[]> {
    const cases: Case[] = [];

    // abort-on-property-read: reading the property must throw.
    const aopr = await findInvocation('aopr');
    if (aopr !== null && aopr.args[0] !== undefined && /^[\w.]+$/.test(aopr.args[0])) {
        const path = aopr.args[0];
        cases.push({
            scriptlet: `aopr(${path})`,
            domain: aopr.domain,
            expected: 'threw',
            probe: `try { void window.${path}; window.__result = 'read-ok'; }
                    catch (e) { window.__result = 'threw'; }`,
        });
    }

    // set-constant: the page must observe the forced value.
    const set = await findInvocation('set');
    if (set !== null && set.args[0] !== undefined && /^[\w.]+$/.test(set.args[0])) {
        const [path, value] = set.args;
        cases.push({
            scriptlet: `set(${path}, ${value})`,
            domain: set.domain,
            expected: String(value),
            probe: `window.__result = String(window.${path});`,
        });
    }

    // no-setTimeout-if: the matching callback must never run.
    const nostif = await findInvocation('nostif');
    if (nostif !== null && nostif.args[0] !== undefined && /^[\w]+$/.test(nostif.args[0])) {
        const needle = nostif.args[0];
        cases.push({
            scriptlet: `nostif(${needle})`,
            domain: nostif.domain,
            expected: 'suppressed',
            probe: `window.__result = 'suppressed';
                    setTimeout(function ${needle}() { window.__result = 'ran'; }, 1);`,
        });
    }

    // set-cookie: the cookie must be present when the page looks.
    const cookie = await findInvocation('trusted-set-cookie');
    if (cookie !== null && cookie.args[0] !== undefined && /^[\w-]+$/.test(cookie.args[0])) {
        const name = cookie.args[0];
        cases.push({
            scriptlet: `trusted-set-cookie(${name})`,
            domain: cookie.domain,
            expected: 'present',
            probe: `window.__result = document.cookie.includes('${name}') ? 'present' : 'absent';`,
        });
    }

    // nowebrtc: constructing a peer connection must throw.
    const webrtc = await findInvocation('nowebrtc');
    if (webrtc !== null) {
        cases.push({
            scriptlet: 'nowebrtc()',
            domain: webrtc.domain,
            expected: 'threw',
            probe: `try { new RTCPeerConnection(); window.__result = 'constructed'; }
                    catch (e) { window.__result = 'threw'; }`,
        });
    }

    return cases;
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
    await writeFile(join(STAGED, 'probe.html'),
        '<!doctype html><meta charset="utf-8"><title>probe</title>', 'utf8');

    return [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');
}

function startServer(cases: Case[]): Promise<{ server: Server; port: number }> {
    const byDomain = new Map(cases.map((c) => [c.domain, c]));

    const server = createServer((req, res) => {
        const host = (req.headers.host ?? '').split(':')[0];
        const testCase = byDomain.get(host);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><title>scriptlet</title>
<script>
window.__result = 'not-run';
${testCase?.probe ?? ''}
</script>`);
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
        });
    });
}

async function main(): Promise<void> {
    const cases = await buildCases();
    if (cases.length === 0) throw new Error('no scriptlet cases could be drawn from the build');

    const extensionId = await stageExtension();
    const { server, port } = await startServer(cases);
    const profile = join(ROOT, 'dist', 'scriptlet-profile');
    await rm(profile, { recursive: true, force: true });

    const executable = resolveChromium();
    if (executable.includes('headless_shell')) throw new Error('headless shell cannot load extensions');
    console.log(`Chromium: ${executable}\n`);

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
    try {
        const check = await context.newPage();
        await check.goto(`chrome-extension://${extensionId}/probe.html`, { timeout: 60_000 });
        const registered = await check.evaluate(async () => {
            const scripting = (globalThis as unknown as { chrome: typeof chrome }).chrome.scripting;
            for (let attempt = 0; attempt < 60; attempt += 1) {
                const scripts = await scripting.getRegisteredContentScripts();
                const main = scripts.filter((s) => (s as { world?: string }).world === 'MAIN');
                if (main.length > 0) return { total: scripts.length, main: main.length };
                await new Promise((r) => { setTimeout(r, 500); });
            }
            return { total: 0, main: 0 };
        });
        await check.close();

        if (registered.main === 0) {
            console.log('FAIL  no scriptlet bucket registered in the MAIN world');
            failed = true;
        } else {
            console.log(`PASS  ${registered.main} scriptlet buckets registered in the MAIN world ` +
                `(${registered.total} scripts total)\n`);
        }

        console.log('Behaviour');
        for (const testCase of cases) {
            const page = await context.newPage();
            await page.goto(`http://${testCase.domain}:${port}/`, { waitUntil: 'load' });
            await page.waitForTimeout(200);
            const result = await page.evaluate(() => (window as unknown as { __result: string }).__result);

            const ok = result === testCase.expected;
            if (!ok) failed = true;
            console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${testCase.scriptlet} on ${testCase.domain} ` +
                `— got ${JSON.stringify(result)}${ok ? '' : `, expected ${JSON.stringify(testCase.expected)}`}`);
            await page.close();
        }
    } finally {
        await context.close();
        server.close();
        await rm(profile, { recursive: true, force: true });
        await rm(STAGED, { recursive: true, force: true });
    }

    console.log(`\n${failed ? 'SCRIPTLET CHECK FAILED' : 'SCRIPTLET CHECK PASSED'}`);
    if (failed) process.exitCode = 1;
}

await main();
