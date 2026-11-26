/**
 * Builds the extension's static rulesets from the upstream filter lists.
 *
 * The build fails rather than shipping something Chrome would reject: quota
 * overruns and invalid rules are errors, not warnings. Chrome's own failure
 * mode is to silently disable an entire ruleset, so it must be caught here.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTENSION_ENV, parseList, preprocess } from '@addblocker/filter-parser';
import { compile, validateRuleset } from '@addblocker/dnr-compiler';

import { QUOTAS, RULESETS, type Ruleset } from './catalog.js';
import { buildCosmetic, type ContentScriptEntry } from './cosmetic.js';
import { buildScriptlets, isTrustedSource, type ScriptletSource } from './scriptlets.js';
import { buildUi } from './ui.js';
import { buildStamp, type BuildStamp } from '../../shared/version.js';

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

/** List text after preprocessing, kept so the cosmetic build reuses it. */
const rawLists: string[] = [];

/** The same text, with what the scriptlet build needs to know of its origin. */
const scriptletSources: ScriptletSource[] = [];

/** What resolving the `!#if` directives removed, for the build report. */
const directives = { blocks: 0, droppedLines: 0, malformed: 0 };

async function buildRuleset(ruleset: Ruleset): Promise<BuiltRuleset | null> {
    const contents: string[] = [];
    const trusted: boolean[] = [];
    for (const source of ruleset.sources) {
        try {
            contents.push(await loadSource(source.id, source.url));
            trusted.push(isTrustedSource(source.id));
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

    // Resolve `!#if` blocks before anything is parsed, so the network, cosmetic
    // and scriptlet compilers all work from the same lines — the ones meant
    // for this environment, not every branch at once.
    for (let i = 0; i < contents.length; i += 1) {
        const resolved = preprocess(contents[i], EXTENSION_ENV);
        contents[i] = resolved.text;
        directives.blocks += resolved.blocks;
        directives.droppedLines += resolved.droppedLines;
        directives.malformed += resolved.malformed;
    }

    rawLists.push(...contents);
    contents.forEach((text, i) => scriptletSources.push({ text, trusted: trusted[i] }));
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

/** GitHub repository the extension compares itself against. */
const REPOSITORY = 'WicktorB/AddBlocker';

/**
 * When the lists in the cache were downloaded — the oldest of them, since a
 * build is only as fresh as its stalest list.
 */
async function listsFetchedAt(): Promise<string | null> {
    let oldest: number | null = null;
    for (const file of await readdir(CACHE_DIR)) {
        if (!file.endsWith('.txt')) continue;
        const { mtimeMs } = await stat(join(CACHE_DIR, file));
        if (oldest === null || mtimeMs < oldest) oldest = mtimeMs;
    }
    return oldest === null ? null : new Date(oldest).toISOString();
}

/**
 * Writes what the extension knows about itself.
 *
 * The popup and the options page read this to show which build is running,
 * when it was made and how old its lists are — the questions someone asks
 * before trusting that what they loaded is current. The manifest carries the
 * version too, but nothing else: it has no field for a date or a commit.
 */
async function writeBuildInfo(stamp: BuildStamp, built: BuiltRuleset[]): Promise<void> {
    const info = {
        ...stamp,
        repository: REPOSITORY,
        listsFetchedAt: await listsFetchedAt(),
        rules: built.reduce((n, b) => n + b.ruleCount, 0),
        rulesets: Object.fromEntries(built.map((b) => [b.ruleset.id, {
            title: b.ruleset.title,
            rules: b.ruleCount,
        }])),
    };
    await writeFile(join(OUT_DIR, 'build-info.json'), JSON.stringify(info, null, 2), 'utf8');
}

function writeManifest(
    built: BuiltRuleset[], contentScripts: ContentScriptEntry[], stamp: BuildStamp,
): Promise<void> {
    const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };
    const manifest = {
        manifest_version: 3,
        name: 'AddBlocker',
        // The build time as `YYYY.MMDD.HHmm` — see tools/shared/version.ts.
        version: stamp.version,
        version_name: `${stamp.version}${stamp.commit === '' ? '' : ` (${stamp.commit}${stamp.dirty ? ', modifié' : ''})`}`,
        icons,
        description: 'Bloqueur de publicités Manifest V3',
        permissions: [
            'declarativeNetRequest',
            // Available to unpacked extensions only; gives exact block counts.
            'declarativeNetRequestFeedback',
            'storage',
            'scripting',
            'tabs',
            'webNavigation',
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
        // Empty in practice: everything is registered dynamically so it can be
        // switched off per site. Kept so a script that must run before the
        // worker wakes can be declared here if one ever needs to.
        ...(contentScripts.length > 0 ? { content_scripts: contentScripts } : {}),
        action: {
            default_popup: 'popup.html',
            default_title: 'AddBlocker',
            default_icon: icons,
        },
        options_ui: {
            page: 'options.html',
            open_in_tab: true,
        },
        // Injected on demand by the popup, so it must be reachable.
        web_accessible_resources: [{
            resources: ['picker.js'],
            matches: ['<all_urls>'],
        }],
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

    console.log(`\n  directives: ${directives.blocks} conditional block(s), ` +
        `${directives.droppedLines} line(s) left out as not meant for this environment` +
        (directives.malformed > 0 ? `, ${directives.malformed} unparseable` : ''));

    console.log('\nBuilding cosmetic filtering');
    const cosmetic = await buildCosmetic(rawLists, OUT_DIR);
    console.log(`  ${cosmetic.stats.domains} domains in ${cosmetic.stats.buckets} buckets, ` +
        `${cosmetic.stats.specificPairs} site-specific selectors`);
    console.log(`  ${cosmetic.stats.genericSelectors} generic, ` +
        `${cosmetic.stats.proceduralSelectors} procedural, ${cosmetic.stats.exceptions} exceptions`);
    console.log(`  skipped: ${cosmetic.stats.skipped} (generic selectors carrying domain exclusions)`);
    console.log(`  gated: ${cosmetic.stats.gatedSelectors} generic selector(s) held back until their anchor exists`);
    console.log(`  generic exceptions: ${cosmetic.stats.genericExceptionPairs} on ` +
        `${cosmetic.stats.genericExceptionDomains} site(s), served the scripted sheet`);
    console.log(`  payload: runtime ${(cosmetic.stats.runtimeBytes / 1024).toFixed(0)}kB, ` +
        `generic sheet ${(cosmetic.stats.genericBytes / 1024).toFixed(0)}kB ` +
        `(+ ${cosmetic.stats.genericDynamicBytes} bytes of script), ` +
        `buckets ${(cosmetic.stats.bucketBytes / 1024).toFixed(0)}kB total`);
    console.log(`  patterns: ${cosmetic.stats.manifestPatterns} in the manifest, ` +
        `${cosmetic.stats.dynamicPatterns} registered dynamically (adr/0002)`);

    console.log('\nBuilding scriptlets');
    const scriptlets = await buildScriptlets(scriptletSources, OUT_DIR);
    console.log(`  ${scriptlets.stats.domains} domains in ${scriptlets.stats.buckets} buckets, ` +
        `${scriptlets.stats.invocations} invocations`);
    console.log(`  exceptions: ${scriptlets.stats.exceptions}, ` +
        `generic skipped: ${scriptlets.stats.genericSkipped}, ` +
        `trusted-only refused from third-party lists: ${scriptlets.stats.untrustedDropped}`);
    const isolated = scriptlets.registrations.filter((r) => r.world === 'ISOLATED').length;
    console.log(`  worlds: ${scriptlets.registrations.length - isolated} bucket(s) in the page's, ` +
        `${isolated} in the isolated one`);
    console.log(`  payload: runtime ${(scriptlets.stats.runtimeBytes / 1024).toFixed(0)}kB, ` +
        `buckets ${(scriptlets.stats.bucketBytes / 1024).toFixed(0)}kB total`);

    const unknown = Object.entries(scriptlets.stats.unknownByName).sort((a, b) => b[1] - a[1]);
    if (unknown.length > 0) {
        const dropped = scriptlets.stats.unknownScriptlets;
        const covered = scriptlets.stats.invocations;
        console.log(`  not in the catalogue: ${dropped} invocation(s) across ${unknown.length} scriptlet(s) ` +
            `— ${((100 * covered) / (covered + dropped)).toFixed(1)}% coverage`);
        for (const [name, count] of unknown.slice(0, 12)) console.log(`    ${String(count).padStart(4)}  ${name}`);
    }

    // Cosmetic buckets run in the isolated world, scriptlets in the page's own.
    const registrations = [...cosmetic.registrations, ...scriptlets.registrations];
    const registrationsJson = JSON.stringify(registrations);
    await writeFile(join(OUT_DIR, 'cosmetic', 'registrations.json'), registrationsJson, 'utf8');
    const buildId = createHash('sha256').update(registrationsJson).digest('hex').slice(0, 16);

    console.log('\nBuilding UI');
    const ui = await buildUi(OUT_DIR, buildId);
    console.log(`  service worker ${(ui.workerBytes / 1024).toFixed(0)}kB, ` +
        `${ui.assets.length} assets (popup, options, picker)`);

    // The generated userscripts are rewritten by their own build and do not
    // make this one "modified".
    const stamp = buildStamp(ROOT, new Date(), ['userscript']);
    await writeManifest(built, cosmetic.contentScripts, stamp);
    await writeBuildInfo(stamp, built);
    console.log(`\nVersion ${stamp.version}` +
        `${stamp.commit === '' ? '' : ` — commit ${stamp.commit}${stamp.dirty ? ' + local changes' : ''}`}`);

    const enabled = built.filter((b) => b.ruleset.enabledByDefault);
    const enabledRules = enabled.reduce((n, b) => n + b.ruleCount, 0);
    const totalRules = built.reduce((n, b) => n + b.ruleCount, 0);
    const networkFilters = built.reduce((n, b) => n + b.networkFilters, 0);
    const unconvertible = built.reduce((n, b) => n + b.unconvertible, 0);
    const cosmeticScoped = built.reduce((n, b) => n + b.cosmeticScoped, 0);
    const cosmeticFilters = built.reduce((n, b) => n + b.cosmeticFilters, 0);
    const scriptletFilters = built.reduce((n, b) => n + b.scriptletFilters, 0);
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
    console.log(`  scriptlet filters:      ${scriptletFilters}`);

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
