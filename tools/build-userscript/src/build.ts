/**
 * Builds a single self-contained userscript from the same filter lists.
 *
 * This exists because Safari on iOS and any browser driven by a userscript
 * manager cannot run the extension. What it can run is a script, and a script
 * can do two of the three jobs: hide elements (cosmetic filtering) and defuse
 * anti-adblock (scriptlets). It cannot block a single network request —
 * neither Tampermonkey nor Userscripts exposes anything like
 * `declarativeNetRequest`, so the bytes still arrive and only the result is
 * hidden. That limit is stated in the script's own header rather than left for
 * the user to discover.
 *
 * Size is the whole design problem: the payload is injected into every page, so
 * the extension's 7 MB of generated scripts would be absurd. Two things make it
 * tractable — selectors and invocations repeat enormously across domains
 * (4.9× and 14.5× respectively), so they are pooled and referenced by index;
 * and the index is base 36 rather than decimal.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

import { parseCosmeticList } from '@addblocker/filter-parser';
import { compileCosmetic, type DomainPayload } from '@addblocker/cosmetic-compiler';
import {
    compileScriptlets, parseScriptletList, type Invocation,
} from '@addblocker/scriptlet-compiler';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CACHE_DIR = join(ROOT, '.filter-cache');
// Not under dist/: these are the deliverable, meant to be downloaded from the
// repository, so they are versioned rather than treated as build scratch.
const OUT_DIR = join(ROOT, 'userscript');
const COSMETIC_RUNTIME = join(ROOT, 'packages', 'cosmetic-runtime', 'src', 'apply.ts');
const SCRIPTLET_RUNTIME = join(ROOT, 'packages', 'scriptlet-runtime', 'src', 'run.ts');

const VERSION = '1.0.0';
// Points at main, not at a feature branch: this URL is baked into every
// installed copy as @updateURL, and a branch deleted after merging would make
// updates stop without a word — the worst way to fail, since the user would go
// on believing their lists are current.
const REPO = 'https://raw.githubusercontent.com/WicktorB/AddBlocker'
    + '/main/userscript';

/** Separates the parts of a pooled entry; never appears in a selector. */
const UNIT = '';

/** Interns strings and hands back a base-36 index. */
class Pool {
    private readonly index = new Map<string, number>();
    readonly items: string[] = [];

    ref(value: string): string {
        let found = this.index.get(value);
        if (found === undefined) {
            found = this.items.length;
            this.items.push(value);
            this.index.set(value, found);
        }
        return found.toString(36);
    }

    get bytes(): number {
        return JSON.stringify(this.items).length;
    }
}

async function readLists(): Promise<string[]> {
    const files = (await readdir(CACHE_DIR)).filter((f) => f.endsWith('.txt')).sort();
    if (files.length === 0) throw new Error(`no lists in ${CACHE_DIR} — run pnpm build first`);
    return Promise.all(files.map((f) => readFile(join(CACHE_DIR, f), 'utf8')));
}

/** Bundles a runtime the way the extension does, so behaviour is identical. */
async function bundle(entry: string): Promise<string> {
    const result = await esbuild({
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        target: 'safari15',
        minify: true,
        write: false,
    });
    return result.outputFiles[0].text;
}

interface Row {
    hide: string[];
    procedural: string[];
    exceptions: string[];
    style: string[];
    scriptlets: string[];
}

function emptyRow(): Row {
    return { hide: [], procedural: [], exceptions: [], style: [], scriptlets: [] };
}

function encodeRow(row: Row): string {
    // Five comma-separated fields. Trailing empties are trimmed, which matters:
    // most domains carry only one kind of rule.
    const fields = [
        row.hide.join(','), row.procedural.join(','), row.exceptions.join(','),
        row.style.join(','), row.scriptlets.join(','),
    ];
    while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
    return fields.join(';');
}

