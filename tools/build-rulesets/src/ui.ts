/**
 * Builds the extension's user-facing surfaces: the service worker bundle and
 * the popup, options page, picker and user-filter script.
 */

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKER_ENTRY = join(ROOT, 'packages', 'extension-core', 'src', 'worker.ts');
const UI_DIR = join(ROOT, 'packages', 'ui', 'src');

/** Copied verbatim: plain HTML and JS with no build step of their own. */
const ASSETS = ['popup.html', 'popup.js', 'options.html', 'options.js', 'picker.js', 'user-cosmetic.js'];

export interface UiBuildResult {
    workerBytes: number;
    assets: string[];
}

/**
 * `buildId` identifies the content-script registrations this build ships. It is
 * compiled into the worker so it can tell, without reading them, whether the
 * registrations Chrome holds are already this build's.
 */
export async function buildUi(outDir: string, buildId: string): Promise<UiBuildResult> {
    await mkdir(outDir, { recursive: true });

    // IIFE, not ESM: a classic service worker rejects `export` statements
    // outright and simply never starts — with no error surfaced anywhere the
    // extension can see. The module's exports exist for the unit tests, which
    // import the TypeScript directly.
    const bundled = await build({
        entryPoints: [WORKER_ENTRY],
        bundle: true,
        format: 'iife',
        target: 'chrome111',
        minify: false,
        write: false,
        define: { __BUILD_ID__: JSON.stringify(buildId) },
    });
    const workerCode = bundled.outputFiles[0].text;
    await writeFile(join(outDir, 'sw.js'), workerCode, 'utf8');

    for (const asset of ASSETS) {
        await copyFile(join(UI_DIR, asset), join(outDir, asset));
    }

    return { workerBytes: workerCode.length, assets: ASSETS };
}
