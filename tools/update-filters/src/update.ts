/**
 * Refreshes the filter lists and rebuilds the extension.
 *
 * In personal use there is no CDN to operate and no review to wait for, so an
 * update is just this: re-fetch what changed upstream, recompile, reload. The
 * design constraint is that it has to be quick enough to run casually, which is
 * why the fetches are conditional — upstream lists change a few times a day,
 * and re-downloading twenty unchanged files to rebuild an identical extension
 * is the slow way to do nothing.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Relative rather than by package name: these are workspace tools, not
// published packages, and the catalog is the single source of truth for what
// we ship.
import { RULESETS } from '../../build-rulesets/src/catalog.js';
import { reloadExtension } from './reload.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CACHE_DIR = join(ROOT, '.filter-cache');
const EXTENSION_DIR = join(ROOT, 'dist', 'extension');
const RULES_DIR = join(EXTENSION_DIR, 'rules');
const EXTENSION_NAME = 'AddBlocker';

const CONCURRENCY = 8;

interface CachedMeta {
    etag?: string;
    lastModified?: string;
    fetchedAt: string;
}

type SourceOutcome =
    | { id: string; state: 'unchanged' }
    | { id: string; state: 'updated'; before: number; after: number }
    | { id: string; state: 'new'; after: number }
    | { id: string; state: 'failed'; reason: string };

async function readMeta(id: string): Promise<CachedMeta | null> {
    try {
        return JSON.parse(await readFile(join(CACHE_DIR, `${id}.meta.json`), 'utf8')) as CachedMeta;
    } catch {
        return null;
    }
}

/**
 * Fetches one list, sending validators so an unchanged list costs a 304.
 *
 * A failure leaves the cached copy alone: an upstream blip must not silently
 * shrink the rules the user is protected by.
 */
async function refreshSource(id: string, url: string): Promise<SourceOutcome> {
    const path = join(CACHE_DIR, `${id}.txt`);
    const had = existsSync(path);
    const meta = had ? await readMeta(id) : null;

    const headers: Record<string, string> = {};
    if (meta?.etag !== undefined) headers['if-none-match'] = meta.etag;
    if (meta?.lastModified !== undefined) headers['if-modified-since'] = meta.lastModified;

    let response: Response;
    try {
        response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
        return { id, state: had ? 'unchanged' : 'failed', reason: String(err) } as SourceOutcome;
    }

    if (response.status === 304) return { id, state: 'unchanged' };
    if (!response.ok) {
        return had
            ? { id, state: 'unchanged' }
            : { id, state: 'failed', reason: `HTTP ${response.status}` };
    }

    const text = await response.text();
    const previous = had ? await readFile(path, 'utf8') : '';

    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path, text, 'utf8');
    await writeFile(join(CACHE_DIR, `${id}.meta.json`), JSON.stringify({
        etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined,
        fetchedAt: new Date().toISOString(),
    } satisfies CachedMeta), 'utf8');

    if (!had) return { id, state: 'new', after: text.length };
    // Some servers send neither validator; compare to avoid reporting a change
    // that is not one, and to skip a rebuild that would produce the same bytes.
    if (text === previous) return { id, state: 'unchanged' };
    return { id, state: 'updated', before: previous.length, after: text.length };
}

/** Runs tasks with a cap, so twenty lists do not open twenty sockets at once. */
async function pooled<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length) return;
            results[index] = await run(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}

interface RulesetSize {
    rules: number;
    /** Domains across all conditions — see why below. */
    domains: number;
}

/**
 * Measures each ruleset, in rules *and* in domains.
 *
 * Rule count alone misreports an update: domain merging folds new domains into
 * existing rules, so a list can grow by thousands of entries while the rule
 * count does not move. Reporting only rules would make a real update look like
 * a no-op.
 */
