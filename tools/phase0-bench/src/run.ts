/**
 * Phase 0 benchmark: can the standard filter lists fit inside Chrome's static
 * DNR quota, and should we build the compiler or reuse AdGuard's?
 *
 * Usage: pnpm bench
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { groupLists, loadLists } from './lists.js';
import { parseList } from './parser.js';
import { compile } from './compiler.js';
import { convertWithAdguard, type AdguardResult } from './bench-adguard.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

/** Chrome's guaranteed static rule allowance for a single extension. */
const GUARANTEED_MINIMUM_STATIC_RULES = 30_000;
/** Shared pool across all installed extensions, first-come first-served. */
const GLOBAL_STATIC_RULE_POOL = 330_000;
const MAX_REGEX_RULES = 1_000;

interface BundleReport {
    bundle: string;
    lines: number;
    networkFilters: number;
    cosmeticFilters: number;
    scriptletFilters: number;
    mine: ReturnType<typeof compile>['stats'] & { durationMs: number };
    adguard: AdguardResult | { error: string };
}

function pct(value: number, total: number): string {
    if (total === 0) return '0%';
    return `${((value / total) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
    console.log('Loading filter lists…');
    const lists = await loadLists();
    const bundles = groupLists(lists);
    const reports: BundleReport[] = [];

    for (const [name, content] of bundles) {
        console.log(`\n=== ${name} ===`);
        const { filters, stats: parseStats } = parseList(content);
        console.log(`  lines=${parseStats.total} network=${parseStats.network} cosmetic=${parseStats.cosmetic} scriptlet=${parseStats.scriptlet}`);

        const started = Date.now();
        const { stats: mineStats } = compile(filters);
        const mineDuration = Date.now() - started;

        console.log(`  [mine]    ${mineStats.rulesBeforeMerge} -> ${mineStats.rulesAfterMerge} rules ` +
            `(merge factor ${(mineStats.rulesBeforeMerge / Math.max(mineStats.rulesAfterMerge, 1)).toFixed(2)}x, ${mineDuration}ms)`);
        console.log(`            unconvertible=${mineStats.unconvertible} badfilter=${mineStats.badfilterRemoved} ` +
            `regex=${mineStats.regexRules} unsafe=${mineStats.unsafeRules}`);

        let adguard: AdguardResult | { error: string };
        try {
            adguard = await convertWithAdguard(reports.length + 1, content, GLOBAL_STATIC_RULE_POOL);
            console.log(`  [adguard] ${adguard.rules} rules (${adguard.durationMs}ms) ` +
                `errors=${adguard.errors} limitations=${adguard.limitations} ` +
                `regex=${adguard.regexRules} unsafe=${adguard.unsafeRules}`);
        } catch (err) {
            adguard = { error: err instanceof Error ? err.message : String(err) };
            console.log(`  [adguard] FAILED: ${adguard.error}`);
        }

        reports.push({
            bundle: name,
            lines: parseStats.total,
            networkFilters: parseStats.network,
            cosmeticFilters: parseStats.cosmetic,
            scriptletFilters: parseStats.scriptlet,
            mine: { ...mineStats, durationMs: mineDuration },
            adguard,
        });
    }

    // Combined view: what actually ships is all bundles at once.
    const totals = reports.reduce(
        (acc, r) => ({
            network: acc.network + r.networkFilters,
            cosmetic: acc.cosmetic + r.cosmeticFilters,
            scriptlet: acc.scriptlet + r.scriptletFilters,
            mineRules: acc.mineRules + r.mine.rulesAfterMerge,
            mineBefore: acc.mineBefore + r.mine.rulesBeforeMerge,
            mineRegex: acc.mineRegex + r.mine.regexRules,
            mineUnsafe: acc.mineUnsafe + r.mine.unsafeRules,
            mineUnconvertible: acc.mineUnconvertible + r.mine.unconvertible,
            adguardRules: acc.adguardRules + ('rules' in r.adguard ? r.adguard.rules : 0),
            adguardRegex: acc.adguardRegex + ('regexRules' in r.adguard ? r.adguard.regexRules : 0),
            adguardErrors: acc.adguardErrors + ('errors' in r.adguard ? r.adguard.errors : 0),
        }),
        {
            network: 0, cosmetic: 0, scriptlet: 0,
            mineRules: 0, mineBefore: 0, mineRegex: 0, mineUnsafe: 0, mineUnconvertible: 0,
            adguardRules: 0, adguardRegex: 0, adguardErrors: 0,
        },
    );

    console.log('\n================ TOTALS ================');
    console.log(`network filters in:      ${totals.network}`);
    console.log(`cosmetic filters:        ${totals.cosmetic}`);
    console.log(`scriptlet filters:       ${totals.scriptlet}`);
    console.log(`[mine]    rules out:     ${totals.mineRules}  (from ${totals.mineBefore} unmerged, ` +
        `${(totals.mineBefore / Math.max(totals.mineRules, 1)).toFixed(2)}x compression)`);
    console.log(`[adguard] rules out:     ${totals.adguardRules}`);
    console.log(`[mine]    unconvertible: ${totals.mineUnconvertible} (${pct(totals.mineUnconvertible, totals.network)})`);
    console.log(`[adguard] errors:        ${totals.adguardErrors} (${pct(totals.adguardErrors, totals.network)})`);
    console.log(`regex budget (max ${MAX_REGEX_RULES}): mine=${totals.mineRegex} adguard=${totals.adguardRegex}`);
    console.log(`\nQuota check (guaranteed ${GUARANTEED_MINIMUM_STATIC_RULES}):`);
    console.log(`  mine:    ${totals.mineRules <= GUARANTEED_MINIMUM_STATIC_RULES ? 'FITS' : 'OVER'} ` +
        `(${pct(totals.mineRules, GUARANTEED_MINIMUM_STATIC_RULES)} of guaranteed, ` +
        `${pct(totals.mineRules, GLOBAL_STATIC_RULE_POOL)} of global pool)`);
    console.log(`  adguard: ${totals.adguardRules <= GUARANTEED_MINIMUM_STATIC_RULES ? 'FITS' : 'OVER'} ` +
        `(${pct(totals.adguardRules, GUARANTEED_MINIMUM_STATIC_RULES)} of guaranteed, ` +
        `${pct(totals.adguardRules, GLOBAL_STATIC_RULE_POOL)} of global pool)`);

    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify({ reports, totals }, null, 2), 'utf8');
    console.log(`\nReport written to ${join(OUT_DIR, 'report.json')}`);
}

await main();
