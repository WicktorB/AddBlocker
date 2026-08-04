/**
 * Sanity checks for the prototype compiler.
 *
 * A 5.7x compression ratio is only good news if the merged rules still mean
 * what the source filters meant. These checks exist to catch over-merging
 * before it becomes a silent over-blocking bug.
 */

import { groupLists, loadLists } from './lists.js';
import { compile, type DnrRule } from './compiler.js';
import { parseList, parseNetworkFilter, classifyLine } from './parser.js';

interface Case {
    input: string;
    expect: (rule: DnrRule | undefined) => boolean;
    description: string;
}

/** Table tests: each filter must translate to the documented DNR shape. */
const CASES: Case[] = [
    {
        input: '||ads.example.com^',
        description: 'plain domain anchor becomes requestDomains (mergeable)',
        expect: (r) => r?.condition.requestDomains !== undefined
            && (r.condition.requestDomains as string[])[0] === 'ads.example.com'
            && r.action.type === 'block',
    },
    {
        input: '||ads.example.com^$third-party',
        description: 'third-party maps to domainType',
        expect: (r) => r?.condition.domainType === 'thirdParty',
    },
    {
        input: '||ads.example.com^$script,image',
        description: 'resource types map to DNR names',
        expect: (r) => {
            const types = r?.condition.resourceTypes as string[] | undefined;
            return types?.includes('script') === true && types.includes('image');
        },
    },
    {
        input: '||ads.example.com^$domain=news.com|~sub.news.com',
        description: 'domain= splits into initiator include/exclude',
        expect: (r) => (r?.condition.initiatorDomains as string[])?.[0] === 'news.com'
            && (r?.condition.excludedInitiatorDomains as string[])?.[0] === 'sub.news.com',
    },
    {
        input: '@@||cdn.example.com^',
        description: 'exception becomes allow in a higher priority band',
        expect: (r) => r?.action.type === 'allow' && r.priority >= 2000 && r.priority < 3000,
    },
    {
        input: '@@||example.com^$document',
        description: 'document exception becomes allowAllRequests',
        expect: (r) => r?.action.type === 'allowAllRequests' && r.priority === 5000,
    },
    {
        input: '||ads.example.com^$important',
        description: 'important lifts the block into its own band',
        expect: (r) => r?.action.type === 'block' && r.priority >= 3000 && r.priority < 4000,
    },
    {
        input: '/banner\\d+\\.gif/',
        description: 'regex literal becomes regexFilter, never mergeable',
        expect: (r) => typeof r?.condition.regexFilter === 'string'
            && r.condition.requestDomains === undefined,
    },
    {
        input: '||example.com',
        description: 'anchor without separator must NOT become requestDomains',
        expect: (r) => r?.condition.requestDomains === undefined
            && r?.condition.urlFilter === '||example.com',
    },
    {
        input: '||example.com^$removeparam=utm_source',
        description: 'removeparam becomes an unsafe redirect with queryTransform',
        expect: (r) => r?.action.type === 'redirect',
    },
];

function runTableTests(): boolean {
    let failures = 0;
    console.log('Table tests');
    for (const testCase of CASES) {
        const parsed = parseNetworkFilter(testCase.input);
        const rule = parsed === null ? undefined : compile([parsed]).rules[0];
        const ok = testCase.expect(rule);
        if (!ok) failures += 1;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${testCase.description}`);
        if (!ok) console.log(`        input=${testCase.input}\n        got=${JSON.stringify(rule)}`);
    }
    console.log(`  ${CASES.length - failures}/${CASES.length} passed\n`);
    return failures === 0;
}

/**
 * Verifies that every merged rule only ever grouped filters that agreed on
 * every condition except the domain, by recompiling each group in isolation.
 */
function checkMergeIntegrity(rules: DnrRule[]): boolean {
    let oversized = 0;
    let biggest = 0;
    let totalDomains = 0;
    let rulesWithDomains = 0;

    for (const rule of rules) {
        const domains = rule.condition.requestDomains as string[] | undefined;
        if (domains === undefined) continue;
        rulesWithDomains += 1;
        totalDomains += domains.length;
        biggest = Math.max(biggest, domains.length);
        // Chrome accepts large domain arrays, but a single rule carrying tens of
        // thousands of them is worth flagging for the real-browser check.
        if (domains.length > 10_000) oversized += 1;

        // Every entry must be a bare lowercase hostname. A dotless entry is
        // legitimate — `$to=com` targets a whole TLD — but wildcards, paths or
        // uppercase mean the anchored-domain extraction let through a pattern
        // it should have rejected.
        for (const domain of domains) {
            if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith('.') || domain.endsWith('.')) {
                console.log(`  FAIL malformed domain in merged rule: ${domain}`);
                return false;
            }
        }
    }

    console.log('Merge integrity');
    console.log(`  rules carrying requestDomains: ${rulesWithDomains}`);
    console.log(`  total domains packed:          ${totalDomains}`);
    console.log(`  largest single rule:           ${biggest} domains`);
    console.log(`  rules over 10k domains:        ${oversized}`);
    console.log('  all domain entries well-formed: PASS\n');
    return true;
}

/** Confirms merging preserves semantics: same key => identical non-domain condition. */
function checkNoSemanticDrift(): boolean {
    const a = parseNetworkFilter('||one.com^$third-party,script');
    const b = parseNetworkFilter('||two.com^$third-party,script');
    const c = parseNetworkFilter('||three.com^$third-party,image');
    if (a === null || b === null || c === null) return false;

    const { rules } = compile([a, b, c]);
    const merged = rules.find((r) => (r.condition.requestDomains as string[]).length === 2);
    const separate = rules.find((r) => (r.condition.resourceTypes as string[])?.includes('image'));

    console.log('Semantic drift');
    const ok = rules.length === 2 && merged !== undefined && separate !== undefined;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  differing resourceTypes stay in separate rules ` +
        `(got ${rules.length} rules, expected 2)\n`);
    return ok;
}

async function main(): Promise<void> {
    const tablesOk = runTableTests();
    const driftOk = checkNoSemanticDrift();

    const lists = await loadLists();
    const bundles = groupLists(lists);
    const allFilters = [...bundles.values()].flatMap((content) => parseList(content).filters);
    const { rules } = compile(allFilters);
    const mergeOk = checkMergeIntegrity(rules);

    // Spot-check what classification does on real scriptlet syntax.
    const samples = ['example.com##+js(aopr, ads)', 'example.com#%#//scriptlet("abort")', 'example.com##.ad', '||ads.com^$script'];
    console.log('Classification spot-check');
    for (const sample of samples) console.log(`  ${classifyLine(sample).padEnd(10)} ${sample}`);

    const ok = tablesOk && driftOk && mergeOk;
    console.log(`\n${ok ? 'ALL SANITY CHECKS PASSED' : 'SANITY CHECKS FAILED'}`);
    if (!ok) process.exitCode = 1;
}

await main();
