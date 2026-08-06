/**
 * Measures how close this blocker gets to uBlock Origin.
 *
 * The reference is not an approximation of uBO but uBO's own static network
 * filtering engine (`@gorhill/ubo-core`), fed the same lists. Our side is
 * measured in a real Chromium running the built extension, because Chrome's
 * declarativeNetRequest engine — not a model of it — is what will run for the
 * user. A failed request is never taken as evidence of blocking; only a block
 * rule reported by `onRuleMatchedDebug` is.
 *
 * What this does *not* measure: the open web. The corpus is synthesised from
 * the lists, so it captures filter semantics, not real page traffic. Site
 * breakage on real sites is what `sites.ts` is for.
 */

import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { RULESETS } from '../../build-rulesets/src/catalog.js';
import { buildCorpus, harvest, type Probe } from './corpus.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT = join(ROOT, 'dist', 'extension');
const STAGED = join(ROOT, 'dist', 'parity-extension');
const CACHE_DIR = join(ROOT, '.filter-cache');
const REPORT = join(ROOT, 'dist', 'parity-report.json');

const SITES = Number(process.env.PARITY_SITES ?? 200);
const PER_SITE = Number(process.env.PARITY_PER_SITE ?? 20);
const SEED = Number(process.env.PARITY_SEED ?? 20_260_806);

/** Exit criteria, from the roadmap. */
const MIN_BLOCK_RATIO = Number(process.env.PARITY_MIN_RATIO ?? 0.95);
const MAX_OVERBLOCK_RATE = Number(process.env.PARITY_MAX_OVERBLOCK ?? 0.01);

function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;
    const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (existsSync(preinstalled)) return preinstalled;
    const managed = chromium.executablePath();
    if (existsSync(managed)) return managed;
    throw new Error('no Chromium found');
}

/**
 * Reads the lists the extension actually has switched on.
 *
 * Feeding uBO every list while the extension ships some of them disabled — the
 * annoyances list is off by default — would compare two different filter sets
 * and charge the difference to the compiler. The first version of this did
 * exactly that, and the misses it produced were mostly rules we had chosen not
 * to enable.
 */
async function readLists(): Promise<{
    lists: Array<{ name: string; raw: string }>; lines: string[]; skipped: string[];
}> {
    const manifest = JSON.parse(await readFile(join(BUILT, 'manifest.json'), 'utf8')) as {
        declarative_net_request?: { rule_resources?: Array<{ id: string; enabled?: boolean }> };
    };
    const enabled = new Set((manifest.declarative_net_request?.rule_resources ?? [])
        .filter((r) => r.enabled !== false).map((r) => r.id));

    const lists: Array<{ name: string; raw: string }> = [];
    const lines: string[] = [];
    const skipped: string[] = [];

    for (const ruleset of RULESETS) {
        for (const source of ruleset.sources) {
            const path = join(CACHE_DIR, `${source.id}.txt`);
            if (!existsSync(path)) continue;
            if (!enabled.has(ruleset.id)) { skipped.push(source.id); continue; }
            const raw = await readFile(path, 'utf8');
            lists.push({ name: source.id, raw });
            lines.push(...raw.split('\n'));
        }
    }

    if (lists.length === 0) throw new Error(`no lists in ${CACHE_DIR} — run pnpm build first`);
    return { lists, lines, skipped };
}

interface UboEngine {
    useLists: (lists: Array<{ name: string; raw: string }>) => Promise<void>;
    matchRequest: (details: { originURL: string; url: string; type: string }) => number;
    /** Details of the filter that decided the last match. */
    toLogData: () => { raw?: string } | undefined;
}

/**
 * Names why uBO blocked something we did not.
 *
 * A bare percentage says nothing actionable. Grouping the misses by the filter
 * feature responsible separates what is deliberately unimplemented from what is
 * a compiler defect — the second is worth fixing, the first is a decision.
 */
