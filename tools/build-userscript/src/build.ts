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

import { USERSCRIPT_ENV, parseCosmeticList, preprocess } from '@addblocker/filter-parser';
import { compileCosmetic, type DomainPayload } from '@addblocker/cosmetic-compiler';
import { HIDE_DECLARATION, SELECTORS_PER_RULE } from '@addblocker/cosmetic-runtime/css';
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

/**
 * Derived from the build time, as `YYYY.MMDD.HHmm`.
 *
 * A userscript manager only fetches `@updateURL` when the version there is
 * higher than the installed one. With a constant version every installed copy
 * would have kept its first set of lists for ever, however often this file was
 * regenerated — and the lists are the whole point of regenerating it.
 */
function buildVersion(now: Date): string {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}${pad(now.getUTCDate())}.`
        + `${now.getUTCHours()}${pad(now.getUTCMinutes())}`;
}
const VERSION = buildVersion(new Date());
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
    const raws = await Promise.all(files.map((f) => readFile(join(CACHE_DIR, f), 'utf8')));
    // Same directive resolution as the extension, for a different target: this
    // build keeps the mobile and Safari branches the extension leaves out.
    return raws.map((raw) => preprocess(raw, USERSCRIPT_ENV).text);
}

/**
 * Bundles a runtime the way the extension does, so behaviour is identical —
 * except for where it publishes itself.
 *
 * In the extension each runtime hangs its entry point on `globalThis`, which
 * there is the isolated world's. Here the script can be running in the page's
 * own world, where a global named `__addblocker` is one `in window` test away
 * from telling the site an ad blocker is present. The assignment is redirected
 * to a variable local to the userscript's wrapper function instead.
 */
async function bundle(entry: string, global: string, local: string): Promise<string> {
    const result = await esbuild({
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        target: 'safari15',
        minify: true,
        write: false,
        define: { [`globalThis.${global}`]: local },
    });
    const code = result.outputFiles[0].text;
    if (code.includes(global)) throw new Error(`${global} still leaks from the bundled runtime`);
    return code;
}

/** Separates pooled entries. Lists are line-based, so no entry contains one. */
const LINE = '\n';

/** Packs a pool into one string, split again in the page only if needed. */
function pack(items: string[], what: string): string {
    const bad = items.find((item) => item.includes(LINE));
    if (bad !== undefined) throw new Error(`${what} entry contains a line break: ${JSON.stringify(bad)}`);
    return JSON.stringify(items.join(LINE));
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
    // `@inject-into auto`: the page's world where the site allows it, which is
    // what scriptlets need; the content world where a strict Content Security
    // Policy forbids injected scripts — there `page` would have meant the
    // script did not run at all, losing the cosmetic half along with the rest.
    //
    // No `@noframes` line: to most managers the directive is a flag, so even
    // `@noframes false` switched the script off in iframes, which is where a
    // good share of the ads are.
    return `// ==UserScript==
// @name         ${title}
// @namespace    https://github.com/WicktorB/AddBlocker
// @version      ${VERSION}
// @description  ${description}
// @author       AddBlocker
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @inject-into  auto
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
 * Engendré depuis EasyList, Liste FR, EasyPrivacy et uAssets.
 */
