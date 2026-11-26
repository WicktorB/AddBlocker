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

/**
 * Estimates how large a regex is once compiled.
 *
 * Chrome compiles each `regexFilter` with a 2 kB memory budget and skips the
 * rule when it does not fit. Length is no guide: what costs is repetition,
 * because RE2 has no counter — `[a-f0-9]{32}` is the class written out
 * thirty-two times. A forty-character pattern can blow the budget while a
 * four-hundred-character literal fits.
 *
 * Chrome only says yes or no (`isRegexSupported`), and only from inside a
 * browser, so the build cannot ask. This walks the pattern and prices it:
 * one per literal, a class by its ranges, a quantified atom multiplied by its
 * count. The weights were fitted against Chromium's verdicts on the 226
 * regexes of the lists; `verify` re-asks Chromium about every regex that ships
 * and fails if the estimate ever lets one through.
 */
export function estimateRegexCost(source: string): number {
    let i = 0;

    const atom = (): number => {
        const ch = source[i];

        if (ch === '(') {
            i += 1;
            if (source[i] === '?') {
                while (i < source.length && !':=!'.includes(source[i])) i += 1;
                i += 1;
            }
            const inner = alternation();
            i += 1;
            return inner;
        }

        if (ch === '[') {
            i += 1;
            if (source[i] === '^') i += 1;
            let cost = 1;
            let first = true;
            while (i < source.length && (source[i] !== ']' || first)) {
                first = false;
                if (source[i] === '\\') { i += 2; cost += 0.5; continue; }
                if (source[i + 1] === '-' && source[i + 2] !== ']') { i += 3; cost += 1; continue; }
                i += 1;
                cost += 0.5;
            }
            i += 1;
            return cost;
        }

        if (ch === '\\') {
            const escaped = source[i + 1];
            i += 2;
            return 'dwsbDWSB'.includes(escaped) ? 2 : 1;
        }

        i += 1;
        return ch === '.' ? 4 : 1;
    };

    function alternation(): number {
        let total = 0;
        while (i < source.length && source[i] !== ')') {
            if (source[i] === '|') { i += 1; continue; }

            let cost = atom();
            const counted = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
            if (counted !== null) {
                i += counted[0].length;
                const min = Number(counted[1]);
                // `{n}` is n copies, `{n,m}` is m, `{n,}` is n plus a loop.
                const copies = counted[2] === undefined ? min
                    : counted[3] === '' ? min + 1 : Number(counted[3]);
                cost *= Math.max(copies, 1);
            } else if (i < source.length && '*+?'.includes(source[i])) {
                i += 1;
            }
            if (source[i] === '?') i += 1;

            total += cost;
        }
        return total;
    }

    return alternation();
}

/**
 * Above this estimate a regex is left out.
 *
 * Fitted on Chromium: the cheapest regex it refused scored 121, so everything
 * it refused is out. The margin below that costs eleven regexes Chromium would
 * in fact have taken — the price of an estimate. A rule Chrome skips protects
 * nobody and fills the extension's error page with warnings, so the estimate
 * errs towards dropping.
 */
export const REGEX_COST_LIMIT = 110;

export function unsupportedRegexReason(pattern: string): string | null {
    for (const { probe, reason } of RE2_UNSUPPORTED) {
        if (probe.test(pattern)) return reason;
    }
    // Accepts a filter's `/…/` literal as readily as a bare regexFilter.
    const body = pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')
        ? pattern.slice(1, -1) : pattern;
    if (estimateRegexCost(body) >= REGEX_COST_LIMIT) return 'regex:memory-limit';
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

    if ([...o.methods, ...o.excludedMethods].some((m) => !REQUEST_METHODS.has(m.toLowerCase()))) {
        return 'method:unknown';
    }

    // `$popup` becomes a main_frame block, which is sound when the filter names
    // where the popup goes (`||spam.example^$popup`). With no URL to match —
    // `$popup,domain=site.com` — the only thing left to key on is the page that
    // started the navigation, and the rule would block *every* navigation from
    // that site, its own links included. DNR cannot tell a popup from a click,
    // so there is no faithful translation; the site keeps its popups rather
    // than losing its links.
    if (o.popup && !filter.isException && !filter.isRegex && filter.anchoredDomain === null
        && /^\**$/.test(filter.pattern) && o.toDomains.length === 0) {
        return 'popup:no-url-to-match';
    }

    // A redirect needs a bundled resource to point at; without a name there is
    // nothing to serve.
    if (o.redirect !== null && o.redirect === '') return 'redirect:empty-target';

    // `$redirect-rule` substitutes a resource only for requests some *other*
    // filter already blocks. DNR has no conditional form, so emitting it as a
    // plain redirect would neutralise every matching request instead — for a
    // pattern like `*$script,redirect-rule=noopjs,domain=…` that is every
    // script on every listed site. Dropping it keeps the blocking that other
    // filters provide and loses only the neutered stub.
    if (o.redirectRuleOnly) return 'redirect-rule:not-expressible';

    return null;
}

/** The request methods DNR knows, in the only spelling it accepts. */
export const REQUEST_METHODS: ReadonlySet<string> = new Set([
    'connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other',
]);

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

    for (const key of ['requestMethods', 'excludedRequestMethods'] as const) {
        const bad = (c[key] ?? []).filter((method) => !REQUEST_METHODS.has(method));
        // Chrome wants these lower-case and skips the rule otherwise.
        if (bad.length > 0) problems.push(`${key} contains ${bad.map((m) => JSON.stringify(m)).join(', ')}`);
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
