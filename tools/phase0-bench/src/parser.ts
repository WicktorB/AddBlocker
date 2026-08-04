/**
 * Minimal Adblock Plus / uBlock Origin network filter parser.
 *
 * Scope is deliberately limited to what phase 0 needs to answer: how many DNR
 * rules a well-optimised compiler produces from the standard lists. Cosmetic
 * and scriptlet syntax is recognised and classified, but not parsed.
 */

export type LineKind =
    | 'network'
    | 'cosmetic'
    | 'scriptlet'
    | 'comment'
    | 'empty'
    | 'unsupported';

export interface NetworkFilter {
    raw: string;
    /** `@@` exception. */
    isException: boolean;
    /** URL pattern with the `@@` prefix and `$options` stripped. */
    pattern: string;
    /** Set when the pattern is a `/regex/` literal. */
    isRegex: boolean;
    /** `||domain^` style pattern reduced to its hostname, when applicable. */
    anchoredDomain: string | null;
    options: FilterOptions;
}

export interface FilterOptions {
    /** ABP resource types, already normalised to DNR names. */
    resourceTypes: string[];
    excludedResourceTypes: string[];
    thirdParty: boolean | null;
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
    redirect: string | null;
    removeParam: string | null;
    csp: string | null;
    /** Options recognised but with no DNR equivalent. */
    unsupported: string[];
}

/** ABP option name -> DNR resource type. */
const RESOURCE_TYPES: Record<string, string> = {
    script: 'script',
    image: 'image',
    stylesheet: 'stylesheet',
    css: 'stylesheet',
    object: 'object',
    'object-subrequest': 'object',
    xmlhttprequest: 'xmlhttprequest',
    xhr: 'xmlhttprequest',
    subdocument: 'sub_frame',
    frame: 'sub_frame',
    document: 'main_frame',
    doc: 'main_frame',
    websocket: 'websocket',
    media: 'media',
    font: 'font',
    ping: 'ping',
    beacon: 'ping',
    other: 'other',
    'csp_report': 'csp_report',
};

/**
 * Options that exist in ABP/uBO but have no declarative equivalent. Tracked so
 * the benchmark can report an honest conversion rate instead of silently
 * dropping them.
 */
const UNSUPPORTED_OPTIONS = new Set([
    'replace', 'hls', 'jsonprune', 'stealth', 'network', 'app', 'extension',
    'content', 'cookie', 'popup', 'popunder', 'webrtc', 'empty', 'mp4',
    'inline-script', 'inline-font', 'genericblock', 'strict1p', 'strict3p',
    'permissions', 'urltransform', 'referrerpolicy', 'uritransform',
]);

/** Cosmetic-only options: not network rules at all, counted separately. */
const COSMETIC_OPTIONS = new Set(['elemhide', 'ehide', 'generichide', 'ghide', 'specifichide', 'shide']);

/**
 * Matches every cosmetic/scriptlet separator: `##`, `#@#`, `#?#`, `#@?#`,
 * `#$#`, `#$?#`, `#%#` and their exception forms.
 */
const COSMETIC_MARKER = /#(@)?(\$\?|\?|\$|%)?#/;

export function classifyLine(line: string): LineKind {
    const trimmed = line.trim();
    if (trimmed === '') return 'empty';
    if (trimmed.startsWith('!') || trimmed.startsWith('[Adblock')) return 'comment';

    // A `#` inside a regex literal is not a cosmetic separator.
    if (!trimmed.startsWith('/')) {
        const match = COSMETIC_MARKER.exec(trimmed);
        if (match !== null) {
            const body = trimmed.slice(match.index + match[0].length);
            // uBO writes scriptlets as `##+js(...)`, AdGuard as `#%#//scriptlet(...)`.
            const isScriptlet = body.startsWith('+js(')
                || body.startsWith('//scriptlet')
                || match[2] === '%'
                || match[2] === '$';
            return isScriptlet ? 'scriptlet' : 'cosmetic';
        }
    }

    return 'network';
}

/**
 * Splits a filter into pattern and option string, respecting `$` characters
 * inside a regex literal.
 */
function splitOptions(text: string): { pattern: string; optionText: string } {
    if (text.startsWith('/')) {
        // Regex literal: options start after the closing slash.
        const close = text.lastIndexOf('/');
        if (close > 0) {
            const rest = text.slice(close + 1);
            if (rest.startsWith('$')) {
                return { pattern: text.slice(0, close + 1), optionText: rest.slice(1) };
            }
            return { pattern: text, optionText: '' };
        }
    }

    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '[') depth += 1;
        else if (ch === ']') depth -= 1;
        else if (ch === '$' && depth === 0) {
            return { pattern: text.slice(0, i), optionText: text.slice(i + 1) };
        }
    }
    return { pattern: text, optionText: '' };
}

/** Splits option list on commas that are not inside brackets or escaped. */
function splitOptionList(text: string): string[] {
    const parts: string[] = [];
    let current = '';
    let escaped = false;
    for (const ch of text) {
        if (escaped) { current += ch; escaped = false; continue; }
        if (ch === '\\') { current += ch; escaped = true; continue; }
        if (ch === ',') { parts.push(current); current = ''; continue; }
        current += ch;
    }
    if (current !== '') parts.push(current);
    return parts;
}

