/**
 * Prototype DNR compiler.
 *
 * The point of phase 0 is to measure whether an optimising compiler can fit the
 * standard filter lists inside Chrome's static rule quota. The optimisation
 * that matters is domain merging: thousands of `||tracker.com^` filters share
 * one rule carrying a `requestDomains` array.
 */

import type { FilterOptions, NetworkFilter } from './parser.js';

export interface DnrRule {
    id: number;
    priority: number;
    action: {
        type: string;
        redirect?: unknown;
        responseHeaders?: Array<{ header: string; operation: string; value?: string }>;
    };
    condition: Record<string, unknown>;
}

/** Priority bands, mirroring uBO's precedence model. See docs/02-architecture.md. */
const BAND = {
    modifyHeaders: 900,
    block: 1000,
    allow: 2000,
    importantBlock: 3000,
    importantAllow: 4000,
    allowAllRequests: 5000,
} as const;

/** Actions Chrome considers "unsafe" and caps at 5 000 dynamic rules. */
const UNSAFE_ACTIONS = new Set(['redirect', 'modifyHeaders']);

export interface CompileStats {
    inputFilters: number;
    /** Filters dropped because no declarative equivalent exists. */
    unconvertible: number;
    unconvertibleReasons: Record<string, number>;
    /** Filters removed by a matching `$badfilter`. */
    badfilterRemoved: number;
    rulesBeforeMerge: number;
    rulesAfterMerge: number;
    regexRules: number;
    unsafeRules: number;
    mergedGroups: number;
}

/** Canonical key for a `$badfilter` match: same pattern, same options. */
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

function specificity(options: FilterOptions): number {
    let score = 0;
    if (options.domains.length > 0) score += 40;
    if (options.resourceTypes.length > 0) score += 20;
    if (options.thirdParty !== null) score += 10;
    if (options.excludedDomains.length > 0) score += 5;
    return Math.min(score, 99);
}

function priorityFor(filter: NetworkFilter): number {
    const spec = specificity(filter.options);
    if (filter.options.csp !== null) return BAND.modifyHeaders;
    if (filter.isException) {
        if (filter.options.resourceTypes.includes('main_frame')) return BAND.allowAllRequests;
        return (filter.options.important ? BAND.importantAllow : BAND.allow) + spec;
    }
    return (filter.options.important ? BAND.importantBlock : BAND.block) + spec;
}

function actionFor(filter: NetworkFilter): DnrRule['action'] | null {
    const o = filter.options;

    if (o.csp !== null) {
        return {
            type: 'modifyHeaders',
            responseHeaders: [{
                header: 'content-security-policy',
                operation: 'append',
                value: o.csp,
            }],
        };
    }
    if (o.removeParam !== null) {
        return {
            type: 'redirect',
            redirect: { transform: { queryTransform: { removeParams: [o.removeParam] } } },
        };
    }
    if (o.redirect !== null) {
        return { type: 'redirect', redirect: { extensionPath: `/web_accessible_resources/${o.redirect}` } };
    }
    if (filter.isException) {
        return o.resourceTypes.includes('main_frame')
            ? { type: 'allowAllRequests' }
            : { type: 'allow' };
    }
    return { type: 'block' };
}

function conditionFor(filter: NetworkFilter): Record<string, unknown> {
    const o = filter.options;
    const condition: Record<string, unknown> = {};

    if (filter.anchoredDomain !== null) {
        condition.requestDomains = [filter.anchoredDomain];
    } else if (filter.isRegex) {
        condition.regexFilter = filter.pattern.slice(1, -1);
    } else {
        condition.urlFilter = filter.pattern;
    }

    if (o.resourceTypes.length > 0) condition.resourceTypes = [...new Set(o.resourceTypes)].sort();
    if (o.excludedResourceTypes.length > 0) condition.excludedResourceTypes = [...new Set(o.excludedResourceTypes)].sort();
    if (o.thirdParty !== null) condition.domainType = o.thirdParty ? 'thirdParty' : 'firstParty';
    if (o.domains.length > 0) condition.initiatorDomains = [...new Set(o.domains)].sort();
    if (o.excludedDomains.length > 0) condition.excludedInitiatorDomains = [...new Set(o.excludedDomains)].sort();
    if (o.denyAllow.length > 0) condition.excludedRequestDomains = [...new Set(o.denyAllow)].sort();
    // `$to=` narrows the request domain. It cannot coexist with the anchored
    // domain we may already have put in requestDomains.
    if (o.toDomains.length > 0 && condition.requestDomains === undefined) {
        condition.requestDomains = [...new Set(o.toDomains)].sort();
    }
    if (o.methods.length > 0) condition.requestMethods = [...new Set(o.methods)].sort();
    if (o.matchCase) condition.isUrlFilterCaseSensitive = true;

    return condition;
}

/**
 * RE2 constructs Chrome's regexFilter cannot express.
 *
 * This matters more than it looks: Chrome rejects the *entire ruleset* when one
 * rule carries an unsupported regex, so a single lookahead in an upstream list
 * silently disables every other rule shipped alongside it.
 */
