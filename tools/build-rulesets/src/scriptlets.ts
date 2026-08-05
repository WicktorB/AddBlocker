/**
 * Builds the scriptlet half of the extension.
 *
 * Same shape as the cosmetic build, with one critical difference: these run in
 * `world: MAIN`. A scriptlet's job is to hook a global — `window.open`,
 * `JSON.parse`, a property the page will read — so it must live in the page's
 * own context and run before the page's scripts.
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
    /** The page's own context — this is what makes a scriptlet work. */
    world: 'MAIN';
    persistAcrossSessions: boolean;
}

export interface ScriptletBuildResult {
    registrations: ScriptletRegistration[];
    stats: ReturnType<typeof compileScriptlets>['stats'] & {
        runtimeBytes: number;
        bucketBytes: number;
    };
}

function matchPattern(domain: string): string {
    return `*://*.${domain}/*`;
}

const VALID_PATTERN = /^\*:\/\/\*\.[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/\*$/;

export async function buildScriptlets(listContents: string[], outDir: string): Promise<ScriptletBuildResult> {
    const filters = listContents.flatMap((content) => parseScriptletList(content));
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
    await writeFile(join(dir, 'runtime.js'), runtimeCode, 'utf8');

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
            js: [`scriptlets/runtime.js`, `scriptlets/${bucket.id}.js`],
            runAt: 'document_start',
            allFrames: true,
            world: 'MAIN',
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
