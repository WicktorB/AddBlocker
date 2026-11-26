/**
 * Finds how many domains Chrome accepts inside a single DNR rule's
 * `requestDomains` array.
 *
 * The merging optimisation packs thousands of hostnames into one rule. Chrome
 * documents no explicit cap, so the only trustworthy answer is what the browser
 * does when you hand it one. Each size is tested in a fresh profile: the probe
 * page only loads if Chrome accepted the extension.
 */

import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { preinstalledChromium } from '../../shared/chromium.js';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROMIUM_PATH ?? preinstalledChromium() ?? '';
if (CHROME === '') throw new Error('no Chromium found — set CHROMIUM_PATH');

const SIZES = [100, 1_000, 5_000, 10_000, 25_000, 50_000];

function identity(): { key: string; id: string } {
    const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const der = publicKey as unknown as Buffer;
    const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);
    return {
        key: der.toString('base64'),
        id: [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join(''),
    };
}

/** Builds an extension whose single rule carries `domainCount` domains. */
async function buildProbe(dir: string, domainCount: number, ruleCount: number): Promise<string> {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const { key, id } = identity();

    const rules = [];
    for (let r = 0; r < ruleCount; r += 1) {
        const domains = Array.from({ length: domainCount }, (_, i) => `d${r}-${i}.example-${i % 97}.com`);
        rules.push({
            id: r + 1,
            priority: 1000,
            action: { type: 'block' },
            condition: { requestDomains: domains, domainType: 'thirdParty' },
        });
    }

    await writeFile(join(dir, 'rules.json'), JSON.stringify(rules), 'utf8');
    await writeFile(join(dir, 'probe.html'), '<!doctype html><title>PROBEOK</title>', 'utf8');
    await writeFile(join(dir, 'sw.js'), '', 'utf8');
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        name: `probe-${domainCount}x${ruleCount}`,
        version: '0.0.1',
        key,
        permissions: ['declarativeNetRequest'],
        background: { service_worker: 'sw.js' },
        declarative_net_request: {
            rule_resources: [{ id: 'probe', enabled: true, path: 'rules.json' }],
        },
    }, null, 2), 'utf8');

    return id;
}

/** Loads the extension and reports whether Chrome accepted it, and how fast. */
async function testLoad(dir: string, id: string, timeoutMs: number): Promise<{ ok: boolean; ms: number }> {
    const profile = join(ROOT, 'out', `profile-${Date.now()}`);
    const started = Date.now();
    try {
        const { stdout } = await run(CHROME, [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--no-first-run',
            `--user-data-dir=${profile}`,
            `--load-extension=${dir}`,
            `--disable-extensions-except=${dir}`,
            '--dump-dom',
            `chrome-extension://${id}/probe.html`,
        ], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
        return { ok: stdout.includes('PROBEOK'), ms: Date.now() - started };
    } catch {
        return { ok: false, ms: Date.now() - started };
    } finally {
        await rm(profile, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    console.log('Domains packed into a single rule');
    console.log('  size      accepted   load');
    const dir = join(ROOT, 'out', 'calibrate');

    let lastAccepted = 0;
    for (const size of SIZES) {
        const id = await buildProbe(dir, size, 1);
        const { ok, ms } = await testLoad(dir, id, 180_000);
        if (ok) lastAccepted = size;
        console.log(`  ${String(size).padEnd(9)} ${(ok ? 'yes' : 'NO').padEnd(10)} ${ms}ms`);
    }

    console.log(`\nLargest single-rule domain array accepted: ${lastAccepted}`);

    // Total domains matter too: many rules each holding a moderate array.
    console.log('\nTotal domains spread across many rules (500 per rule)');
    console.log('  rules     total      accepted   load');
    for (const ruleCount of [10, 100, 200]) {
        const id = await buildProbe(dir, 500, ruleCount);
        const { ok, ms } = await testLoad(dir, id, 180_000);
        console.log(`  ${String(ruleCount).padEnd(9)} ${String(ruleCount * 500).padEnd(10)} ${(ok ? 'yes' : 'NO').padEnd(10)} ${ms}ms`);
    }

    await rm(dir, { recursive: true, force: true });
}

await main();
