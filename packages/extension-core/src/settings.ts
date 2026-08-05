/**
 * User settings and the rules derived from them.
 *
 * Everything here is pure: it turns settings into the DNR rules and script
 * exclusions the service worker applies. Keeping it free of `chrome.*` is what
 * makes it testable without a browser.
 */

export interface Settings {
    /** Hostnames where filtering is off entirely. */
    disabledSites: string[];
    /** Raw filter text written by the user or produced by the picker. */
    userFilters: string[];
    /** Ruleset ids the user turned off. */
    disabledRulesets: string[];
    /** Ruleset ids the user turned on although they ship off. */
    enabledRulesets: string[];
}

export const DEFAULT_SETTINGS: Settings = {
    disabledSites: [],
    userFilters: [],
    disabledRulesets: [],
    enabledRulesets: [],
};

/**
 * Dynamic rule ids are partitioned so each concern can be rewritten without
 * disturbing the others.
 */
export const RULE_ID_BASE = {
    /** Site allowlist entries. */
    allowlist: 1_000,
    /** Network rules compiled from user filters. */
    userNetwork: 50_000,
} as const;

/**
 * Priority for allowlist rules.
 *
 * Must outrank every static band — including `$important` blocks at 3000+ —
 * because "turn it off here" has to mean exactly that, whatever the lists say.
 */
export const ALLOWLIST_PRIORITY = 100_000;

export function normaliseHostname(input: string): string | null {
    let host = input.trim().toLowerCase();
    if (host === '') return null;

    // Accept a pasted URL as readily as a bare hostname.
    if (host.includes('://')) {
        try {
            host = new URL(host).hostname;
        } catch {
            return null;
        }
    }

    host = host.replace(/^www\./, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
    if (!host.includes('.')) return null;
    return host;
}

/** True when filtering should be off for this hostname. */
export function isSiteDisabled(settings: Settings, hostname: string): boolean {
    const host = normaliseHostname(hostname);
    if (host === null) return false;
    return settings.disabledSites.some(
        (disabled) => host === disabled || host.endsWith(`.${disabled}`),
    );
}

export interface DynamicRule {
    id: number;
    priority: number;
    action: { type: string };
    condition: Record<string, unknown>;
}

/**
 * Builds the `allowAllRequests` rules that switch filtering off per site.
 *
 * `allowAllRequests` covers the document and everything under it, which is
 * what a user means by "stop blocking here" — an `allow` rule on the document
 * alone would leave subresources blocked.
 */
export function buildAllowlistRules(settings: Settings): DynamicRule[] {
    return settings.disabledSites.map((domain, index) => ({
        id: RULE_ID_BASE.allowlist + index,
        priority: ALLOWLIST_PRIORITY,
        action: { type: 'allowAllRequests' },
        condition: {
            requestDomains: [domain],
            resourceTypes: ['main_frame', 'sub_frame'],
        },
    }));
}

export interface ParsedUserFilter {
    raw: string;
    kind: 'network' | 'cosmetic' | 'invalid';
    /** For cosmetic filters: the domains it applies to, empty meaning all. */
    domains: string[];
    /** For cosmetic filters: the selector. */
    selector: string;
}

const COSMETIC_MARKER = /#(@)?(\$\?|\?|\$|%)?#/;

/** Classifies a user-entered filter line. */
export function parseUserFilter(line: string): ParsedUserFilter {
    const text = line.trim();
    if (text === '' || text.startsWith('!')) {
        return { raw: line, kind: 'invalid', domains: [], selector: '' };
    }

    const match = COSMETIC_MARKER.exec(text);
    if (match !== null && !text.startsWith('/')) {
        const selector = text.slice(match.index + match[0].length);
        if (selector === '') return { raw: line, kind: 'invalid', domains: [], selector: '' };
        const domains = text.slice(0, match.index)
            .split(',')
            .map((d) => normaliseHostname(d))
            .filter((d): d is string => d !== null);
        return { raw: line, kind: 'cosmetic', domains, selector };
    }

    return { raw: line, kind: 'network', domains: [], selector: text };
}

export interface CosmeticUserRules {
    /** Selectors applying to every site. */
    generic: string[];
    /** Selectors keyed by the hostname they apply to. */
    byDomain: Record<string, string[]>;
}

/** Splits user cosmetic filters into what the content script needs. */
export function buildCosmeticUserRules(settings: Settings): CosmeticUserRules {
    const generic: string[] = [];
    const byDomain: Record<string, string[]> = {};

    for (const line of settings.userFilters) {
        const parsed = parseUserFilter(line);
        if (parsed.kind !== 'cosmetic') continue;

        if (parsed.domains.length === 0) {
            generic.push(parsed.selector);
            continue;
        }
        for (const domain of parsed.domains) {
            byDomain[domain] = [...(byDomain[domain] ?? []), parsed.selector];
        }
    }

    return { generic, byDomain };
}

/** Match patterns for the sites where content scripts must not run. */
export function buildExcludeMatches(settings: Settings): string[] {
    return settings.disabledSites.map((domain) => `*://*.${domain}/*`);
}

/** A ruleset as the manifest declares it. */
export interface RulesetDefault {
    id: string;
    /** Whether it ships enabled. */
    enabled: boolean;
}

/**
 * Decides which rulesets to enable.
 *
 * The manifest holds the default and the settings hold only the user's
 * deviations from it, which is why there are two lists rather than one: with a
 * single "disabled" list, a ruleset the user never touched is indistinguishable
 * from one they turned on, and anything shipping off — the annoyances list —
 * would silently come on for everybody.
 */
export function resolveRulesets(
    settings: Settings,
    defaults: RulesetDefault[],
): { enable: string[]; disable: string[] } {
    const forcedOn = new Set(settings.enabledRulesets);
    const forcedOff = new Set(settings.disabledRulesets);

    const enable: string[] = [];
    const disable: string[] = [];

    for (const ruleset of defaults) {
        const on = forcedOn.has(ruleset.id)
            || (ruleset.enabled && !forcedOff.has(ruleset.id));
        (on ? enable : disable).push(ruleset.id);
    }

    return { enable, disable };
}

/**
 * Whether the registered scripts need their exclusions rewritten.
 *
 * Re-applying identical exclusions to every registered script costs seconds
 * (measured — docs/adr/0002) and changes nothing, so the worker skips it. The
 * comparison is order-sensitive on purpose: reporting a difference that is only
 * a reordering merely costs one needless update, whereas missing a real one
 * would leave filtering on where the user turned it off. Only the harmless
 * error is possible in that direction.
 */
export function exclusionsDiffer(applied: string[] | undefined, wanted: string[]): boolean {
    if (applied === undefined) return true;
    if (applied.length !== wanted.length) return true;
    return applied.some((pattern, index) => pattern !== wanted[index]);
}