function header(title: string, description: string, file: string): string {
    return `// ==UserScript==
// @name         ${title}
// @namespace    https://github.com/WicktorB/AddBlocker
// @version      ${VERSION}
// @description  ${description}
// @author       AddBlocker
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes     false
// @downloadURL  ${REPO}/${file}
// @updateURL    ${REPO}/${file}
// ==/UserScript==

/*
 * Ce script masque les publicités et neutralise les murs anti-adblock.
 *
 * Ce qu'il NE FAIT PAS : bloquer les requêtes réseau. Aucun gestionnaire de
 * userscripts n'en est capable — les publicités sont donc téléchargées puis
 * masquées. La page n'est pas allégée, seulement nettoyée. Pour un vrai blocage
 * réseau il faut l'extension (Chrome de bureau) ou un bloqueur de contenu natif
 * (Safari iOS).
 *
 * Engendré depuis EasyList, EasyPrivacy et uAssets.
 */
`;
}

async function main(): Promise<void> {
    console.log('Reading the filter lists…');
    const raws = await readLists();

    const cosmetic = compileCosmetic(raws.flatMap((r) => parseCosmeticList(r)));
    const scriptlets = compileScriptlets(raws.flatMap((r) => parseScriptletList(r)));
    console.log(`  ${cosmetic.stats.domains} cosmetic domains, `
        + `${scriptlets.stats.domains} scriptlet domains\n`);

    const selectors = new Pool();
    const styles = new Pool();
    const invocations = new Pool();
    const rows = new Map<string, Row>();

    const rowFor = (domain: string): Row => {
        let row = rows.get(domain);
        if (row === undefined) {
            row = emptyRow();
            rows.set(domain, row);
        }
        return row;
    };

    for (const bucket of cosmetic.buckets) {
        for (const [domain, payload] of Object.entries(bucket.payloads)) {
            const row = rowFor(domain);
            for (const s of payload.hide) row.hide.push(selectors.ref(s));
            for (const s of payload.procedural) row.procedural.push(selectors.ref(s));
            for (const s of payload.exceptions) row.exceptions.push(selectors.ref(s));
            for (const [sel, css] of payload.style) row.style.push(styles.ref(`${sel}${UNIT}${css}`));
        }
    }

    for (const bucket of scriptlets.buckets) {
        for (const [domain, list] of Object.entries(bucket.invocations)) {
            const row = rowFor(domain);
            for (const call of list as Invocation[]) {
                row.scriptlets.push(invocations.ref(call.join(UNIT)));
            }
        }
    }

    const generic: DomainPayload = cosmetic.generic;
    const genericHide = generic.hide.map((s) => selectors.ref(s)).join(',');
    const genericProcedural = generic.procedural.map((s) => selectors.ref(s)).join(',');

    // Lists are written as `a.com,b.com,c.com##.ad`, so a great many domains
    // end up with byte-identical rows. Interning them turns the table's values
    // into a short index each.
    const rowPool = new Pool();
    const table: Record<string, string> = {};
    for (const [domain, row] of rows) {
        const encoded = encodeRow(row);
        if (encoded !== '') table[domain] = rowPool.ref(encoded);
    }

    const cosmeticRuntime = await bundle(COSMETIC_RUNTIME);
    const scriptletRuntime = await bundle(SCRIPTLET_RUNTIME);

    /**
     * The dispatcher, written as plain source rather than bundled: it is short,
     * and it has to stay readable for anyone who opens the file to see what is
     * running on every page they visit.
     */
    const dispatcher = (withDomains: boolean): string => `
(function () {
  var U = ${JSON.stringify(UNIT)};
  var d = function (s) {
    if (!s) return [];
    var out = [], parts = s.split(',');
    for (var i = 0; i < parts.length; i++) out.push(parseInt(parts[i], 36));
    return out;
  };
  var pick = function (refs, pool) {
    var out = [];
    for (var i = 0; i < refs.length; i++) out.push(pool[refs[i]]);
    return out;
  };

  var merged = { hide: [], style: [], procedural: [], exceptions: [] };
  var calls = [];

  merged.hide = pick(d(GH), SEL);
  merged.procedural = pick(d(GP), SEL);
${withDomains ? `
  // Walk up the hostname: a rule on example.com covers www.example.com too.
  var host = location.hostname;
  while (host.indexOf('.') !== -1) {
    var ref = DOM[host];
    if (ref !== undefined) {
      var f = ROW[parseInt(ref, 36)].split(';');
      merged.hide = merged.hide.concat(pick(d(f[0]), SEL));
      merged.procedural = merged.procedural.concat(pick(d(f[1]), SEL));
      merged.exceptions = merged.exceptions.concat(pick(d(f[2]), SEL));
      var st = d(f[3]);
      for (var i = 0; i < st.length; i++) {
        var pair = STY[st[i]].split(U);
        merged.style.push([pair[0], pair[1]]);
      }
      var sc = d(f[4]);
      for (var j = 0; j < sc.length; j++) calls.push(INV[sc[j]].split(U));
    }
    host = host.slice(host.indexOf('.') + 1);
  }

  // Scriptlets first: they hook globals the page's own scripts will read, so
  // every millisecond before those scripts run is the point of them.
  if (calls.length && globalThis.__addblockerScriptlets) {
    globalThis.__addblockerScriptlets.run(calls);
  }
` : ''}
  // The cosmetic runtime assumes document.documentElement exists — true for a
  // content script at document_start, false here: a userscript manager can run
  // us before <html> is parsed, and appending the stylesheet would throw. So
  // wait for the element if it is not there yet, via an observer rather than a
  // timer, to lose no time at all.
  var go = function () {
    if (globalThis.__addblocker) globalThis.__addblocker.apply(merged);
  };
  if (document.documentElement) {
    go();
  } else {
    new MutationObserver(function (records, observer) {
      if (document.documentElement) { observer.disconnect(); go(); }
    }).observe(document, { childList: true });
  }
})();
`;

    await mkdir(OUT_DIR, { recursive: true });

    const full = header(
        'AddBlocker (cosmétique + scriptlets)',
        'Masque les publicités et neutralise les murs anti-adblock. Ne bloque pas le réseau.',
        'addblocker.user.js',
    ) + `${scriptletRuntime}\n${cosmeticRuntime}\n`
        + `var SEL=${JSON.stringify(selectors.items)};\n`
        + `var STY=${JSON.stringify(styles.items)};\n`
        + `var INV=${JSON.stringify(invocations.items)};\n`
        + `var GH=${JSON.stringify(genericHide)};\n`
        + `var GP=${JSON.stringify(genericProcedural)};\n`
        + `var ROW=${JSON.stringify(rowPool.items)};\n`
        + `var DOM=${JSON.stringify(table)};\n`
        + dispatcher(true);

    // The generic sheet alone is a fraction of the size and still removes a
    // great deal, which matters on a phone where the payload is parsed on every
    // page load.
    const genericOnlySelectors = [...new Set([
        ...generic.hide, ...generic.procedural,
    ])];
    const lightPool = new Pool();
    const lightHide = generic.hide.map((s) => lightPool.ref(s)).join(',');
    const lightProcedural = generic.procedural.map((s) => lightPool.ref(s)).join(',');
    void genericOnlySelectors;

    const light = header(
        'AddBlocker Léger (générique)',
        'Masquage générique seulement — plus petit, sans règles par site.',
        'addblocker-lite.user.js',
    ) + `${cosmeticRuntime}\n`
        + `var SEL=${JSON.stringify(lightPool.items)};\n`
        + `var GH=${JSON.stringify(lightHide)};\n`
        + `var GP=${JSON.stringify(lightProcedural)};\n`
        + dispatcher(false);

    await writeFile(join(OUT_DIR, 'addblocker.user.js'), full, 'utf8');
    await writeFile(join(OUT_DIR, 'addblocker-lite.user.js'), light, 'utf8');

    const kb = (text: string): string => `${(text.length / 1024).toFixed(0)} kB`;
    console.log('Pools');
    console.log(`  selectors:   ${selectors.items.length} unique (${kb(JSON.stringify(selectors.items))})`);
    console.log(`  invocations: ${invocations.items.length} unique (${kb(JSON.stringify(invocations.items))})`);
    console.log(`  styles:      ${styles.items.length} unique`);
    console.log(`  rows:        ${rowPool.items.length} unique (${kb(JSON.stringify(rowPool.items))})`);
    console.log(`  domains:     ${Object.keys(table).length} (${kb(JSON.stringify(table))})`);
    console.log('\nWritten');
    console.log(`  addblocker.user.js       ${kb(full)}`);
    console.log(`  addblocker-lite.user.js  ${kb(light)}`);
}

await main();
