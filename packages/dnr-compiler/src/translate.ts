import type { FilterOptions, NetworkFilter } from '@addblocker/filter-parser';
import type { DnrAction, DnrCondition, DnrRule } from './types.js';

/**
 * Priority bands, mirroring uBO's precedence model.
 *
 * DNR resolves by numeric priority first, then by action kind
 * (allow/allowAllRequests beat block, block beats redirect). Bands are spaced
 * by 100 so a specificity score can ride inside one without spilling over.
 */
export const BAND = {
    modifyHeaders: 900,
    block: 1000,
    allow: 2000,
    importantBlock: 3000,
    importantAllow: 4000,
    allowAllRequests: 5000,
} as const;

/** Actions Chrome treats as "unsafe", capped at 5 000 dynamic rules. */
export const UNSAFE_ACTIONS = new Set(['redirect', 'modifyHeaders']);

/**
 * TLDs used to expand uBO's `example.*` wildcard.
 *
 * DNR domain lists take literal hostnames, so a wildcard entry would never
 * match. Expanding against the TLDs that actually appear in the lists recovers
 * the filter at the cost of a few extra domain entries — which merging then
 * absorbs. AdGuard takes the same approach.
 */
export const EXPANSION_TLDS = [
    'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'me', 'tv', 'cc', 'ru',
    'de', 'fr', 'it', 'es', 'nl', 'pl', 'br', 'in', 'uk', 'jp', 'cn', 'au',
    'ca', 'se', 'no', 'fi', 'dk', 'cz', 'gr', 'pt', 'ro', 'hu', 'at', 'ch',
    'be', 'tr', 'ua', 'mx', 'ar', 'kr', 'tw', 'us', 'eu', 'to', 'ws', 'la',
    'top', 'xyz', 'club', 'online', 'site', 'store', 'shop', 'live', 'icu',
];

/** Expands `example.*` into one entry per known TLD; passes others through. */
export function expandWildcardDomains(domains: string[]): { expanded: string[]; didExpand: boolean } {
    let didExpand = false;
    const expanded: string[] = [];

    for (const domain of domains) {
        if (domain.endsWith('.*')) {
            const stem = domain.slice(0, -2);
            for (const tld of EXPANSION_TLDS) expanded.push(`${stem}.${tld}`);
            didExpand = true;
        } else {
            expanded.push(domain);
        }
    }

    return { expanded, didExpand };
}

function specificity(options: FilterOptions): number {
    let score = 0;
    if (options.domains.length > 0) score += 40;
    if (options.resourceTypes.length > 0) score += 20;
    if (options.thirdParty !== null) score += 10;
    if (options.excludedDomains.length > 0) score += 5;
    if (options.toDomains.length > 0) score += 5;
    return Math.min(score, 99);
}

export function priorityFor(filter: NetworkFilter): number {
    const spec = specificity(filter.options);

    if (filter.options.csp !== null) return BAND.modifyHeaders;

    if (filter.isException) {
        if (filter.options.resourceTypes.includes('main_frame')) return BAND.allowAllRequests;
        return (filter.options.important ? BAND.importantAllow : BAND.allow) + spec;
    }

    return (filter.options.important ? BAND.importantBlock : BAND.block) + spec;
}

export function actionFor(filter: NetworkFilter): DnrAction {
    const o = filter.options;

    if (o.csp !== null) {
        return {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: o.csp }],
        };
    }

    if (o.removeParam !== null) {
        return {
            type: 'redirect',
            redirect: { transform: { queryTransform: { removeParams: [o.removeParam] } } },
        };
    }

    if (o.redirect !== null) {
        return { type: 'redirect', redirect: { extensionPath: `/redirects/${o.redirect}` } };
    }

    if (filter.isException) {
        return o.resourceTypes.includes('main_frame')
            ? { type: 'allowAllRequests' }
            : { type: 'allow' };
    }

    return { type: 'block' };
}

export function conditionFor(filter: NetworkFilter): { condition: DnrCondition; didExpand: boolean } {
    const o = filter.options;
    const condition: DnrCondition = {};
    let didExpand = false;

    const take = (domains: string[]): string[] => {
        const { expanded, didExpand: any } = expandWildcardDomains(domains);
        if (any) didExpand = true;
        return [...new Set(expanded)].sort();
    };

    if (filter.anchoredDomain !== null) {
        condition.requestDomains = [filter.anchoredDomain];
    } else if (filter.isRegex) {
        condition.regexFilter = filter.pattern.slice(1, -1);
    } else {
        condition.urlFilter = filter.pattern;
    }

    // `$popup` blocks a document opened in a new tab. DNR has no popup
    // resource type, so it becomes a main_frame block. Slightly broader than
    // uBO — a direct visit is blocked too — but these filters target pure
    // ad/spam domains where that is the desired outcome anyway.
    const resourceTypes = new Set<string>(o.resourceTypes);
    if (o.popup) resourceTypes.add('main_frame');
    if (resourceTypes.size > 0) condition.resourceTypes = [...resourceTypes].sort();

    if (o.excludedResourceTypes.length > 0) {
        condition.excludedResourceTypes = [...new Set(o.excludedResourceTypes)].sort();
    }
    if (o.thirdParty !== null) condition.domainType = o.thirdParty ? 'thirdParty' : 'firstParty';
    if (o.domains.length > 0) condition.initiatorDomains = take(o.domains);
    if (o.excludedDomains.length > 0) condition.excludedInitiatorDomains = take(o.excludedDomains);
    if (o.denyAllow.length > 0) condition.excludedRequestDomains = take(o.denyAllow);
    if (o.methods.length > 0) condition.requestMethods = [...new Set(o.methods)].sort();
    if (o.matchCase) condition.isUrlFilterCaseSensitive = true;

    // `$to=` narrows the request domain; it cannot coexist with an anchored
    // domain already occupying requestDomains.
    if (o.toDomains.length > 0 && condition.requestDomains === undefined) {
        condition.requestDomains = take(o.toDomains);
    }

    return { condition, didExpand };
}

export function translate(filter: NetworkFilter): { rule: DnrRule; didExpand: boolean } {
    const { condition, didExpand } = conditionFor(filter);
    return {
        rule: { id: 0, priority: priorityFor(filter), action: actionFor(filter), condition },
        didExpand,
    };
}
