/**
 * Tests whether `chrome.scripting.registerContentScripts()` scales further
 * than the manifest.
 *
 * The manifest's content_scripts are parsed at load time and appear to have a
 * hard practical ceiling. Dynamic registration goes through a different path
 * and persists across restarts, so it may carry the ~22k domains our cosmetic
 * filters need. If it does, the manifest only has to bootstrap.
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORK = join(ROOT, 'dist', 'calibrate-dynamic');

function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;
    const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (existsSync(preinstalled)) return preinstalled;
    return chromium.executablePath();
}

async function stage(): Promise<string> {
    await rm(WORK, { recursive: true, force: true });
    await mkdir(WORK, { recursive: true });

    const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const der = publicKey as unknown as Buffer;
    const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);

    await writeFile(join(WORK, 'cs.js'), 'globalThis.__marked = true;\n', 'utf8');
    await writeFile(join(WORK, 'probe.html'), '<!doctype html><meta charset="utf-8"><title>PROBEOK</title>', 'utf8');
    await writeFile(join(WORK, 'sw.js'), '', 'utf8');
    await writeFile(join(WORK, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        name: 'calibrate-dynamic',
        version: '0.0.1',
        key: der.toString('base64'),
        permissions: ['scripting'],
        host_permissions: ['<all_urls>'],
        background: { service_worker: 'sw.js' },
    }), 'utf8');

    return [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');
}

async function main(): Promise<void> {
    const id = await stage();
    const profile = join(ROOT, 'dist', 'calibrate-dynamic-profile');
    await rm(profile, { recursive: true, force: true });

    const context = await chromium.launchPersistentContext(profile, {
        executablePath: resolveChromium(),
        headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        timeout: 120_000,
        args: [
            `--disable-extensions-except=${WORK}`, `--load-extension=${WORK}`,
            '--no-first-run', '--no-sandbox', '--disable-gpu',
        ],
    });

    try {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${id}/probe.html`, { timeout: 60_000 });

        console.log('  scripts  patterns/ea  total     registers   time');
        for (const [scripts, perScript] of [[1, 1_000], [1, 10_000], [10, 1_000], [56, 400], [100, 250]]) {
            const result = await page.evaluate(async ([n, per]: number[]) => {
                const scripting = (globalThis as unknown as { chrome: typeof chrome }).chrome.scripting;
                const ids = (await scripting.getRegisteredContentScripts()).map((s) => s.id);
                if (ids.length > 0) await scripting.unregisterContentScripts({ ids });

                const registrations = Array.from({ length: n }, (_, s) => ({
                    id: `bucket-${s}`,
                    matches: Array.from({ length: per }, (_, i) => `*://*.d${s}-${i}.example-site.com/*`),
                    js: ['cs.js'],
                    runAt: 'document_start' as const,
                    persistAcrossSessions: true,
                }));

                const started = Date.now();
                try {
                    await scripting.registerContentScripts(registrations);
                    return { ok: true, ms: Date.now() - started, error: '' };
                } catch (err) {
                    return { ok: false, ms: Date.now() - started, error: String(err).slice(0, 90) };
                }
            }, [scripts, perScript]);

            console.log(`  ${String(scripts).padEnd(8)} ${String(perScript).padEnd(12)} ` +
                `${String(scripts * perScript).padEnd(9)} ${(result.ok ? 'yes' : 'NO').padEnd(11)} ${result.ms}ms` +
                `${result.error === '' ? '' : `  ${result.error}`}`);
        }
    } finally {
        await context.close();
        await rm(profile, { recursive: true, force: true });
        await rm(WORK, { recursive: true, force: true });
    }
}

await main();
