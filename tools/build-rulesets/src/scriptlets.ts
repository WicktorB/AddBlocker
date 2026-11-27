/**
 * Builds the scriptlet half of the extension.
 *
 * Same shape as the cosmetic build, with one critical difference: most of
 * these run in `world: MAIN`. A scriptlet's job is to hook a global —
 * `window.open`, `JSON.parse`, a property the page will read — so it must live
 * in the page's own context and run before the page's scripts.
 *
 * The few that only rewrite the DOM get buckets of their own, registered in
 * the isolated world: out of the page's reach, and not subject to its
 * Trusted Types policy when they replace the text of a script.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { compileScriptlets, parseScriptletList, renderScriptletBucket } from '@addblocker/scriptlet-compiler';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUNTIME_ENTRY = join(ROOT, 'packages', 'scriptlet-runtime', 'src', 'run.ts');

export interface ScriptletRegistration {
    id: string;
    matches: string[];
    js: string[];
    runAt: 'document_start';
    allFrames: boolean;
    /** The page's own context is what makes most scriptlets work. */
    world: 'MAIN' | 'ISOLATED';
    persistAcrossSessions: boolean;
}

export interface ScriptletBuildResult {
    registrations: ScriptletRegistration[];
    stats: ReturnType<typeof compileScriptlets>['stats'] & {
        runtimeBytes: number;
        bucketBytes: number;
    };
}

/**
 * The same runtime, shipped twice: once per world.
 *
 * In the page's world the runtime wraps natives — `fetch`, `JSON.stringify`,
 * `appendChild` — so its frames sit between the page and the browser on every
 * such call. When the *page* then makes a call that fails and does not catch
 * it — a tracker request the network rules blocked, most often — the uncaught
 * error is located in the topmost script frame, which is ours. Chrome files
 * errors by the URL of that script: every one of them landed on this
 * extension's Errors page, as if a blocked tracker were a bug here. Measured
 * in Chromium: one unhandled `Failed to fetch` on a page whose `fetch` is
 * wrapped, one entry.
 *
 * A `sourceURL` gives the page-world copy a name that is not an extension
 * URL. The errors still reach the page's console, unchanged, where they
 * belong; they are no longer attributed here. It also keeps the extension's id
 * out of every stack trace the page can read, which is the cheapest way there
 * is to tell that an ad blocker is hooked into `fetch`.
 *
 * The isolated-world copy keeps its real URL: nothing of the page runs through
 * it, so an error there is ours and should say so.
 */
const RUNTIME_FILE = { MAIN: 'runtime-page.js', ISOLATED: 'runtime.js' } as const;
const PAGE_SOURCE_NAME = 'page-hooks.js';

function matchPattern(domain: string): string {
    return `*://*.${domain}/*`;
}

const VALID_PATTERN = /^\*:\/\/\*\.[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/\*$/;

/** A list's text, and whether it is one of the lists allowed `trusted-*` scriptlets. */
export interface ScriptletSource {
    text: string;
    trusted: boolean;
}

/**
 * uBlock Origin's own lists are the trusted ones — the same line uBO draws.
 * Source ids are also the cache file names, which is how the userscript build
 * tells them apart.
 */
export function isTrustedSource(id: string): boolean {
    return id.startsWith('ubo_');
}

export async function buildScriptlets(sources: ScriptletSource[], outDir: string): Promise<ScriptletBuildResult> {
    const filters = sources.flatMap(({ text, trusted }) => parseScriptletList(text, { trusted }));
    const result = compileScriptlets(filters);

    const dir = join(outDir, 'scriptlets');
    await mkdir(dir, { recursive: true });

    const bundled = await build({
        entryPoints: [RUNTIME_ENTRY],
        bundle: true,
        format: 'iife',
        target: 'chrome111',
        minify: true,
        write: false,
    });
    const runtimeCode = bundled.outputFiles[0].text;
    await writeFile(join(dir, RUNTIME_FILE.ISOLATED), runtimeCode, 'utf8');
    await writeFile(join(dir, RUNTIME_FILE.MAIN), `${runtimeCode}\n//# sourceURL=${PAGE_SOURCE_NAME}\n`, 'utf8');

    const registrations: ScriptletRegistration[] = [];
    let bucketBytes = 0;

    for (const bucket of result.buckets) {
        const code = renderScriptletBucket(bucket);
        bucketBytes += code.length;
        await writeFile(join(dir, `${bucket.id}.js`), code, 'utf8');

        const matches = bucket.domains.map(matchPattern);
        const bad = matches.filter((p) => !VALID_PATTERN.test(p));
        if (bad.length > 0) {
            throw new Error(`invalid scriptlet match pattern(s): ${bad.slice(0, 3).join(', ')}`);
        }

        registrations.push({
            id: bucket.id,
            matches,
            js: [`scriptlets/${RUNTIME_FILE[bucket.world]}`, `scriptlets/${bucket.id}.js`],
            runAt: 'document_start',
            allFrames: true,
            world: bucket.world,
            persistAcrossSessions: true,
        });
    }

    return {
        registrations,
        stats: {
            ...result.stats,
            runtimeBytes: runtimeCode.length,
            bucketBytes,
        },
    };
}
