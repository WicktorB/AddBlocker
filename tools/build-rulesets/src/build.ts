/**
 * Builds the extension's static rulesets from the upstream filter lists.
 *
 * The build fails rather than shipping something Chrome would reject: quota
 * overruns and invalid rules are errors, not warnings. Chrome's own failure
 * mode is to silently disable an entire ruleset, so it must be caught here.
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseList } from '@addblocker/filter-parser';
import { compile, validateRuleset } from '@addblocker/dnr-compiler';

import { QUOTAS, RULESETS, type Ruleset } from './catalog.js';
import { buildCosmetic, type ContentScriptEntry } from './cosmetic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CACHE_DIR = join(ROOT, '.filter-cache');
const OUT_DIR = join(ROOT, 'dist', 'extension');

async function fetchWithRetry(url: string, attempts = 4): Promise<string> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i += 1) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (err) {
            lastError = err;
            await new Promise((r) => { setTimeout(r, 2 ** i * 1000); });
        }
    }
    throw new Error(`failed to fetch ${url}: ${String(lastError)}`);
}

/** Loads a list from cache, downloading it once if absent. */
async function loadSource(id: string, url: string): Promise<string> {
    const cached = join(CACHE_DIR, `${id}.txt`);
    if (existsSync(cached)) return readFile(cached, 'utf8');

    const text = await fetchWithRetry(url);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cached, text, 'utf8');
    return text;
}

interface BuiltRuleset {
    ruleset: Ruleset;
    ruleCount: number;
    regexCount: number;
    unsafeCount: number;
    networkFilters: number;
    cosmeticFilters: number;
    scriptletFilters: number;
    unconvertible: number;
    cosmeticScoped: number;
    compression: number;
}

/** Raw list text, kept so the cosmetic build reuses the same downloads. */
const rawLists: string[] = [];

