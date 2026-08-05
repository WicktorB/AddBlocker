/** What a line in a filter list turns out to be. */
export type LineKind =
    | 'network'
    | 'cosmetic'
    | 'scriptlet'
    | 'comment'
    | 'empty';

/** DNR resource type names. */
export type ResourceType =
    | 'main_frame'
    | 'sub_frame'
    | 'stylesheet'
    | 'script'
    | 'image'
    | 'font'
    | 'object'
    | 'xmlhttprequest'
    | 'ping'
    | 'csp_report'
    | 'media'
    | 'websocket'
    | 'webtransport'
    | 'webbundle'
    | 'other';

export interface FilterOptions {
    resourceTypes: ResourceType[];
    excludedResourceTypes: ResourceType[];
    /** `$third-party` / `$first-party`; null when unconstrained. */
    thirdParty: boolean | null;
    /** `$domain=` / `$from=`: which initiators the filter applies to. */
    domains: string[];
    excludedDomains: string[];
    /** `$denyallow=`: request domains to exempt. */
    denyAllow: string[];
    /** `$to=`: request domains to restrict to. Not the inverse of denyallow. */
    toDomains: string[];
    methods: string[];
    important: boolean;
    badfilter: boolean;
    matchCase: boolean;
    /** `$popup` / `$popunder`: blocks a document opened in a new tab. */
    popup: boolean;
    redirect: string | null;
    removeParam: string | null;
    csp: string | null;
    /**
     * Cosmetic-scoped options (`$elemhide`, `$generichide`, `$specifichide`).
     * These are not network filters: they tell the cosmetic engine to stand
     * down on a site. Tracked separately so they are never counted as failed
     * network conversions.
     */
    cosmeticScope: string[];
    /** Options with no declarative equivalent, kept for honest reporting. */
    unsupported: string[];
}

export interface NetworkFilter {
    raw: string;
    /** `@@` exception. */
    isException: boolean;
    /** URL pattern with `@@` and `$options` stripped. */
    pattern: string;
    /** Set when the pattern is a `/regex/` literal. */
    isRegex: boolean;
    /** `||domain^` reduced to its hostname, when the pattern allows it. */
    anchoredDomain: string | null;
    options: FilterOptions;
}

export interface ParseStats {
    total: number;
    network: number;
    cosmetic: number;
    scriptlet: number;
    comment: number;
    empty: number;
}
