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
 * `document-start` with `@grant none` when the page allows injection.
 *
 * Runs in Chromium by default. `USERSCRIPT_BROWSER=webkit` runs the same checks
 * in WebKit, the engine behind Safari on iOS and the one this script is
 * actually for: a selector WebKit refuses to parse silently disables every
 * other selector in its rule, and only WebKit can show that.
 */

import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type BrowserContext } from 'playwright-core';
import { preinstalledChromium } from '../../shared/chromium.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT = join(ROOT, 'dist', 'extension');
const USERSCRIPT = join(ROOT, 'userscript', 'addblocker.user.js');
const LIGHT = join(ROOT, 'userscript', 'addblocker-lite.user.js');

function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;
    const preinstalled = preinstalledChromium();
    if (preinstalled !== null) return preinstalled;
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
    const code = await readFile(join(BUILT, 'cosmetic', 'generic.js'), 'utf8');
    // Only the plain hide list: the file also carries gated selectors and the
    // per-site exception index, neither of which is "the sheet" — and probing
    // a gated selector's anchor would hide the rest of the test page.
    const payload = JSON.parse(/^const G = (.*);$/m.exec(code)?.[1] ?? '{}') as { hide?: string[] };
    const sheet = JSON.stringify(payload.hide ?? []);
    const ids = [...sheet.matchAll(/"#([A-Za-z][\w-]{2,40})"/g)].map((m) => m[1]);
    if (ids.length < 2) throw new Error('not enough plain id selectors in the generic sheet');
    const total = payload.hide?.length ?? ids.length;
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

/** A site exception to a plain generic selector, and a gated selector. */
async function pickGenericRuleCases(): Promise<{
    exception: { domain: string; selector: string } | null;
    gatedAnchor: string | null;
}> {
    const code = await readFile(join(BUILT, 'cosmetic', 'generic.js'), 'utf8');
    const payload = JSON.parse(/^const G = (.*);$/m.exec(code)?.[1] ?? '{}') as {
        gated?: Array<[string, string]>;
    };
    const exceptions = JSON.parse(/^const X = (.*);$/m.exec(code)?.[1] ?? '{}') as Record<string, string[]>;

    let exception: { domain: string; selector: string } | null = null;
    for (const [domain, selectors] of Object.entries(exceptions)) {
        const selector = selectors.find((sel) => /^[.#][A-Za-z][\w-]*$/.test(sel));
        if (selector !== undefined) { exception = { domain, selector }; break; }
    }
    const gated = (payload.gated ?? []).find(([anchor, selector]) =>
        /^#[A-Za-z][\w-]*$/.test(anchor) && selector === `${anchor} ~ *`);
    return { exception, gatedAnchor: gated === undefined ? null : gated[0] };
}

/** Names the script must never leave on the page's `window`. */
const PRIVATE_NAMES = [
    'SEL', 'STY', 'INV', 'ROW', 'DOM', 'GCSS', 'GS', 'GP', 'GG', 'GX', 'GXD',
    '__addblocker', '__addblockerScriptlets', '__abCosmetic', '__abScriptlets',
];

/**
 * Sends every hostname to the local server.
 *
 * Chromium can do this with a resolver flag; WebKit has no equivalent, so
 * there the requests are answered from here instead. The page still believes
 * it is on the hostname it asked for, which is all the userscript looks at.
 */
async function mapAllHosts(context: BrowserContext, port: number): Promise<void> {
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`);
        await route.fulfill({
            status: response.status,
            contentType: 'text/html',
            body: await response.text(),
        });
    });
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

    const rules = await pickGenericRuleCases();

    const useWebkit = process.env.USERSCRIPT_BROWSER === 'webkit';
    console.log(`Browser: ${useWebkit ? 'WebKit' : 'Chromium'}`);
    const browser = useWebkit
        ? await webkit.launch({ headless: true })
        : await chromium.launch({
            executablePath: resolveChromium(),
            headless: true,
            args: [
                `--host-resolver-rules=MAP * 127.0.0.1:${port},EXCLUDE localhost`,
                '--no-sandbox', '--disable-gpu',
            ],
        });
    const newContext = async (content: string): Promise<BrowserContext> => {
        const created = await browser.newContext();
        if (useWebkit) await mapAllHosts(created, port);
        await created.addInitScript({ content });
        return created;
    };
    /** Whether `selector` is on the page and takes up space. */
    const shown = async (context: BrowserContext, host: string, sel: string, probe: string): Promise<boolean> => {
        const page = await context.newPage();
        await page.goto(`http://${host}:${port}/?sel=${encodeURIComponent(sel)}`, { waitUntil: 'load' });
        const visible = await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            return el !== null && el.getBoundingClientRect().height > 0;
        }, probe);
        await page.close();
        return visible;
    };

    let failed = false;
    const check = (ok: boolean, label: string, detail = ''): void => {
        if (!ok) failed = true;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
    };

    try {
        console.log('\nHeader');
        for (const [name, text] of [['full', script], ['light', lightScript]] as const) {
            const version = /^\/\/ @version\s+(\S+)$/m.exec(text)?.[1] ?? '';
            check(/^\d{4}\.\d{3,4}\.\d{1,4}$/.test(version),
                `${name}: the version changes with each build`, `got "${version}"`);
            check(/^\/\/ @inject-into\s+auto$/m.test(text),
                `${name}: @inject-into auto, so a strict CSP does not stop the script`);
            check(!/^\/\/ @noframes/m.test(text), `${name}: no @noframes, so iframes are covered`);
        }

        const context = await newContext(script);

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

        console.log('\nGeneric rules');
        const lightRules = await newContext(lightScript);
        if (rules.exception === null) {
            console.log('  SKIP  no site exception to a plain generic selector in this build');
        } else {
            const { domain, selector } = rules.exception;
            check(await shown(context, domain, selector, selector),
                `${domain}#@#${selector} — left visible on that site`);
            check(!(await shown(context, 'no-rules-9f3a2b.test', selector, selector)),
                `${selector} is hidden everywhere else`);
            check(!(await shown(context, domain, selector, `#${generic.first}`)),
                `${domain} still gets the rest of the generic sheet`);
            check(await shown(lightRules, domain, selector, selector),
                `light build: ${domain}#@#${selector} — left visible on that site`);
        }
        if (rules.gatedAnchor === null) {
            console.log('  SKIP  no gated selector with an id anchor in this build');
        } else {
            // The page puts the probed element first and #sentinel after it, so
            // `#anchor ~ *` hides the sentinel exactly when the anchor exists.
            const anchor = rules.gatedAnchor;
            check(!(await shown(context, 'no-rules-9f3a2b.test', anchor, '#sentinel')),
                `${anchor} ~ * — applied once ${anchor} is on the page`);
            check(!(await shown(lightRules, 'no-rules-9f3a2b.test', anchor, '#sentinel')),
                `light build: ${anchor} ~ * — applied once ${anchor} is on the page`);
        }
        await lightRules.close();

        console.log('\nNothing left on the page');
        const leakPage = await context.newPage();
        await leakPage.goto(`http://${cases[0].domain}:${port}/?sel=.nothing`, { waitUntil: 'load' });
        const leaked = await leakPage.evaluate(
            (names) => names.filter((name) => name in window), PRIVATE_NAMES,
        );
        await leakPage.close();
        check(leaked.length === 0, 'the script defines no global the page can see',
            leaked.length === 0 ? '' : `found ${leaked.join(', ')}`);

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
        const lightContext = await newContext(lightScript);
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