`;
}

const HIDE_RULE_END = `{${HIDE_DECLARATION}}`;

/**
 * The generic sheet, laid out so the page can use it two ways.
 *
 * As is, it is valid CSS and goes straight into a `<style>` — the path taken on
 * nearly every page, with no per-selector work at all. Its selectors are also
 * separated by `,\n` and nothing else, so on the few sites that carry an
 * exception to a generic selector it can be taken apart again, filtered and
 * rebuilt, without shipping the selector list a second time.
 */
function genericSheet(generic: DomainPayload): string {
    const exempt = new Set(generic.exceptions);
    const selectors = generic.hide.filter((selector) => !exempt.has(selector));
    const groups: string[] = [];
    for (let start = 0; start < selectors.length; start += SELECTORS_PER_RULE) {
        groups.push(`${selectors.slice(start, start + SELECTORS_PER_RULE).join(',\n')}${HIDE_RULE_END}`);
    }
    return groups.join('\n');
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

    // Lists are written as `a.com,b.com,c.com##.ad`, so a great many domains
    // end up with byte-identical rows. Interning them turns the table's values
    // into a short index each.
    const rowPool = new Pool();
    const table: string[] = [];
    for (const [domain, row] of rows) {
        const encoded = encodeRow(row);
        if (encoded !== '') table.push(`${domain}=${rowPool.ref(encoded)}`);
    }
    // One string, searched with indexOf: `\ndomain=ref\n`. The leading and
    // trailing separators make every entry findable the same way.
    const domainIndex = JSON.stringify(`${LINE}${table.join(LINE)}${LINE}`);

    const cosmeticRuntime = await bundle(COSMETIC_RUNTIME, '__addblocker', '__abCosmetic');
    const scriptletRuntime = await bundle(SCRIPTLET_RUNTIME, '__addblockerScriptlets', '__abScriptlets');

    // What every page needs, in every build.
    const genericData = `var GCSS=${JSON.stringify(genericSheet(generic))};\n`
        + `var GS=${JSON.stringify(generic.style)};\n`
        + `var GP=${JSON.stringify(generic.procedural)};\n`
        + `var GG=${JSON.stringify(generic.gated ?? [])};\n`
        + `var GX=${JSON.stringify(generic.exceptions)};\n`;

    /**
     * The dispatcher, written as plain source rather than bundled: it is short,
     * and it has to stay readable for anyone who opens the file to see what is
     * running on every page they visit.
     *
     * Its one rule is to touch as little as it can. The tables are a megabyte
     * and a half of text; turned into arrays they were eleven megabytes of
     * heap on every page, including the great majority where no site rule
     * applies. So they stay text: the domain index is searched in place, and
     * a pool is only split when a row for the current site actually needs it.
     */
    const dispatcher = (withDomains: boolean): string => `
  var U = ${JSON.stringify(UNIT)};
  var END = ${JSON.stringify(HIDE_RULE_END)};
  var refs = function (s) {
    if (!s) return [];
    var out = [], parts = s.split(',');
    for (var i = 0; i < parts.length; i++) out.push(parseInt(parts[i], 36));
    return out;
  };

  var merged = { hide: [], style: GS.slice(), procedural: GP.slice(), exceptions: GX.slice(), gated: GG };
  var calls = [];
${withDomains ? `
  // Walk up the hostname: a rule on example.com covers www.example.com too.
  var rowRefs = [];
  var host = location.hostname;
  while (host.indexOf('.') !== -1) {
    var at = DOM.indexOf('\\n' + host + '=');
    if (at !== -1) {
      var from = at + host.length + 2;
      rowRefs.push(parseInt(DOM.slice(from, DOM.indexOf('\\n', from)), 36));
    }
    host = host.slice(host.indexOf('.') + 1);
  }

  if (rowRefs.length) {
    var rowList = ROW.split('\\n'), sel = null, sty = null, inv = null;
    var pick = function (list) {
      if (!list.length) return [];
      if (sel === null) sel = SEL.split('\\n');
      var out = [];
      for (var i = 0; i < list.length; i++) out.push(sel[list[i]]);
      return out;
    };
    for (var r = 0; r < rowRefs.length; r++) {
      var f = rowList[rowRefs[r]].split(';');
      merged.hide = merged.hide.concat(pick(refs(f[0])));
      merged.procedural = merged.procedural.concat(pick(refs(f[1])));
      merged.exceptions = merged.exceptions.concat(pick(refs(f[2])));
      var st = refs(f[3]);
      if (st.length && sty === null) sty = STY.split('\\n');
      for (var i = 0; i < st.length; i++) {
        var pair = sty[st[i]].split(U);
        merged.style.push([pair[0], pair[1]]);
      }
      var sc = refs(f[4]);
      if (sc.length && inv === null) inv = INV.split('\\n');
      for (var j = 0; j < sc.length; j++) calls.push(inv[sc[j]].split(U));
    }
  }

  // Scriptlets first: they hook globals the page's own scripts will read, so
  // every millisecond before those scripts run is the point of them.
  if (calls.length && __abScriptlets) __abScriptlets.run(calls);