function classifyMiss(filter: string | undefined): string {
    if (filter === undefined || filter === '') return 'unknown filter';
    const options = filter.includes('$') ? filter.slice(filter.lastIndexOf('$') + 1) : '';
    if (/\bredirect(-rule)?=/.test(options)) return '$redirect';
    if (/\bcsp=/.test(options)) return '$csp — not implemented';
    if (/\bnoop\b/.test(options)) return '$noop';
    if (/\bremoveparam/.test(options)) return '$removeparam — not implemented';
    if (/\bpopup\b/.test(options)) return '$popup — we block navigations only';
    if (/\bdocument\b/.test(options)) return '$document — we block navigations only';
    if (filter.startsWith('/') && filter.lastIndexOf('/') > 0) return 'regex filter';
    if (!filter.startsWith('||')) return 'not domain-anchored';
    if (/\bdomain=/.test(options)) return '$domain-scoped';
    return 'plain filter — worth investigating';
}

/** Maps `rulesetId:ruleId` to the action, to tell a block from an exception. */
async function loadRuleActions(): Promise<Map<string, string>> {
    const actions = new Map<string, string>();
    for (const file of await readdir(join(BUILT, 'rules'))) {
        const rulesetId = file.replace(/\.json$/, '');
        const rules = JSON.parse(await readFile(join(BUILT, 'rules', file), 'utf8')) as Array<{
            id: number; action: { type: string };
        }>;
        for (const rule of rules) actions.set(`${rulesetId}:${String(rule.id)}`, rule.action.type);
    }
    return actions;
}

async function stageExtension(): Promise<string> {
    await rm(STAGED, { recursive: true, force: true });
    await cp(BUILT, STAGED, { recursive: true });

    const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const der = publicKey as unknown as Buffer;
    const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);

    const manifestPath = join(STAGED, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.key = der.toString('base64');
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    await writeFile(join(STAGED, 'collector.html'),
        '<!doctype html><meta charset="utf-8"><title>collector</title>', 'utf8');

    return [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');
}

function startServer(): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
        const url = req.url ?? '/';
        if (url.startsWith('/__runner')) {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<!doctype html><meta charset="utf-8"><title>runner</title>');
            return;
        }
        if (url.includes('.css')) {
            res.writeHead(200, { 'content-type': 'text/css', 'access-control-allow-origin': '*' });
            res.end('/* css */');
            return;
        }
        if (url.includes('.gif') || url.includes('.png')) {
            // A 1×1 GIF, so <img> actually completes rather than erroring.
            res.writeHead(200, { 'content-type': 'image/gif', 'access-control-allow-origin': '*' });
            res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
            return;
        }
        if (url.includes('.html') || url.includes('/frame')) {
            res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
            res.end('<!doctype html><title>f</title>');
            return;
        }
        res.writeHead(200, {
            'content-type': 'application/javascript', 'access-control-allow-origin': '*',
        });
        res.end('/* served */');
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
        });
    });
}

interface Verdict { ours: boolean; ubo: boolean; filter?: string }

function ratio(numerator: number, denominator: number): string {
    if (denominator === 0) return 'n/a';
    return `${((numerator / denominator) * 100).toFixed(2)} %`;
}

