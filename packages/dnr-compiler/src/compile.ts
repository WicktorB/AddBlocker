import type { NetworkFilter } from '@addblocker/filter-parser';
import { UNSAFE_ACTIONS, translate } from './translate.js';
import { unconvertibleReason } from './validate.js';
import type { CompileResult, CompileStats, DnrRule } from './types.js';

/** Canonical key for `$badfilter` matching: same pattern, same options. */
function badfilterKey(filter: NetworkFilter): string {
    const o = filter.options;
    return [
        filter.isException ? '@@' : '',
        filter.pattern,
        [...o.resourceTypes].sort().join(','),
        o.thirdParty === null ? '' : String(o.thirdParty),
        [...o.domains].sort().join(','),
    ].join('|');
}

/**
 * Merge key: everything about a rule except the domains it carries.
 *
 * Rules sharing a key collapse into one rule with a merged `requestDomains`
 * array. This is the optimisation that makes the standard lists fit — 5.7x
 * fewer rules overall, 21x on EasyList.
 */
function mergeKey(rule: DnrRule): string | null {
    const { requestDomains, ...rest } = rule.condition;
    if (requestDomains === undefined) return null;
    // Unsafe actions carry per-rule payloads that must not be shared.
    if (UNSAFE_ACTIONS.has(rule.action.type)) return null;
    return JSON.stringify([rule.priority, rule.action.type, rest]);
}

function emptyStats(inputFilters: number): CompileStats {
    return {
        inputFilters,
        cosmeticScoped: 0,
        unconvertible: 0,
        unconvertibleReasons: {},
        badfilterRemoved: 0,
        rulesBeforeMerge: 0,
        rulesAfterMerge: 0,
        regexRules: 0,
        unsafeRules: 0,
        mergedGroups: 0,
        tldExpanded: 0,
    };
}

export function compile(filters: NetworkFilter[]): CompileResult {
    const stats = emptyStats(filters.length);

    // 1. Resolve $badfilter at compile time — free at runtime.
    const badfilters = new Set<string>();
    for (const filter of filters) {
        if (filter.options.badfilter) badfilters.add(badfilterKey(filter));
    }

    const usable: NetworkFilter[] = [];
    for (const filter of filters) {
        if (filter.options.badfilter) continue;

        if (badfilters.has(badfilterKey(filter))) {
            stats.badfilterRemoved += 1;
            continue;
        }

        // Cosmetic-scoped filters are not network rules; they belong to the
        // cosmetic engine and must not count as conversion failures.
        if (filter.options.cosmeticScope.length > 0 && filter.options.unsupported.length === 0) {
            stats.cosmeticScoped += 1;
            continue;
        }

        const reason = unconvertibleReason(filter);
        if (reason !== null) {
            stats.unconvertible += 1;
            stats.unconvertibleReasons[reason] = (stats.unconvertibleReasons[reason] ?? 0) + 1;
            continue;
        }

        usable.push(filter);
    }

    // 2. Translate, keeping each rule tied to the filter that made it.
    const translated: Array<{ rule: DnrRule; source: string }> = [];
    for (const filter of usable) {
        const { rule, didExpand } = translate(filter);
        if (didExpand) stats.tldExpanded += 1;
        translated.push({ rule, source: filter.raw });
    }
    stats.rulesBeforeMerge = translated.length;

    // 3. Deduplicate identical rules, remembering every source filter.
    const unique = new Map<string, { rule: DnrRule; sources: string[] }>();
    for (const { rule, source } of translated) {
        const key = JSON.stringify([rule.priority, rule.action, rule.condition]);
        const existing = unique.get(key);
        if (existing === undefined) unique.set(key, { rule, sources: [source] });
        else existing.sources.push(source);
    }

    // 4. Merge domain-only rules that agree on everything else.
    const groups = new Map<string, { rule: DnrRule; domains: Set<string>; sources: string[] }>();
    const standalone: Array<{ rule: DnrRule; sources: string[] }> = [];

    for (const entry of unique.values()) {
        const key = mergeKey(entry.rule);
        if (key === null) {
            standalone.push(entry);
            continue;
        }

        const domains = entry.rule.condition.requestDomains ?? [];
        const group = groups.get(key);
        if (group === undefined) {
            groups.set(key, { rule: entry.rule, domains: new Set(domains), sources: [...entry.sources] });
        } else {
            for (const domain of domains) group.domains.add(domain);
            group.sources.push(...entry.sources);
        }
    }

    const assembled: Array<{ rule: DnrRule; sources: string[] }> = [];
    for (const group of groups.values()) {
        if (group.domains.size > 1) stats.mergedGroups += 1;
        assembled.push({
            rule: { ...group.rule, condition: { ...group.rule.condition, requestDomains: [...group.domains].sort() } },
            sources: group.sources,
        });
    }
    assembled.push(...standalone);

    const rules: DnrRule[] = [];
    const sourceMap = new Map<number, string[]>();
    assembled.forEach((entry, index) => {
        const id = index + 1;
        rules.push({ ...entry.rule, id });
        sourceMap.set(id, entry.sources);
    });

    stats.rulesAfterMerge = rules.length;
    stats.regexRules = rules.filter((r) => r.condition.regexFilter !== undefined).length;
    stats.unsafeRules = rules.filter((r) => UNSAFE_ACTIONS.has(r.action.type)).length;

    return { rules, stats, sourceMap };
}