async function buildRuleset(ruleset: Ruleset): Promise<BuiltRuleset | null> {
    const contents: string[] = [];
    for (const source of ruleset.sources) {
        try {
            contents.push(await loadSource(source.id, source.url));
        } catch (err) {
            // A list that disappears upstream should not sink the whole build,
            // but it must be loud.
            console.warn(`  ! ${source.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (contents.length === 0) {
        console.warn(`  ! ${ruleset.id}: no sources available, skipped`);
        return null;
    }

    rawLists.push(...contents);
    const { filters, stats: parseStats } = parseList(contents.join('\n'));
    const { rules, stats, sourceMap } = compile(filters);

    const broken = validateRuleset(rules);
    if (broken.length > 0) {
        console.error(`\n  ${ruleset.id}: ${broken.length} invalid rule(s) — Chrome would reject this ruleset`);
        for (const { rule, problems } of broken.slice(0, 5)) {
            console.error(`    rule ${rule.id}: ${problems.join('; ')}`);
            console.error(`      ${JSON.stringify(rule).slice(0, 200)}`);
        }
        throw new Error(`ruleset ${ruleset.id} failed validation`);
    }

    if (stats.regexRules > QUOTAS.maxRegexRules) {
        throw new Error(`ruleset ${ruleset.id} uses ${stats.regexRules} regex rules, over the ${QUOTAS.maxRegexRules} limit`);
    }

    await writeFile(join(OUT_DIR, 'rules', `${ruleset.id}.json`), JSON.stringify(rules), 'utf8');

    // The source map is what makes a blocked request explainable later.
    await writeFile(
        join(OUT_DIR, 'sourcemaps', `${ruleset.id}.json`),
        JSON.stringify(Object.fromEntries(sourceMap)),
        'utf8',
    );

    return {
        ruleset,
        ruleCount: rules.length,
        regexCount: stats.regexRules,
        unsafeCount: stats.unsafeRules,
        networkFilters: parseStats.network,
        cosmeticFilters: parseStats.cosmetic,
        scriptletFilters: parseStats.scriptlet,
        unconvertible: stats.unconvertible,
        cosmeticScoped: stats.cosmeticScoped,
        compression: stats.rulesBeforeMerge / Math.max(rules.length, 1),
    };
}

function writeManifest(built: BuiltRuleset[], contentScripts: ContentScriptEntry[]): Promise<void> {
    const manifest = {
        manifest_version: 3,
        name: 'AddBlocker',
        version: '0.1.0',
        description: 'Bloqueur de publicités Manifest V3',
        permissions: [
            'declarativeNetRequest',
            // Available to unpacked extensions only; gives exact block counts.
            'declarativeNetRequestFeedback',
            'storage',
            'scripting',
        ],
        host_permissions: ['<all_urls>'],
        background: { service_worker: 'sw.js' },
        declarative_net_request: {
            rule_resources: built.map(({ ruleset }) => ({
                id: ruleset.id,
                enabled: ruleset.enabledByDefault,
                path: `rules/${ruleset.id}.json`,
            })),
        },
        content_scripts: contentScripts,
    };

    return writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

async function main(): Promise<void> {
    await rm(OUT_DIR, { recursive: true, force: true });
    await mkdir(join(OUT_DIR, 'rules'), { recursive: true });
    await mkdir(join(OUT_DIR, 'sourcemaps'), { recursive: true });

    console.log('Building rulesets\n');
    const built: BuiltRuleset[] = [];
    for (const ruleset of RULESETS) {
        const result = await buildRuleset(ruleset);
        if (result === null) continue;
        built.push(result);
        console.log(`  ${result.ruleset.id.padEnd(14)} ${String(result.ruleCount).padStart(6)} rules  ` +
            `(${result.compression.toFixed(1)}x)  regex=${result.regexCount}  ` +
            `${result.ruleset.enabledByDefault ? 'on' : 'off'} by default`);
    }

    console.log('\nBuilding cosmetic filtering');
    const cosmetic = await buildCosmetic(rawLists, OUT_DIR);
    console.log(`  ${cosmetic.stats.domains} domains in ${cosmetic.stats.buckets} buckets, ` +
        `${cosmetic.stats.specificPairs} site-specific selectors`);
    console.log(`  ${cosmetic.stats.genericSelectors} generic, ` +
        `${cosmetic.stats.proceduralSelectors} procedural, ${cosmetic.stats.exceptions} exceptions`);
    console.log(`  skipped: ${cosmetic.stats.skipped} (generic selectors carrying domain exclusions)`);
    console.log(`  payload: runtime ${(cosmetic.stats.runtimeBytes / 1024).toFixed(0)}kB, ` +
        `generic ${(cosmetic.stats.genericBytes / 1024).toFixed(0)}kB, ` +
        `buckets ${(cosmetic.stats.bucketBytes / 1024).toFixed(0)}kB total`);
    console.log(`  patterns: ${cosmetic.stats.manifestPatterns} in the manifest, ` +
        `${cosmetic.stats.dynamicPatterns} registered dynamically (adr/0002)`);

    await writeManifest(built, cosmetic.contentScripts);
    await cp(join(dirname(fileURLToPath(import.meta.url)), 'sw.js'), join(OUT_DIR, 'sw.js'));

    const enabled = built.filter((b) => b.ruleset.enabledByDefault);
    const enabledRules = enabled.reduce((n, b) => n + b.ruleCount, 0);
    const totalRules = built.reduce((n, b) => n + b.ruleCount, 0);
    const networkFilters = built.reduce((n, b) => n + b.networkFilters, 0);
    const unconvertible = built.reduce((n, b) => n + b.unconvertible, 0);
    const cosmeticScoped = built.reduce((n, b) => n + b.cosmeticScoped, 0);
    const cosmeticFilters = built.reduce((n, b) => n + b.cosmeticFilters, 0);
    const scriptlets = built.reduce((n, b) => n + b.scriptletFilters, 0);
    const regex = built.reduce((n, b) => n + b.regexCount, 0);

    const unconvertibleRate = (100 * unconvertible) / Math.max(networkFilters, 1);

    console.log('\nTotals');
    console.log(`  network filters in:     ${networkFilters}`);
    console.log(`  rules out:              ${totalRules} (${enabledRules} enabled by default)`);
    console.log(`  unconvertible:          ${unconvertible} (${unconvertibleRate.toFixed(2)}%)`);
    console.log(`  cosmetic-scoped:        ${cosmeticScoped} (handled by the cosmetic engine)`);
    console.log(`  regex used:             ${regex} / ${QUOTAS.maxRegexRules}`);
    console.log(`  rulesets:               ${built.length} / ${QUOTAS.maxStaticRulesets}`);
    console.log(`  cosmetic filters:       ${cosmeticFilters}`);
    console.log(`  scriptlet filters:      ${scriptlets} (phase 3)`);

    console.log('\nQuota');
    const withinGuaranteed = enabledRules <= QUOTAS.guaranteedStaticRules;
    console.log(`  enabled rules vs guaranteed minimum: ${enabledRules} / ${QUOTAS.guaranteedStaticRules} ` +
        `(${((100 * enabledRules) / QUOTAS.guaranteedStaticRules).toFixed(1)}%) ${withinGuaranteed ? 'OK' : 'OVER'}`);
    console.log(`  all rules vs global pool:            ${totalRules} / ${QUOTAS.globalStaticRulePool} ` +
        `(${((100 * totalRules) / QUOTAS.globalStaticRulePool).toFixed(1)}%)`);

    const failures: string[] = [];
    if (!withinGuaranteed) {
        failures.push(`default-enabled rulesets need ${enabledRules} rules, over the guaranteed ${QUOTAS.guaranteedStaticRules}`);
    }
    if (built.length > QUOTAS.maxStaticRulesets) {
        failures.push(`${built.length} rulesets declared, over the ${QUOTAS.maxStaticRulesets} limit`);
    }
    if (unconvertibleRate > 3) {
        failures.push(`${unconvertibleRate.toFixed(2)}% of network filters unconvertible, over the 3% target`);
    }

    if (failures.length > 0) {
        console.error('\nBuild failed:');
        for (const failure of failures) console.error(`  - ${failure}`);
        process.exitCode = 1;
        return;
    }

    console.log(`\nExtension written to ${OUT_DIR}`);
}

await main();
