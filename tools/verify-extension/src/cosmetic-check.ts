/**
 * Verifies cosmetic filtering in a real Chromium.
 *
 * Three things matter and none can be checked statically:
 *   1. Chrome accepts a manifest with tens of thousands of match patterns.
 *   2. Selectors actually hide their targets — including procedural ones.
 *   3. Nothing flashes: the element must never be visible, not merely hidden
 *      shortly after load.
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
const STAGED = join(ROOT, 'dist', 'cosmetic-check-extension');

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
    /** Domain to serve the page from; picked from the compiled buckets. */
    domain: string;
    /** Selector expected to be hidden. */
    selector: string;
    /** Markup exercising that selector. */
    html: string;
    kind: 'plain' | 'procedural';
}

/**
 * Draws real test cases from the built buckets.
 *
 * Hand-written cases would only prove the runtime works on selectors we
 * invented; these prove it works on what the lists actually ship.
 */
async function collectCases(): Promise<Case[]> {
    const cases: Case[] = [];
    const files = (await readdir(join(BUILT, 'cosmetic')))
        .filter((f) => f.startsWith('bucket-'))
        .sort();

    for (const file of files.slice(0, 12)) {
        const code = await readFile(join(BUILT, 'cosmetic', file), 'utf8');
        const match = /^const P = (\{.*\});$/m.exec(code);
        if (match === null) continue;
        const payloads = JSON.parse(match[1]) as Record<string, {
            hide: string[]; procedural: string[];
        }>;

        for (const [domain, payload] of Object.entries(payloads)) {
            // Simple class/id selectors are the ones we can synthesise markup for.
            const plain = payload.hide.find((s) => /^[.#][A-Za-z][\w-]*$/.test(s));
            if (plain !== undefined && cases.filter((c) => c.kind === 'plain').length < 6) {
                const attr = plain.startsWith('.') ? `class="${plain.slice(1)}"` : `id="${plain.slice(1)}"`;
                cases.push({
                    domain,
                    selector: plain,
                    kind: 'plain',
                    html: `<div ${attr}>ad content</div>`,
                });
            }

            const hasText = payload.procedural.find((s) => /^[\w.#-]+:has-text\([^)]+\)$/.test(s));
            if (hasText !== undefined && cases.filter((c) => c.kind === 'procedural').length < 3) {
                const [, prefix, text] = /^([\w.#-]+):has-text\(([^)]+)\)$/.exec(hasText) ?? [];
                if (prefix !== undefined) {
                    const tag = prefix.startsWith('.') ? `<div class="${prefix.slice(1)}">`
                        : prefix.startsWith('#') ? `<div id="${prefix.slice(1)}">`
                            : `<${prefix}>`;
                    const close = prefix.startsWith('.') || prefix.startsWith('#') ? '</div>' : `</${prefix}>`;
                    cases.push({
                        domain,
                        selector: hasText,
                        kind: 'procedural',
                        html: `${tag}${text}${close}`,
                    });
                }
            }
        }
        if (cases.length >= 9) break;
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
    const byDomain = new Map<string, Case[]>();
    for (const testCase of cases) {
        byDomain.set(testCase.domain, [...(byDomain.get(testCase.domain) ?? []), testCase]);
    }

    const server = createServer((req, res) => {
        const host = (req.headers.host ?? '').split(':')[0];
        const forHost = byDomain.get(host) ?? [];
        const body = forHost.map((c, i) => `<div id="probe-${i}">${c.html}</div>`).join('\n');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><title>cosmetic</title>
<style>body{margin:0}</style>
${body}
<div id="sentinel">visible</div>`);
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
        });
    });
}

async function main(): Promise<void> {
    const cases = await collectCases();
    if (cases.length === 0) throw new Error('no cosmetic test cases could be drawn from the build');

    const extensionId = await stageExtension();
    const { server, port } = await startServer(cases);
    const profile = join(ROOT, 'dist', 'cosmetic-profile');
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
        // If the manifest were rejected, no extension page would load at all.
        const check = await context.newPage();
        await check.goto(`chrome-extension://${extensionId}/probe.html`, { timeout: 60_000 });

        // Bucket scripts are registered by the service worker, not declared in
        // the manifest (docs/adr/0002). Wait for that to land before probing,
        // or the first pages would legitimately show nothing hidden.
        const registered = await check.evaluate(async () => {
            const scripting = (globalThis as unknown as { chrome: typeof chrome }).chrome.scripting;
            for (let attempt = 0; attempt < 60; attempt += 1) {
                const scripts = await scripting.getRegisteredContentScripts();
                if (scripts.length > 0) {
                    return {
                        count: scripts.length,
                        patterns: scripts.reduce((n, s) => n + (s.matches?.length ?? 0), 0),
                    };
                }
                await new Promise((r) => { setTimeout(r, 500); });
            }
            return { count: 0, patterns: 0 };
        });
        await check.close();

        if (registered.count === 0) {
            console.log('FAIL  the service worker registered no cosmetic content scripts');
            failed = true;
        } else {
            console.log(`PASS  ${registered.count} bucket scripts registered ` +
                `(${registered.patterns} match patterns)\n`);
        }

        console.log('Hiding');
        for (const testCase of cases) {
            const page = await context.newPage();

            // Watch from the very first paint: catching "hidden by now" would
            // miss exactly the flash we are trying to rule out.
            await page.addInitScript(`
                window.__everVisible = false;
                const check = () => {
                    const el = document.querySelector(${JSON.stringify(testCase.selector.split(':')[0])});
                    if (el && el.getBoundingClientRect().height > 0) window.__everVisible = true;
                };
                const t = setInterval(check, 4);
                setTimeout(() => clearInterval(t), 3000);
            `);

            await page.goto(`http://${testCase.domain}:${port}/`, { waitUntil: 'load' });
            await page.waitForTimeout(400);

            const result = await page.evaluate((selector: string) => {
                const probe = document.querySelector(selector.split(':')[0]);
                const sentinel = document.querySelector('#sentinel');
                return {
                    hidden: probe === null || probe.getBoundingClientRect().height === 0,
                    sentinelVisible: sentinel !== null && sentinel.getBoundingClientRect().height > 0,
                    everVisible: (window as unknown as { __everVisible: boolean }).__everVisible,
                };
            }, testCase.selector);

            const ok = result.hidden && result.sentinelVisible && !result.everVisible;
            if (!ok) failed = true;
            console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${testCase.kind}] ${testCase.domain} — ${testCase.selector}` +
                `${result.hidden ? '' : ' NOT HIDDEN'}${result.everVisible ? ' FLASHED' : ''}` +
                `${result.sentinelVisible ? '' : ' SENTINEL HIDDEN (over-hiding)'}`);

            await page.close();
        }

        // Cost of the generic sheet, which lands on every page.
        const perf = await context.newPage();
        await perf.goto(`http://cost-probe.test:${port}/`, { waitUntil: 'load' });
        const timing = await perf.evaluate(() => {
            const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
            return Math.round(nav.domContentLoadedEventEnd - nav.responseEnd);
        });
        console.log(`\nGeneric sheet cost: ${timing}ms from response to DOMContentLoaded`);
        await perf.close();
    } finally {
        await context.close();
        server.close();
        await rm(profile, { recursive: true, force: true });
        await rm(STAGED, { recursive: true, force: true });
    }

    console.log(`\n${failed ? 'COSMETIC CHECK FAILED' : 'COSMETIC CHECK PASSED'}`);
    if (failed) process.exitCode = 1;
}

await main();
