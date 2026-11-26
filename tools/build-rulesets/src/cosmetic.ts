/**
 * Builds the cosmetic half of the extension: the runtime bundle plus one
 * generated content script per domain bucket.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { parseCosmeticList } from '@addblocker/filter-parser';
import {
    compileCosmetic, renderBucket, renderGeneric, renderGenericCss, renderGenericDynamic,
} from '@addblocker/cosmetic-compiler';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUNTIME_ENTRY = join(ROOT, 'packages', 'cosmetic-runtime', 'src', 'apply.ts');

/** Manifest-declared content script (snake_case, as the manifest expects). */
export interface ContentScriptEntry {
    matches: string[];
    js: string[];
    run_at: 'document_start';
    all_frames: boolean;
}

/**
 * Dynamically registered content script (camelCase, as the scripting API
 * expects). Declared this way because the manifest cannot hold 22k match
 * patterns — see docs/adr/0002.
 */
export interface DynamicRegistration {
    id: string;
    matches: string[];
    /** Where this script must not run, independently of the user's settings. */
    excludeMatches?: string[];
    js?: string[];
    /** Stylesheets the browser applies itself, with no script involved. */
    css?: string[];
    runAt: 'document_start';
    allFrames: boolean;
    persistAcrossSessions: boolean;
}

export interface CosmeticBuildResult {
    contentScripts: ContentScriptEntry[];
    registrations: DynamicRegistration[];
    stats: ReturnType<typeof compileCosmetic>['stats'] & {
        runtimeBytes: number;
        genericBytes: number;
        /** The script shipped beside the generic sheet on every page. */
        genericDynamicBytes: number;
        /** Sites served the scripted generic payload instead of the sheet. */
        genericExceptionDomains: number;
        bucketBytes: number;
        manifestPatterns: number;
        dynamicPatterns: number;
    };
}

/**
 * Patterns we allow ourselves to declare in the manifest.
 *
 * Measured ceiling: 8 000 patterns still load but cost ~70s of browser
 * startup, and 12 000 fail outright. Staying near 1 000 keeps startup at
 * ~1.6s. See docs/adr/0002.
 */
const MANIFEST_PATTERN_BUDGET = 1_000;

/**
 * Turns a domain into a match pattern.
 *
 * `*://*.example.com/*` covers the domain and its subdomains, which is what a
 * cosmetic filter on `example.com` means.
 */
function matchPattern(domain: string): string {
    return `*://*.${domain}/*`;
}

/**
 * Chrome refuses to load the whole extension over a single malformed match
 * pattern, and says nothing useful about which one. Catch it here, where the
 * offending domain can actually be named.
 */
