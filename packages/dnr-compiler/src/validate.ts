import type { NetworkFilter } from '@addblocker/filter-parser';
import type { DnrRule } from './types.js';

/**
 * RE2 constructs Chrome's `regexFilter` cannot express.
 *
 * This matters more than it looks: Chrome rejects the *entire ruleset* when one
 * rule carries an unsupported regex, silently disabling every other rule
 * shipped alongside it. Measured in phase 0 — one lookahead in an upstream list
 * took out 3 436 working rules.
 */
const RE2_UNSUPPORTED: Array<{ probe: RegExp; reason: string }> = [
    { probe: /\(\?=/, reason: 'regex:lookahead' },
    { probe: /\(\?!/, reason: 'regex:negative-lookahead' },
    { probe: /\(\?<=/, reason: 'regex:lookbehind' },
    { probe: /\(\?<!/, reason: 'regex:negative-lookbehind' },
    { probe: /\(\?</, reason: 'regex:named-group' },
    { probe: /\\[1-9]/, reason: 'regex:backreference' },
];

export function unsupportedRegexReason(pattern: string): string | null {
    for (const { probe, reason } of RE2_UNSUPPORTED) {
        if (probe.test(pattern)) return reason;
    }
    return null;
}

/**
 * True when a domain-list entry can be expressed in DNR.
 *
 * A trailing `.*` is allowed because the compiler expands it against a TLD
 * list. Anything else outside the hostname alphabet — bracketed IPv6 literals
 * such as `[::1]` being the common case — cannot be represented.
 */
function isRepresentableDomain(entry: string): boolean {
    const candidate = entry.endsWith('.*') ? entry.slice(0, -2) : entry;
    return candidate !== '' && /^[a-z0-9.-]+$/.test(candidate)
        && !candidate.startsWith('.') && !candidate.endsWith('.');
}

/** Why a filter cannot become a DNR rule, or null when it can. */
export function unconvertibleReason(filter: NetworkFilter): string | null {
    if (filter.isRegex) {
        const reason = unsupportedRegexReason(filter.pattern);
        if (reason !== null) return reason;
    }

    const o = filter.options;
    if (o.unsupported.length > 0) return o.unsupported[0];

    // Dropping just the offending entry would change the filter's meaning —
    // losing an *exclusion* widens the block and can break a site. Rejecting
    // the whole filter is the conservative choice.
    const domainLists = [o.domains, o.excludedDomains, o.toDomains, o.denyAllow];
    for (const list of domainLists) {
        if (list.some((entry) => !isRepresentableDomain(entry))) return 'domain:unrepresentable';
    }

    // A redirect needs a bundled resource to point at; without a name there is
    // nothing to serve.
    if (o.redirect !== null && o.redirect === '') return 'redirect:empty-target';

    return null;
}

/** Hostname entries Chrome accepts in a domain list. */
const VALID_DOMAIN = /^[a-z0-9.-]+$/;

/**
 * Last line of defence before emitting a ruleset.
 *
 * Chrome's failure mode is all-or-nothing and nearly silent, so anything
 * malformed must be caught here rather than in the browser.
 */
export function validateRule(rule: DnrRule): string[] {
    const problems: string[] = [];
    const c = rule.condition;

    if (!Number.isInteger(rule.id) || rule.id < 1) problems.push(`id must be a positive integer (got ${rule.id})`);
    if (!Number.isInteger(rule.priority) || rule.priority < 1) problems.push(`priority must be >= 1 (got ${rule.priority})`);

    const matchers = [c.urlFilter, c.regexFilter, c.requestDomains].filter((v) => v !== undefined);
    if (matchers.length === 0) problems.push('condition matches everything: no urlFilter, regexFilter or requestDomains');
    if (c.urlFilter !== undefined && c.regexFilter !== undefined) problems.push('urlFilter and regexFilter are mutually exclusive');

    if (c.regexFilter !== undefined) {
        const reason = unsupportedRegexReason(c.regexFilter);
        if (reason !== null) problems.push(`${reason} — Chrome would reject the whole ruleset`);
    }

    for (const key of ['requestDomains', 'excludedRequestDomains', 'initiatorDomains', 'excludedInitiatorDomains'] as const) {
        const domains = c[key];
        if (domains === undefined) continue;
        if (domains.length === 0) problems.push(`${key} must not be empty`);
        for (const domain of domains) {
            if (!VALID_DOMAIN.test(domain) || domain.startsWith('.') || domain.endsWith('.')) {
                problems.push(`${key} contains a malformed entry: ${JSON.stringify(domain)}`);
                break;
            }
        }
    }

    if (rule.action.type === 'redirect' && rule.action.redirect === undefined) {
        problems.push('redirect action without a redirect target');
    }
    if (rule.action.type === 'modifyHeaders'
        && (rule.action.responseHeaders === undefined || rule.action.responseHeaders.length === 0)) {
        problems.push('modifyHeaders action without header edits');
    }

    return problems;
}

/** Validates a whole ruleset, returning every rule that would break it. */
export function validateRuleset(rules: DnrRule[]): Array<{ rule: DnrRule; problems: string[] }> {
    const broken: Array<{ rule: DnrRule; problems: string[] }> = [];
    const seenIds = new Set<number>();

    for (const rule of rules) {
        const problems = validateRule(rule);
        if (seenIds.has(rule.id)) problems.push(`duplicate rule id ${rule.id}`);
        seenIds.add(rule.id);
        if (problems.length > 0) broken.push({ rule, problems });
    }

    return broken;
}