async function main(): Promise<void> {
    console.log('Reading the filter lists…');
    const { lists, lines, skipped } = await readLists();
    const harvested = harvest(lines);
    console.log(`  ${lists.length} enabled lists, ${harvested.stats.networkFilters} network filters`);
    if (skipped.length > 0) {
        console.log(`  ${skipped.length} list(s) excluded because the extension ships them off: `
            + `${skipped.join(', ')}`);
    }
    console.log(`  ${harvested.blockedDomains.length} blocked domains, `
        + `${harvested.exceptionDomains.length} exception domains, `
        + `${harvested.sites.length} real site names`);
    // Say what the corpus cannot reach rather than let the number imply
    // coverage it does not have.
    console.log(`  ${harvested.stats.unreachable} network filters are not domain-anchored `
        + `(${ratio(harvested.stats.unreachable, harvested.stats.networkFilters)} of them), `
        + 'so no probe is derived from them\n');

    console.log('Loading uBlock Origin\'s own engine as the reference…');
    const { StaticNetFilteringEngine } = await import('@gorhill/ubo-core') as {
        StaticNetFilteringEngine: { create: () => Promise<UboEngine> };
    };
    const ubo = await StaticNetFilteringEngine.create();
    await ubo.useLists(lists);
    console.log('  engine ready\n');

    const corpus = buildCorpus(harvested, { sites: SITES, requestsPerSite: PER_SITE, seed: SEED });
    console.log(`Corpus: ${corpus.length} requests across ${SITES} first-party origins\n`);

    const extensionId = await stageExtension();
    const { server, port } = await startServer();
    const actions = await loadRuleActions();
    const profile = join(ROOT, 'dist', 'parity-profile');
    await rm(profile, { recursive: true, force: true });

    const executable = resolveChromium();
    if (executable.includes('headless_shell')) {
        throw new Error('headless shell ignores --load-extension; every probe would read as allowed');
    }
    console.log(`Chromium: ${executable}`);

    const context = await chromium.launchPersistentContext(profile, {
        executablePath: executable,
        headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        timeout: 120_000,
        args: [
            `--disable-extensions-except=${STAGED}`,
            `--load-extension=${STAGED}`,
            `--host-resolver-rules=MAP * 127.0.0.1:${port},EXCLUDE localhost`,
            '--no-first-run', '--no-sandbox', '--disable-gpu',
        ],
    });

    const verdicts = new Map<string, Verdict>();
    /** Probes whose page could not load, so they were never issued. */
    const unusable = new Set<string>();

    try {
        // Collector page: onRuleMatchedDebug is the only sound signal for what
        // the extension did. A failed request proves nothing.
        const collector = await context.newPage();
        await collector.goto(`chrome-extension://${extensionId}/collector.html`, { timeout: 60_000 });
        await collector.evaluate(() => {
            const api = (globalThis as unknown as { chrome: typeof chrome }).chrome;
            const seen: Array<{ url: string; key: string }> = [];
            (globalThis as unknown as { __matches: typeof seen }).__matches = seen;
            api.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
                seen.push({
                    url: info.request.url,
                    key: `${info.rule.rulesetId}:${String(info.rule.ruleId)}`,
                });
            });
        });

        // Group by first-party origin: each origin is one page load, and the
        // origin is what makes $domain= and third-party filters meaningful.
        const bySite = new Map<string, Probe[]>();
        for (const probe of corpus) {
            const list = bySite.get(probe.initiator) ?? [];
            list.push(probe);
            bySite.set(probe.initiator, list);
        }

        let done = 0;
        const started = Date.now();

        let skippedSites = 0;
        for (const [site, probes] of bySite) {
            // A page per origin. Reusing one and navigating it away leaves the
            // previous origin's requests in flight, which tears the execution
            // context down under the next evaluate.
            const runner = await context.newPage();
            try {
                await runner.goto(`http://${site}:${port}/__runner`,
                    { waitUntil: 'domcontentloaded', timeout: 20_000 });
            } catch {
                // The origin is unusable as a page — a scoped filter can name a
                // site that is itself blocked. Its probes are dropped rather
                // than counted as allowed, which would be a false miss.
                skippedSites += 1;
                for (const probe of probes) unusable.add(probe.url);
                await runner.close();
                continue;
            }
            // Only anonymous arrow functions in here: tsx names the others and
            // emits an esbuild shim the page does not have.
            try {
                await runner.evaluate(async (requests: Array<{ url: string; type: string }>) => {
                    await Promise.all(requests.map((request) => new Promise<void>((resolve) => {
                        if (request.type === 'xmlhttprequest') {
                            void fetch(request.url, { mode: 'no-cors', cache: 'no-store' })
                                .then(() => { resolve(); }, () => { resolve(); });
                            return;
                        }

                        let element: HTMLElement;
                        if (request.type === 'script') {
                            const el = document.createElement('script');
                            el.src = request.url;
                            element = el;
                        } else if (request.type === 'image') {
                            const el = document.createElement('img');
                            el.src = request.url;
                            element = el;
                        } else if (request.type === 'sub_frame') {
                            const el = document.createElement('iframe');
                            el.src = request.url;
                            el.style.display = 'none';
                            element = el;
                        } else {
                            const el = document.createElement('link');
                            el.rel = 'stylesheet';
                            el.href = request.url;
                            element = el;
                        }

                        element.addEventListener('load', () => { resolve(); });
                        element.addEventListener('error', () => { resolve(); });
                        document.documentElement.append(element);
                        // Some element types fire neither event when the request is
                        // blocked; it was still issued, which is all this needs.
                        setTimeout(() => { resolve(); }, 3_000);
                    })));
                }, probes.map((p) => ({ url: p.url, type: p.type })));
            } catch (err) {
                // The page tore its context down mid-run. Its probes cannot be
                // trusted either way, so they leave the measurement rather than
                // count as allowed.
                skippedSites += 1;
                for (const probe of probes) unusable.add(probe.url);
                if (skippedSites <= 5) {
                    console.log(`  origin dropped: ${site} — ${String(err).split('\n')[0].slice(0, 90)}`);
                }
            }
            await runner.close();

            done += probes.length;
            if (done % 1_000 < probes.length) {
                const rate = done / ((Date.now() - started) / 1000);
                console.log(`  ${done}/${corpus.length} requests (${rate.toFixed(0)}/s)`);
            }
        }

        if (skippedSites > 0) {
            console.log(`  ${skippedSites} origin(s) unusable as a page; their probes are excluded`);
        }

        // Let the last matches reach the collector before reading it.
        await collector.waitForTimeout(1_500);

        const matches = await collector.evaluate(
            () => (globalThis as unknown as {
                __matches: Array<{ url: string; key: string }>;
            }).__matches,
        );
        await collector.close();

        const byUrl = new Map<string, string[]>();
        for (const match of matches) {
            const list = byUrl.get(match.url) ?? [];
            list.push(match.key);
            byUrl.set(match.url, list);
        }

        for (const probe of corpus) {
            if (unusable.has(probe.url)) continue;
            const keys = byUrl.get(probe.url) ?? [];
            const kinds = keys.map((k) => actions.get(k) ?? 'unknown');
            // A redirect counts as neutralised, not as a miss: the original
            // resource never loads, and uBO scores its own $redirect filters
            // as blocks. Counting only `block` understated parity by taking
            // requests we had handled and calling them misses.
            const stopped = kinds.includes('block') || kinds.includes('redirect');
            // An allow rule beats them, exactly as Chrome resolves it.
            const ours = stopped
                && !kinds.includes('allow') && !kinds.includes('allowAllRequests');
            const uboResult = ubo.matchRequest({
                originURL: `http://${probe.initiator}/`,
                url: probe.url,
                type: probe.type,
            });
            // Ask which filter decided, immediately: toLogData reports the
            // last match and nothing else may run in between.
            const filter = uboResult === 1 ? ubo.toLogData()?.raw : undefined;
            verdicts.set(probe.url, { ours, ubo: uboResult === 1, filter });
        }
    } finally {
        await context.close();
        server.close();
        await rm(profile, { recursive: true, force: true });
        await rm(STAGED, { recursive: true, force: true });
    }

    let uboBlocks = 0;
    let weBlock = 0;
    let agreeBlock = 0;
    let missed = 0;
    let over = 0;
    const missedByOrigin: Record<string, number> = {};
    const missedByCause: Record<string, number> = {};
    const overByOrigin: Record<string, number> = {};
    const missedSamples: string[] = [];
    const overSamples: string[] = [];

    for (const probe of corpus) {
        const verdict = verdicts.get(probe.url);
        if (verdict === undefined) continue;
        if (verdict.ubo) uboBlocks += 1;
        if (verdict.ours) weBlock += 1;
        if (verdict.ubo && verdict.ours) agreeBlock += 1;
        if (verdict.ubo && !verdict.ours) {
            missed += 1;
            missedByOrigin[probe.origin] = (missedByOrigin[probe.origin] ?? 0) + 1;
            const cause = classifyMiss(verdict.filter);
            missedByCause[cause] = (missedByCause[cause] ?? 0) + 1;
            if (missedSamples.length < 15) {
                missedSamples.push(`${probe.type} ${probe.url} on ${probe.initiator}\n            filter: ${verdict.filter ?? '?'}`);
            }
        }
        if (!verdict.ubo && verdict.ours) {
            over += 1;
            overByOrigin[probe.origin] = (overByOrigin[probe.origin] ?? 0) + 1;
            if (overSamples.length < 15) overSamples.push(`${probe.type} ${probe.url} on ${probe.initiator}`);
        }
    }

    const notBlockedByUbo = corpus.length - uboBlocks;
    const blockRatio = uboBlocks === 0 ? 0 : agreeBlock / uboBlocks;
    const overRate = notBlockedByUbo === 0 ? 0 : over / notBlockedByUbo;

    console.log('\nAgainst uBlock Origin');
    console.log(`  requests:                ${corpus.length}`);
    console.log(`  uBO blocks:              ${uboBlocks}`);
    console.log(`  we block:                ${weBlock}`);
    console.log(`  we block what uBO does:  ${agreeBlock} (${ratio(agreeBlock, uboBlocks)} of uBO)`);
    console.log(`  uBO blocks, we do not:   ${missed}`);
    console.log(`  we block, uBO does not:  ${over} (${ratio(over, notBlockedByUbo)} of what uBO allows)`);

    if (missed > 0) {
        console.log('\n  misses by cause');
        for (const [cause, count] of Object.entries(missedByCause).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${String(count).padStart(6)}  ${cause}`);
        }
        console.log('\n  misses by corpus origin');
        for (const [origin, count] of Object.entries(missedByOrigin).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${String(count).padStart(6)}  ${origin}`);
        }
        for (const line of missedSamples.slice(0, 5)) console.log(`      miss: ${line}`);
    }
    if (over > 0) {
        console.log('\n  over-blocking by corpus origin');
        for (const [origin, count] of Object.entries(overByOrigin).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${String(count).padStart(6)}  ${origin}`);
        }
        for (const line of overSamples.slice(0, 8)) console.log(`      over: ${line}`);
    }

    await mkdir(dirname(REPORT), { recursive: true });
    await writeFile(REPORT, JSON.stringify({
        corpus: corpus.length, sites: SITES, seed: SEED,
        uboBlocks, weBlock, agreeBlock, missed, over,
        blockRatio, overRate,
        missedByCause, missedByOrigin,
        unreachableFilters: harvested.stats.unreachable,
        networkFilters: harvested.stats.networkFilters,
    }, null, 2), 'utf8');

    const ratioOk = blockRatio >= MIN_BLOCK_RATIO;
    const overOk = overRate <= MAX_OVERBLOCK_RATE;
    console.log(`\n  blocking rate vs uBO: ${(blockRatio * 100).toFixed(2)} % `
        + `(need ≥ ${(MIN_BLOCK_RATIO * 100).toFixed(0)} %) ${ratioOk ? 'OK' : 'FAIL'}`);
    console.log(`  over-blocking:        ${(overRate * 100).toFixed(2)} % `
        + `(need ≤ ${(MAX_OVERBLOCK_RATE * 100).toFixed(0)} %) ${overOk ? 'OK' : 'FAIL'}`);

    console.log(`\n${ratioOk && overOk ? 'PARITY PASSED' : 'PARITY FAILED'}`);
    if (!ratioOk || !overOk) process.exitCode = 1;
}

await main();