` : `
  // No per-site rules in this build, but a site's exceptions to the generic
  // sheet still have to hold, or it would hide what the lists say to leave.
  var host = location.hostname;
  while (host.indexOf('.') !== -1) {
    var x = GXD[host];
    if (x) merged.exceptions = merged.exceptions.concat(x);
    host = host.slice(host.indexOf('.') + 1);
  }
`}
  // The generic sheet. If nothing on this site is excepted beyond what the
  // sheet was already built without, it is used exactly as shipped. Otherwise
  // it is taken apart so the exceptions can remove their selectors.
  if (merged.exceptions.length === GX.length) {
    merged.css = GCSS;
  } else {
    var groups = GCSS.split(END), all = [];
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g].replace(/^\\n/, '');
      if (group) all = all.concat(group.split(',\\n'));
    }
    merged.hide = all.concat(merged.hide);
  }

  // The cosmetic runtime assumes document.documentElement exists — true for a
  // content script at document_start, false here: a userscript manager can run
  // us before <html> is parsed, and appending the stylesheet would throw. So
  // wait for the element if it is not there yet, via an observer rather than a
  // timer, to lose no time at all.
  var go = function () { if (__abCosmetic) __abCosmetic.apply(merged); };
  if (document.documentElement) {
    go();
  } else {
    new MutationObserver(function (records, observer) {
      if (document.documentElement) { observer.disconnect(); go(); }
    }).observe(document, { childList: true });
  }
`;

    // Everything lives inside one function. Depending on the manager and on
    // \`@inject-into\`, top-level \`var\`s of a userscript can become properties
    // of the page's \`window\` — seven of them, here, with names like \`SEL\` and
    // \`DOM\`, visible to the site and free to collide with its own globals.
    const wrap = (body: string): string => `(function () {\nvar __abCosmetic, __abScriptlets;\n${body}})();\n`;

    await mkdir(OUT_DIR, { recursive: true });

    const full = header(
        'AddBlocker (cosmétique + scriptlets)',
        'Masque les publicités et neutralise les murs anti-adblock. Ne bloque pas le réseau.',
        'addblocker.user.js',
    ) + wrap(`${scriptletRuntime}\n${cosmeticRuntime}\n`
        + genericData
        + `var SEL=${pack(selectors.items, 'selector')};\n`
        + `var STY=${pack(styles.items, 'style')};\n`
        + `var INV=${pack(invocations.items, 'invocation')};\n`
        + `var ROW=${pack(rowPool.items, 'row')};\n`
        + `var DOM=${domainIndex};\n`
        + dispatcher(true));

    // The generic sheet alone is a fraction of the size and still removes a
    // great deal, which matters on a phone where the payload is parsed on every
    // page load.
    const light = header(
        'AddBlocker Léger (générique)',
        'Masquage générique seulement — plus petit, sans règles par site.',
        'addblocker-lite.user.js',
    ) + wrap(`${cosmeticRuntime}\n`
        + genericData
        + `var GXD=${JSON.stringify(cosmetic.genericExceptions)};\n`
        + dispatcher(false));

    await writeFile(join(OUT_DIR, 'addblocker.user.js'), full, 'utf8');
    await writeFile(join(OUT_DIR, 'addblocker-lite.user.js'), light, 'utf8');

    const kb = (text: string): string => `${(text.length / 1024).toFixed(0)} kB`;
    console.log('Pools');
    console.log(`  generic:     ${generic.hide.length} selectors, ${generic.gated?.length ?? 0} gated`);
    console.log(`  selectors:   ${selectors.items.length} unique (${kb(pack(selectors.items, 'selector'))})`);
    console.log(`  invocations: ${invocations.items.length} unique (${kb(pack(invocations.items, 'invocation'))})`);
    console.log(`  styles:      ${styles.items.length} unique`);
    console.log(`  rows:        ${rowPool.items.length} unique (${kb(pack(rowPool.items, 'row'))})`);
    console.log(`  domains:     ${table.length} (${kb(domainIndex)})`);
    console.log(`\nWritten (version ${VERSION})`);
    console.log(`  addblocker.user.js       ${kb(full)}`);
    console.log(`  addblocker-lite.user.js  ${kb(light)}`);
}

await main();
