/**
 * Finds what Chrome will accept in `content_scripts`.
 *
 * Chrome documents no limit, and refuses an oversized manifest by simply not
 * loading the extension — no error, no console message. The only way to size
 * the design correctly is to ask the browser.
 *
 * The interesting question is not just "how much", but *what* is being
 * counted: the number of scripts, the number of match patterns, or the size of
 * the manifest. The cases below separate them.
 */

import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORK = join(ROOT, 'dist', 'calibrate-manifest');

function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;
    const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (existsSync(preinstalled)) return preinstalled;
    return chromium.executablePath();
}

/** Builds a synthetic extension with `scripts` scripts of `perScript` patterns. */
async function stage(scripts: number, perScript: number): Promise<{ id: string; bytes: number }> {
    await rm(WORK, { recursive: true, force: true });
    await mkdir(WORK, { recursive: true });

    const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const der = publicKey as unknown as Buffer;
    const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);

    await writeFile(join(WORK, 'cs.js'), '', 'utf8');
    await writeFile(join(WORK, 'probe.html'), '<!doctype html><title>PROBEOK</title>', 'utf8');

    const contentScripts = Array.from({ length: scripts }, (_, s) => ({
        matches: Array.from({ length: perScript }, (_, i) => `*://*.d${s}-${i}.example-site.com/*`),
        js: ['cs.js'],
        run_at: 'document_start',
    }));

    const manifest = {
        manifest_version: 3,
        name: 'calibrate',
        version: '0.0.1',
        key: der.toString('base64'),
        content_scripts: contentScripts,
    };

    const text = JSON.stringify(manifest);
    await writeFile(join(WORK, 'manifest.json'), text, 'utf8');

    return {
        id: [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join(''),
        bytes: text.length,
    };
}

/** Loads the extension; false means Chrome rejected it or took too long. */
async function loads(id: string, timeoutMs: number): Promise<{ ok: boolean; ms: number }> {
    const profile = join(ROOT, 'dist', 'calibrate-profile');
    await rm(profile, { recursive: true, force: true });
    const started = Date.now();
    try {
        const { stdout } = await run(resolveChromium(), [
            '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
            `--user-data-dir=${profile}`,
            `--load-extension=${WORK}`, `--disable-extensions-except=${WORK}`,
            '--dump-dom', `chrome-extension://${id}/probe.html`,
        ], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
        return { ok: stdout.includes('PROBEOK'), ms: Date.now() - started };
    } catch {
        return { ok: false, ms: Date.now() - started };
    } finally {
        await rm(profile, { recursive: true, force: true });
    }
}

const CASES: Array<{ scripts: number; perScript: number; note: string }> = [
    { scripts: 1, perScript: 1_000, note: 'baseline' },
    { scripts: 1, perScript: 8_000, note: 'few scripts, many patterns each' },
    { scripts: 1, perScript: 20_000, note: 'one script, everything in it' },
    { scripts: 20, perScript: 400, note: 'known good from the real build' },
    { scripts: 30, perScript: 400, note: 'known bad from the real build' },
    { scripts: 60, perScript: 100, note: 'many scripts, few patterns each' },
    { scripts: 200, perScript: 10, note: 'very many scripts, tiny each' },
];

async function main(): Promise<void> {
    console.log('  scripts  patterns/ea  total    manifest   loads   time');
    for (const testCase of CASES) {
        const { id, bytes } = await stage(testCase.scripts, testCase.perScript);
        const { ok, ms } = await loads(id, 90_000);
        console.log(`  ${String(testCase.scripts).padEnd(8)} ${String(testCase.perScript).padEnd(12)} ` +
            `${String(testCase.scripts * testCase.perScript).padEnd(8)} ${(bytes / 1024).toFixed(0).padStart(5)}kB    ` +
            `${(ok ? 'yes' : 'NO').padEnd(6)}  ${ms}ms   ${testCase.note}`);
    }
    await rm(WORK, { recursive: true, force: true });
}

await main();
