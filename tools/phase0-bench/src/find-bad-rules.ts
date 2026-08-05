/**
 * Isolates the rules Chrome refuses.
 *
 * Chrome rejects a whole extension when a static ruleset contains an invalid
 * rule, and says little about which one. This bisects each ruleset down to the
 * offending rules so the compiler can be fixed rather than guessed at.
 */

import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { groupLists, loadLists } from './lists.js';
import { parseList } from '@addblocker/filter-parser';
import { compile, type DnrRule } from '@addblocker/dnr-compiler';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const WORK = join(ROOT, 'out', 'bisect');

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

/** Loads a ruleset in a throwaway profile; returns acceptance plus Chrome's complaint. */
async function accepts(rules: DnrRule[]): Promise<{ ok: boolean; stderr: string }> {
    await rm(WORK, { recursive: true, force: true });
    await mkdir(WORK, { recursive: true });
    const { key, id } = identity();

    await writeFile(join(WORK, 'rules.json'), JSON.stringify(rules), 'utf8');
    await writeFile(join(WORK, 'probe.html'), '<!doctype html><title>PROBEOK</title>', 'utf8');
    await writeFile(join(WORK, 'sw.js'), '', 'utf8');
    await writeFile(join(WORK, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        name: 'bisect',
        version: '0.0.1',
        key,
        permissions: ['declarativeNetRequest'],
        host_permissions: ['<all_urls>'],
        background: { service_worker: 'sw.js' },
        declarative_net_request: { rule_resources: [{ id: 'probe', enabled: true, path: 'rules.json' }] },
    }, null, 2), 'utf8');

    const profile = join(ROOT, 'out', 'bisect-profile');
    await rm(profile, { recursive: true, force: true });
    try {
        const { stdout, stderr } = await run(CHROME, [
            '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
            `--user-data-dir=${profile}`,
            `--load-extension=${WORK}`, `--disable-extensions-except=${WORK}`,
            '--dump-dom', `chrome-extension://${id}/probe.html`,
        ], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
        return { ok: stdout.includes('PROBEOK'), stderr };
    } catch (err) {
        const stderr = (err as { stderr?: string }).stderr ?? '';
        return { ok: false, stderr };
    } finally {
        await rm(profile, { recursive: true, force: true });
    }
}

/** Narrows a rejected set down to a minimal failing subset. */
async function bisect(rules: DnrRule[], depth = 0): Promise<DnrRule[]> {
    if (rules.length <= 1) return rules;

    const mid = Math.floor(rules.length / 2);
    const halves = [rules.slice(0, mid), rules.slice(mid)];

    for (const half of halves) {
        const renumbered = half.map((r, i) => ({ ...r, id: i + 1 }));
        const { ok } = await accepts(renumbered);
        if (!ok) {
            console.log(`${'  '.repeat(depth)}  narrowing to ${half.length} rules…`);
            return bisect(half, depth + 1);
        }
    }

    // Neither half fails alone: the problem needs both, so keep this set.
    return rules;
}

async function main(): Promise<void> {
    const lists = await loadLists();
    const bundles = groupLists(lists);

    for (const [name, content] of bundles) {
        const { filters } = parseList(content);
        const { rules } = compile(filters);
        console.log(`\n=== ${name} (${rules.length} rules) ===`);

        const { ok, stderr } = await accepts(rules);
        if (ok) {
            console.log('  accepted as-is');
            continue;
        }

        const complaint = stderr.split('\n').filter((l) => /rule|Rule|manifest|declarative/i.test(l)).slice(0, 3);
        if (complaint.length > 0) console.log(`  Chrome says: ${complaint.join(' | ')}`);

        const culprits = await bisect(rules);
        console.log(`  minimal failing subset: ${culprits.length} rule(s)`);
        for (const rule of culprits.slice(0, 5)) {
            console.log(`    ${JSON.stringify(rule).slice(0, 400)}`);
        }
    }

    await rm(WORK, { recursive: true, force: true });
}

await main();