function emptyOptions(): FilterOptions {
    return {
        resourceTypes: [],
        excludedResourceTypes: [],
        thirdParty: null,
        domains: [],
        excludedDomains: [],
        denyAllow: [],
        toDomains: [],
        methods: [],
        important: false,
        badfilter: false,
        matchCase: false,
        redirect: null,
        removeParam: null,
        csp: null,
        unsupported: [],
    };
}

function parseOptions(optionText: string): FilterOptions {
    const options = emptyOptions();
    if (optionText === '') return options;

    for (const rawPart of splitOptionList(optionText)) {
        const part = rawPart.trim();
        if (part === '' || part === '_') continue;

        const negated = part.startsWith('~');
        const body = negated ? part.slice(1) : part;
        const eq = body.indexOf('=');
        const name = (eq === -1 ? body : body.slice(0, eq)).toLowerCase();
        const value = eq === -1 ? '' : body.slice(eq + 1);

        if (name in RESOURCE_TYPES) {
            const type = RESOURCE_TYPES[name];
            if (negated) options.excludedResourceTypes.push(type);
            else options.resourceTypes.push(type);
            continue;
        }

        switch (name) {
            case 'third-party': case '3p':
                options.thirdParty = !negated;
                break;
            case 'first-party': case '1p':
                options.thirdParty = negated;
                break;
            case 'domain': case 'from':
                for (const d of value.split('|')) {
                    if (d === '') continue;
                    if (d.startsWith('~')) options.excludedDomains.push(d.slice(1));
                    else options.domains.push(d);
                }
                break;
            case 'denyallow':
                options.denyAllow.push(...value.split('|').filter((d) => d !== ''));
                break;
            case 'to':
                // `$to=` restricts which request domains match; it is an
                // include list, not the exclusion `$denyallow` expresses.
                for (const d of value.split('|')) {
                    if (d === '') continue;
                    if (d.startsWith('~')) options.denyAllow.push(d.slice(1));
                    else options.toDomains.push(d);
                }
                break;
            case 'method':
                options.methods.push(...value.split('|').filter((m) => m !== '' && !m.startsWith('~')));
                break;
            case 'important':
                options.important = true;
                break;
            case 'badfilter':
                options.badfilter = true;
                break;
            case 'match-case':
                options.matchCase = true;
                break;
            case 'redirect': case 'redirect-rule':
                options.redirect = value;
                break;
            case 'removeparam': case 'queryprune':
                options.removeParam = value;
                break;
            case 'csp':
                options.csp = value;
                break;
            case 'all':
                // Equivalent to no resource type restriction.
                break;
            case 'header':
                options.unsupported.push(name);
                break;
            default:
                if (COSMETIC_OPTIONS.has(name)) options.unsupported.push(`cosmetic:${name}`);
                else if (UNSUPPORTED_OPTIONS.has(name)) options.unsupported.push(name);
                else options.unsupported.push(`unknown:${name}`);
        }
    }

    return options;
}

/**
 * Reduces `||example.com^` to `example.com`.
 *
 * Only patterns anchored with `||` **and** terminated by `^` qualify: without
 * the separator, `||example.com` also matches `example.com.evil.net`, which
 * `requestDomains` would not. Getting this wrong silently over-blocks, so the
 * check stays strict.
 */
function extractAnchoredDomain(pattern: string): string | null {
    if (!pattern.startsWith('||')) return null;
    const body = pattern.slice(2);
    if (!body.endsWith('^')) return null;
    const host = body.slice(0, -1);
    if (host === '' || !/^[a-z0-9.-]+$/i.test(host)) return null;
    if (host.startsWith('.') || host.endsWith('.') || !host.includes('.')) return null;
    return host.toLowerCase();
}

export function parseNetworkFilter(line: string): NetworkFilter | null {
    let text = line.trim();
    if (text === '') return null;

    const isException = text.startsWith('@@');
    if (isException) text = text.slice(2);

    const { pattern, optionText } = splitOptions(text);
    if (pattern === '') return null;

    const isRegex = pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/');

    return {
        raw: line,
        isException,
        pattern,
        isRegex,
        anchoredDomain: isRegex ? null : extractAnchoredDomain(pattern),
        options: parseOptions(optionText),
    };
}

export interface ParseStats {
    total: number;
    network: number;
    cosmetic: number;
    scriptlet: number;
    comment: number;
    empty: number;
}

export function parseList(content: string): { filters: NetworkFilter[]; stats: ParseStats } {
    const stats: ParseStats = { total: 0, network: 0, cosmetic: 0, scriptlet: 0, comment: 0, empty: 0 };
    const filters: NetworkFilter[] = [];

    for (const line of content.split('\n')) {
        stats.total += 1;
        const kind = classifyLine(line);
        if (kind === 'network') {
            const parsed = parseNetworkFilter(line);
            if (parsed !== null) {
                filters.push(parsed);
                stats.network += 1;
            } else {
                stats.empty += 1;
            }
        } else {
            stats[kind === 'unsupported' ? 'comment' : kind] += 1;
        }
    }

    return { filters, stats };
}