const RE2_UNSUPPORTED = [
    { pattern: /\(\?=/, reason: 'regex:lookahead' },
    { pattern: /\(\?!/, reason: 'regex:negative-lookahead' },
    { pattern: /\(\?<=/, reason: 'regex:lookbehind' },
    { pattern: /\(\?<!/, reason: 'regex:negative-lookbehind' },
    { pattern: /\\[1-9]/, reason: 'regex:backreference' },
    { pattern: /\(\?</, reason: 'regex:named-group' },
];

function unsupportedRegexReason(pattern: string): string | null {
    for (const { pattern: probe, reason } of RE2_UNSUPPORTED) {
        if (probe.test(pattern)) return reason;
    }
    return null;
}

/** Why a filter could not become a DNR rule. */
function unconvertibleReason(filter: NetworkFilter): string | null {
    if (filter.isRegex) {
        const reason = unsupportedRegexReason(filter.pattern);
        if (reason !== null) return reason;
    }

    // uBO's `example.*` means "this name under any TLD". DNR domain lists take
    // literal hostnames only, so the entry would silently never match.
    // AdGuard expands these against a known TLD list — worth doing later, but
    // dropping them is the honest behaviour for now.
    const o = filter.options;
    const allDomains = [...o.domains, ...o.excludedDomains, ...o.toDomains, ...o.denyAllow];
    if (allDomains.some((d) => d.includes('*'))) return 'domain:wildcard-tld';

    const unsupported = filter.options.unsupported;
    if (unsupported.length === 0) return null;

    // Cosmetic-scoped options are handled by the cosmetic engine, not DNR:
    // they are out of scope here rather than a conversion failure.
    const blocking = unsupported.filter((u) => !u.startsWith('cosmetic:'));
    if (blocking.length === 0) return 'cosmetic-scope';
    return blocking[0];
}

/**
 * Merge key: everything about a rule except the domain list it carries. Rules
 * sharing a key collapse into one rule with a merged `requestDomains` array.
 */
function mergeKey(rule: DnrRule): string | null {
    const { requestDomains, ...rest } = rule.condition;
    if (requestDomains === undefined) return null;
    if (rule.action.type === 'redirect' || rule.action.type === 'modifyHeaders') return null;
    return JSON.stringify([rule.priority, rule.action.type, rest]);
}

export function compile(filters: NetworkFilter[]): { rules: DnrRule[]; stats: CompileStats } {
    const stats: CompileStats = {
        inputFilters: filters.length,
        unconvertible: 0,
        unconvertibleReasons: {},
        badfilterRemoved: 0,
        rulesBeforeMerge: 0,
        rulesAfterMerge: 0,
        regexRules: 0,
        unsafeRules: 0,
        mergedGroups: 0,
    };

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
        const reason = unconvertibleReason(filter);
        if (reason !== null) {
            stats.unconvertible += 1;
            stats.unconvertibleReasons[reason] = (stats.unconvertibleReasons[reason] ?? 0) + 1;
            continue;
        }
        usable.push(filter);
    }

    // 2. Translate to DNR rules.
    const translated: DnrRule[] = [];
    for (const filter of usable) {
        const action = actionFor(filter);
        if (action === null) continue;
        translated.push({
            id: 0,
            priority: priorityFor(filter),
            action,
            condition: conditionFor(filter),
        });
    }
    stats.rulesBeforeMerge = translated.length;

    // 3. Deduplicate identical rules.
    const seen = new Map<string, DnrRule>();
    for (const rule of translated) {
        const key = JSON.stringify([rule.priority, rule.action, rule.condition]);
        if (!seen.has(key)) seen.set(key, rule);
    }

    // 4. Merge domain-only rules that share every other property.
    const groups = new Map<string, { rule: DnrRule; domains: Set<string> }>();
    const standalone: DnrRule[] = [];

    for (const rule of seen.values()) {
        const key = mergeKey(rule);
        if (key === null) {
            standalone.push(rule);
            continue;
        }
        const domains = rule.condition.requestDomains as string[];
        const existing = groups.get(key);
        if (existing === undefined) {
            groups.set(key, { rule, domains: new Set(domains) });
        } else {
            for (const d of domains) existing.domains.add(d);
        }
    }

    const merged: DnrRule[] = [];
    for (const { rule, domains } of groups.values()) {
        if (domains.size > 1) stats.mergedGroups += 1;
        merged.push({
            ...rule,
            condition: { ...rule.condition, requestDomains: [...domains].sort() },
        });
    }

    const rules = [...merged, ...standalone].map((rule, index) => ({ ...rule, id: index + 1 }));

    stats.rulesAfterMerge = rules.length;
    stats.regexRules = rules.filter((r) => r.condition.regexFilter !== undefined).length;
    stats.unsafeRules = rules.filter((r) => UNSAFE_ACTIONS.has(r.action.type)).length;

    return { rules, stats };
}
