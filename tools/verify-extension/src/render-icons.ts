/**
 * Renders the extension's icon from its SVG source to the PNG sizes Chrome
 * wants.
 *
 * The PNGs are committed, so a normal build needs no browser. Run this only
 * after editing `packages/ui/src/icons/icon.svg`, or to try one of the
 * alternatives:
 *
 *   pnpm render-icons                                  # from icon.svg
 *   pnpm render-icons packages/ui/src/icons/alternatives/ad-barre.svg
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preinstalledChromium } from '../../shared/chromium.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ICONS = join(ROOT, 'packages', 'ui', 'src', 'icons');
const SIZES = [16, 32, 48, 128];

// pnpm runs scripts from the package directory; paths are given from the root.
const source = process.argv[2] === undefined ? join(ICONS, 'icon.svg') : resolve(ROOT, process.argv[2]);
const svg = await readFile(source, 'utf8');

const executablePath = process.env.CHROMIUM_PATH ?? preinstalledChromium() ?? undefined;
const browser = await chromium.launch({ executablePath, headless: true });
try {
    for (const size of SIZES) {
        const page = await browser.newPage({ viewport: { width: size, height: size } });
        const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `);
        await page.setContent(`<body style="margin:0;background:transparent">${sized}</body>`);
        await page.screenshot({ path: join(ICONS, `icon-${size}.png`), omitBackground: true });
        await page.close();
        console.log(`  icon-${size}.png`);
    }
} finally {
    await browser.close();
}
console.log(`Rendered from ${source}`);