async function rulesetSizes(): Promise<Record<string, RulesetSize>> {
    const sizes: Record<string, RulesetSize> = {};
    if (!existsSync(RULES_DIR)) return sizes;

    for (const file of await readdir(RULES_DIR)) {
        if (!file.endsWith('.json')) continue;
        const rules = JSON.parse(await readFile(join(RULES_DIR, file), 'utf8')) as Array<{
            condition?: {
                requestDomains?: string[];
                initiatorDomains?: string[];
                excludedInitiatorDomains?: string[];
            };
        }>;
        let domains = 0;
        for (const rule of rules) {
            domains += rule.condition?.requestDomains?.length ?? 0;
            domains += rule.condition?.initiatorDomains?.length ?? 0;
            domains += rule.condition?.excludedInitiatorDomains?.length ?? 0;
        }
        sizes[file.replace(/\.json$/, '')] = { rules: rules.length, domains };
    }
    return sizes;
}

function runBuild(): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('pnpm', ['--filter', '@addblocker/build-rulesets', 'run', 'build'], {
            cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
        });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) { resolve(); return; }
            process.stdout.write(output);
            reject(new Error(`build failed with code ${String(code)}`));
        });
    });
}

function argValue(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
    const started = Date.now();
    const force = process.argv.includes('--force');
    const budget = Number(argValue('budget') ?? '0');
    const port = Number(argValue('port') ?? '9222');

    const sources = RULESETS.flatMap((ruleset) => ruleset.sources);
    console.log(`Refreshing ${sources.length} lists…`);

    const outcomes = await pooled(sources, CONCURRENCY, (s) => refreshSource(s.id, s.url));

    const updated = outcomes.filter((o) => o.state === 'updated' || o.state === 'new');
    const failed = outcomes.filter((o) => o.state === 'failed');
    const fetchMs = Date.now() - started;

    for (const outcome of updated) {
        if (outcome.state === 'new') {
            console.log(`  + ${outcome.id} — downloaded (${outcome.after} bytes)`);
        } else if (outcome.state === 'updated') {
            const delta = outcome.after - outcome.before;
            console.log(`  ~ ${outcome.id} — ${delta >= 0 ? '+' : ''}${delta} bytes`);
        }
    }
    for (const outcome of failed) {
        if (outcome.state === 'failed') console.log(`  ! ${outcome.id} — ${outcome.reason}`);
    }
    console.log(`  ${outcomes.length - updated.length - failed.length} unchanged `
        + `(${fetchMs} ms)\n`);

    if (failed.length > 0) {
        // A list we have never downloaded is missing entirely; anything else
        // kept its cached copy and the build is still complete.
        throw new Error(`${failed.length} list(s) could not be fetched and have no cached copy`);
    }

    const built = existsSync(join(EXTENSION_DIR, 'manifest.json'));
    if (updated.length === 0 && built && !force) {
        console.log('Nothing changed upstream — extension left as is (--force to rebuild anyway).');
        console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        return;
    }

    const before = await rulesetSizes();
    console.log('Rebuilding…');
    const buildStarted = Date.now();
    await runBuild();
    const after = await rulesetSizes();
    console.log(`  built in ${((Date.now() - buildStarted) / 1000).toFixed(1)} s`);

    const signed = (n: number): string => `${n >= 0 ? '+' : ''}${n}`;
    const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    let moved = false;
    for (const id of ids) {
        const was = before[id] ?? { rules: 0, domains: 0 };
        const now = after[id] ?? { rules: 0, domains: 0 };
        const dRules = now.rules - was.rules;
        const dDomains = now.domains - was.domains;
        if (dRules === 0 && dDomains === 0) continue;
        moved = true;
        console.log(`  ${id}: ${now.rules} rules (${signed(dRules)}), `
            + `${now.domains} domains (${signed(dDomains)})`);
    }
    if (!moved) console.log('  no change in the compiled rules');

    const reload = await reloadExtension(EXTENSION_NAME, port, EXTENSION_DIR);
    console.log(reload.ok
        ? `\nExtension reloaded (${reload.extensionId}, via ${reload.via}).`
        : `\nExtension not reloaded: ${reload.reason}.\n`
            + '  Reload it from chrome://extensions, or start Chrome with\n'
            + `  --remote-debugging-port=${port} to have this done automatically.`);

    const elapsed = (Date.now() - started) / 1000;
    console.log(`\nDone in ${elapsed.toFixed(1)} s`);

    if (budget > 0 && elapsed > budget) {
        throw new Error(`took ${elapsed.toFixed(1)} s, over the ${budget} s budget`);
    }
}

await main();
