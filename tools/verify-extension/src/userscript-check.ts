/**
 * Verifies the generated userscript in a real browser.
 *
 * The userscript is what runs on a phone, where the extension cannot. It is a
 * single two-megabyte file injected into every page, so shipping it untested
 * would be careless: a single mistake in the compact encoding would silently
 * hide nothing at all, and nothing would say so.
 *
 * Injection uses `addInitScript`, which runs before the page's own scripts in
 * the page's world — the same position a userscript manager gives it at
 * `document-start` with `@grant none` / `@inject-into page`.
 */

import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT = join(ROOT, 'dist', 'extension');
const USERSCRIPT = join(ROOT, 'userscript', 'addblocker.user.js');
const LIGHT = join(ROOT, 'userscript', 'addblocker-lite.user.js');

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
    domain: string;
    selector: string;
    kind: 'plain' | 'procedural';
}

/** Real cases, taken from the compiled buckets rather than invented. */
async function pickCosmeticCases(limit: number): Promise<Case[]> {
    const cases: Case[] = [];
    const files = (await readdir(join(BUILT, 'cosmetic')))
        .filter((f) => f.startsWith('bucket-')).sort();

    for (const file of files) {
        const code = await readFile(join(BUILT, 'cosmetic', file), 'utf8');
        const match = /^const P = (.*);$/m.exec(code);
        if (match === null) continue;
        const payloads = JSON.parse(match[1]) as Record<string, {
            hide?: string[]; procedural?: string[];
        }>;
        for (const [domain, payload] of Object.entries(payloads)) {
            // Only selectors a plain element can satisfy, so a failure means
            // the userscript did not apply — not that the case was unfair.
            const plain = (payload.hide ?? []).find((s) => /^[.#][\w-]+$/.test(s));
            if (plain !== undefined) cases.push({ domain, selector: plain, kind: 'plain' });
            if (cases.length >= limit) return cases;
        }
    }
    return cases;
}

/**
 * Two generic id selectors: the first in the sheet and the last.
 *
 * The last one is the point. Blink stops matching a selector list past 8192
 * entries without a word, and the generic sheet holds far more than that — so a
 * check that only ever probed the first selector passed while thousands of
 * others silently did nothing.
 */
async function pickGenericIds(): Promise<{ first: string; last: string; total: number }> {
    const sheet = await readFile(join(BUILT, 'cosmetic', 'generic.js'), 'utf8');
    const ids = [...sheet.matchAll(/"#([A-Za-z][\w-]{2,40})"/g)].map((m) => m[1]);
    if (ids.length < 2) throw new Error('not enough plain id selectors in the generic sheet');
    const hides = /"hide":\[(.*?)\],"style"/s.exec(sheet);
    const total = hides === null ? ids.length : hides[1].split('","').length;
    return { first: ids[0], last: ids[ids.length - 1], total };
}

/** A scriptlet case: a domain where `set-constant` fires, and its target. */
async function pickScriptletCase(): Promise<{ domain: string; property: string; value: string }> {
    const files = (await readdir(join(BUILT, 'scriptlets')))
        .filter((f) => f.endsWith('.js') && f !== 'runtime.js').sort();

    for (const file of files) {
        const code = await readFile(join(BUILT, 'scriptlets', file), 'utf8');
        const match = /^const I = (.*);$/m.exec(code);
        if (match === null) continue;
        const table = JSON.parse(match[1]) as Record<string, Array<[string, ...string[]]>>;
        for (const [domain, calls] of Object.entries(table)) {
            for (const call of calls) {
                const [name, property, value] = call;
                if ((name === 'set' || name === 'set-constant')
                    && property !== undefined && value !== undefined
                    && /^[A-Za-z_$][\w$]*$/.test(property)
                    && (value === 'true' || value === 'false')) {
                    return { domain, property, value };
                }
            }
        }
    }
    throw new Error('no usable set-constant invocation found');
}

function startServer(genericFirst: string, genericLast: string): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
        const selector = new URL(req.url ?? '/', 'http://x').searchParams.get('sel') ?? '.none';
        const isClass = selector.startsWith('.');
        const attribute = isClass ? `class="${selector.slice(1)}"` : `id="${selector.slice(1)}"`;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><title>us</title>
<div ${attribute}>should be hidden</div>
<div id="${genericFirst}">hidden by the generic sheet (first)</div>
<div id="${genericLast}">hidden by the generic sheet (last)</div>
<div id="sentinel">stays visible</div>
<script>window.__probe = { check: typeof window.__checkTarget };</script>`);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
        });
    });
}

async function main(): Promise<void> {
    if (!existsSync(USERSCRIPT)) {
        throw new Error(`${USERSCRIPT} is missing — run pnpm build-userscript first`);
    }
    const script = await readFile(USERSCRIPT, 'utf8');
    const lightScript = await readFile(LIGHT, 'utf8');
    console.log(`Userscript: ${(script.length / 1024).toFixed(0)} kB `
        + `(light: ${(lightScript.length / 1024).toFixed(0)} kB)`);

    const generic = await pickGenericIds();
    console.log(`Generic sheet: ${generic.total} hide selectors `
        + `(probing #${generic.first} and #${generic.last})`);
    const cases = await pickCosmeticCases(6);
    const scriptletCase = await pickScriptletCase();
    const { server, port } = await startServer(generic.first, generic.last);

    const browser = await chromium.launch({
        executablePath: resolveChromium(),
        headless: true,
        args: [
            `--host-resolver-rules=MAP * 127.0.0.1:${port},EXCLUDE localhost`,
            '--no-sandbox', '--disable-gpu',
        ],
    });

    let failed = false;
    const check = (ok: boolean, label: string, detail = ''): void => {
        if (!ok) failed = true;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
    };

    try {
        const context = await browser.newContext();
        await context.addInitScript({ content: script });

        console.log('\nPer-site hiding');
        for (const testCase of cases) {
            const page = await context.newPage();
            await page.goto(
                `http://${testCase.domain}:${port}/?sel=${encodeURIComponent(testCase.selector)}`,
                { waitUntil: 'load' },
            );
            const state = await page.evaluate((selector) => {
                const target = document.querySelector(selector);
                const sentinel = document.getElementById('sentinel');
                return {
                    hidden: target === null || target.getBoundingClientRect().height === 0,
                    sentinelVisible: sentinel !== null && sentinel.getBoundingClientRect().height > 0,
                };
            }, testCase.selector);
            await page.close();
            check(state.hidden && state.sentinelVisible,
                `${testCase.domain} — ${testCase.selector}`,
                state.sentinelVisible ? '' : 'the control element vanished too');
        }

        console.log('\nGeneric hiding, on a domain with no rules of its own');
        const genericPage = await context.newPage();
        await genericPage.goto(`http://no-rules-9f3a2b.test:${port}/?sel=.nothing`, { waitUntil: 'load' });
        // No named functions in here: tsx names them and emits an esbuild
        // shim the page does not have.
        const genericState = await genericPage.evaluate((ids) => {
            const one = document.getElementById(ids[0]);
            const two = document.getElementById(ids[1]);
            const sentinel = document.getElementById('sentinel');
            return {
                first: one === null || one.getBoundingClientRect().height === 0,
                last: two === null || two.getBoundingClientRect().height === 0,
                sentinelVisible: sentinel !== null && sentinel.getBoundingClientRect().height > 0,
            };
        }, [generic.first, generic.last]);
        await genericPage.close();
        check(genericState.first, `#${generic.first} is hidden (first of the sheet)`);
        check(genericState.last, `#${generic.last} is hidden (last of the sheet)`);
        check(genericState.sentinelVisible, 'other content is untouched');

        console.log('\nScriptlets, in the page\'s own world');
        const scriptletPage = await context.newPage();
        await scriptletPage.goto(`http://${scriptletCase.domain}:${port}/?sel=.nothing`,
            { waitUntil: 'load' });
        const observed = await scriptletPage.evaluate(
            (property) => String((window as unknown as Record<string, unknown>)[property]),
            scriptletCase.property,
        );
        await scriptletPage.close();
        check(observed === scriptletCase.value,
            `set(${scriptletCase.property}, ${scriptletCase.value}) on ${scriptletCase.domain}`,
            `got "${observed}"`);

        console.log('\nThe light build');
        const lightContext = await browser.newContext();
        await lightContext.addInitScript({ content: lightScript });
        const lightPage = await lightContext.newPage();
        await lightPage.goto(`http://no-rules-9f3a2b.test:${port}/?sel=.nothing`, { waitUntil: 'load' });
        const lightState = await lightPage.evaluate((ids) => {
            const one = document.getElementById(ids[0]);
            const two = document.getElementById(ids[1]);
            const sentinel = document.getElementById('sentinel');
            return {
                hidden: (one === null || one.getBoundingClientRect().height === 0)
                    && (two === null || two.getBoundingClientRect().height === 0),
                sentinelVisible: sentinel !== null && sentinel.getBoundingClientRect().height > 0,
            };
        }, [generic.first, generic.last]);
        await lightPage.close();
        await lightContext.close();
        check(lightState.hidden && lightState.sentinelVisible,
            'the light build still hides generic selectors');
    } finally {
        await browser.close();
        server.close();
    }

    console.log(`\n${failed ? 'USERSCRIPT CHECK FAILED' : 'USERSCRIPT CHECK PASSED'}`);
    if (failed) process.exitCode = 1;
}

await main();