const VALID_PATTERN = /^\*:\/\/\*\.[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/\*$/;

function assertPatternsValid(entries: ContentScriptEntry[]): void {
    const bad: string[] = [];
    for (const entry of entries) {
        for (const pattern of entry.matches) {
            if (pattern === '*://*/*') continue;
            if (!VALID_PATTERN.test(pattern)) bad.push(pattern);
        }
    }
    if (bad.length > 0) {
        throw new Error(
            `${bad.length} invalid match pattern(s) would stop Chrome loading the extension: ` +
            `${bad.slice(0, 5).map((p) => JSON.stringify(p)).join(', ')}`,
        );
    }
}

export async function buildCosmetic(listContents: string[], outDir: string): Promise<CosmeticBuildResult> {
    const filters = listContents.flatMap((content) => parseCosmeticList(content));
    const result = compileCosmetic(filters);

    const cosmeticDir = join(outDir, 'cosmetic');
    await mkdir(cosmeticDir, { recursive: true });

    // Bundle the runtime once; every bucket script relies on it having run
    // first in the same isolated world.
    const bundled = await build({
        entryPoints: [RUNTIME_ENTRY],
        bundle: true,
        format: 'iife',
        target: 'chrome111',
        minify: true,
        write: false,
    });
    const runtimeCode = bundled.outputFiles[0].text;
    await writeFile(join(cosmeticDir, 'runtime.js'), runtimeCode, 'utf8');

    // The generic rules ship twice, for two kinds of site.
    //
    // Everywhere but a handful of sites, they are a stylesheet the browser
    // applies on its own, plus a tiny script for what a sheet cannot express.
    // On the sites that carry an exception to a generic selector, the sheet is
    // excluded and a script builds the same rules minus those exceptions.
    const genericCss = renderGenericCss(result.generic);
    await writeFile(join(cosmeticDir, 'generic.css'), genericCss, 'utf8');

    const genericDynamic = renderGenericDynamic(result.generic);
    const hasDynamic = result.generic.procedural.length > 0
        || (result.generic.gated?.length ?? 0) > 0;
    if (hasDynamic) await writeFile(join(cosmeticDir, 'generic-dynamic.js'), genericDynamic, 'utf8');

    const genericCode = renderGeneric(result.generic, result.genericExceptions);
    await writeFile(join(cosmeticDir, 'generic.js'), genericCode, 'utf8');
    const exceptionPatterns = Object.keys(result.genericExceptions).map(matchPattern);

    const registrations: DynamicRegistration[] = [];
    let bucketBytes = 0;

    for (const bucket of result.buckets) {
        const code = renderBucket(bucket);
        bucketBytes += code.length;
        await writeFile(join(cosmeticDir, `${bucket.id}.js`), code, 'utf8');
        registrations.push({
            id: bucket.id,
            matches: bucket.domains.map(matchPattern),
            js: ['cosmetic/runtime.js', `cosmetic/${bucket.id}.js`],
            runAt: 'document_start',
            allFrames: true,
            persistAcrossSessions: true,
        });
    }

    // The generic sheet and the user's own filters run everywhere, so the
    // manifest would hold them cheaply — one pattern each. They are registered
    // dynamically anyway, because a manifest content script cannot have its
    // exclusions changed at runtime, and "turn filtering off on this site" has
    // to switch off cosmetic filtering too. The cost is that on a brand-new
    // profile they are inert until the first registration lands; Chrome
    // persists registrations, so every later start has them from the outset.
    registrations.push({
        id: 'generic',
        matches: ['*://*/*'],
        ...(exceptionPatterns.length > 0 ? { excludeMatches: exceptionPatterns } : {}),
        css: ['cosmetic/generic.css'],
        ...(hasDynamic ? { js: ['cosmetic/runtime.js', 'cosmetic/generic-dynamic.js'] } : {}),
        runAt: 'document_start',
        allFrames: true,
        persistAcrossSessions: true,
    });

    if (exceptionPatterns.length > 0) {
        registrations.push({
            id: 'generic-exceptions',
            matches: exceptionPatterns,
            js: ['cosmetic/runtime.js', 'cosmetic/generic.js'],
            runAt: 'document_start',
            allFrames: true,
            persistAcrossSessions: true,
        });
    }

    // Registered unconditionally rather than when the first filter appears:
    // adding one script to an existing registration set costs seconds
    // (measured — docs/adr/0002), which would be paid at the worst moment,
    // right after the user creates a filter. It reads its selectors from
    // storage, so a new filter is a storage write and nothing more.
    registrations.push({
        id: 'user-cosmetic',
        matches: ['*://*/*'],
        js: ['user-cosmetic.js'],
        runAt: 'document_start',
        allFrames: true,
        persistAcrossSessions: true,
    });

    const contentScripts: ContentScriptEntry[] = [];

    assertPatternsValid(contentScripts);
    assertPatternsValid(registrations.map((r) => ({
        matches: [...r.matches, ...(r.excludeMatches ?? [])],
        js: r.js ?? [],
        run_at: 'document_start' as const,
        all_frames: true,
    })));

    const manifestPatterns = contentScripts.reduce((n, c) => n + c.matches.length, 0);
    if (manifestPatterns > MANIFEST_PATTERN_BUDGET) {
        throw new Error(
            `manifest declares ${manifestPatterns} match patterns, over the ${MANIFEST_PATTERN_BUDGET} budget — ` +
            'browser startup degrades quadratically past this point (docs/adr/0002)',
        );
    }

    await writeFile(
        join(cosmeticDir, 'registrations.json'),
        JSON.stringify(registrations),
        'utf8',
    );

    return {
        contentScripts,
        registrations,
        stats: {
            ...result.stats,
            runtimeBytes: runtimeCode.length,
            genericBytes: genericCss.length,
            genericDynamicBytes: hasDynamic ? genericDynamic.length : 0,
            genericExceptionDomains: exceptionPatterns.length,
            bucketBytes,
            manifestPatterns,
            dynamicPatterns: registrations.reduce((n, r) => n + r.matches.length, 0),
        },
    };
}
