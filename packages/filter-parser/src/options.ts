import type { FilterOptions, ResourceType } from './types.js';

/** ABP option name -> DNR resource type. */
const RESOURCE_TYPES: Record<string, ResourceType> = {
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
    csp_report: 'csp_report',
};

/**
 * Options that scope the *cosmetic* engine rather than the network layer.
 * They are not conversion failures — the cosmetic engine consumes them.
 */
const COSMETIC_SCOPE = new Set([
    'elemhide', 'ehide', 'generichide', 'ghide', 'specifichide', 'shide',
]);

/** Options with genuinely no declarative equivalent. */
const UNSUPPORTED = new Set([
    'replace', 'hls', 'jsonprune', 'stealth', 'network', 'app', 'extension',
    'content', 'cookie', 'webrtc', 'empty', 'mp4', 'inline-script',
    'inline-font', 'genericblock', 'permissions', 'urltransform',
    'referrerpolicy', 'uritransform', 'urlskip', 'ipaddress', 'header',
    'rewrite-disabled',
]);

export function emptyOptions(): FilterOptions {
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
        popup: false,
        redirect: null,
        redirectRuleOnly: false,
        removeParam: null,
        csp: null,
        cosmeticScope: [],
        unsupported: [],
    };
}

/** Splits an option list on commas that are neither escaped nor bracketed. */
export function splitOptionList(text: string): string[] {
    const parts: string[] = [];
    let current = '';
    let escaped = false;
    let depth = 0;

    for (const ch of text) {
        if (escaped) { current += ch; escaped = false; continue; }
        if (ch === '\\') { current += ch; escaped = true; continue; }
        if (ch === '[') depth += 1;
        else if (ch === ']') depth -= 1;
        if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
        current += ch;
    }
    if (current !== '') parts.push(current);
    return parts;
}

/** Splits a `|`-separated domain list into included and excluded halves. */
function splitDomainList(value: string): { included: string[]; excluded: string[] } {
    const included: string[] = [];
    const excluded: string[] = [];
    for (const entry of value.split('|')) {
        if (entry === '') continue;
        if (entry.startsWith('~')) excluded.push(entry.slice(1).toLowerCase());
        else included.push(entry.toLowerCase());
    }
    return { included, excluded };
}

export function parseOptions(optionText: string): FilterOptions {
    const options = emptyOptions();
    if (optionText === '') return options;

    for (const rawPart of splitOptionList(optionText)) {
        const part = rawPart.trim();
        // `_` is uBO's no-op padding, used to defeat naive list parsers.
        if (part === '' || /^_+$/.test(part)) continue;

        const negated = part.startsWith('~');
        const body = negated ? part.slice(1) : part;
        const eq = body.indexOf('=');
        const name = (eq === -1 ? body : body.slice(0, eq)).toLowerCase();
        const value = eq === -1 ? '' : body.slice(eq + 1);

        const resourceType = RESOURCE_TYPES[name];
        if (resourceType !== undefined) {
            if (negated) options.excludedResourceTypes.push(resourceType);
            else options.resourceTypes.push(resourceType);
            continue;
        }

        switch (name) {
            case 'third-party': case '3p':
                options.thirdParty = !negated;
                break;
            case 'first-party': case '1p':
                options.thirdParty = negated;
                break;
            // strict1p/strict3p differ from 1p/3p on how they treat the
            // document chain. DNR cannot express that nuance; the plain
            // party check is the closest honest approximation.
            case 'strict1p':
                options.thirdParty = false;
                break;
            case 'strict3p':
                options.thirdParty = true;
                break;
            case 'domain': case 'from': {
                const { included, excluded } = splitDomainList(value);
                options.domains.push(...included);
                options.excludedDomains.push(...excluded);
                break;
            }
            case 'to': {
                const { included, excluded } = splitDomainList(value);
                options.toDomains.push(...included);
                options.denyAllow.push(...excluded);
                break;
            }
            case 'denyallow': {
                const { included } = splitDomainList(value);
                options.denyAllow.push(...included);
                break;
            }
            case 'method':
                options.methods.push(
                    ...value.split('|')
                        .filter((m) => m !== '' && !m.startsWith('~'))
                        .map((m) => m.toUpperCase()),
                );
                break;
            case 'popup': case 'popunder':
                options.popup = true;
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
            // `$rewrite=` is ABP's spelling of uBO's `$redirect=`.
            case 'redirect': case 'rewrite':
                options.redirect = value.replace(/^abp-resource:/, '');
                break;
            // Same syntax, different meaning — see types.ts.
            case 'redirect-rule':
                options.redirect = value.replace(/^abp-resource:/, '');
                options.redirectRuleOnly = true;
                break;
            case 'removeparam': case 'queryprune':
                options.removeParam = value;
                break;
            case 'csp':
                options.csp = value;
                break;
            case 'all':
                // No resource-type restriction; nothing to record.
                break;
            default:
                if (COSMETIC_SCOPE.has(name)) options.cosmeticScope.push(name);
                else if (UNSUPPORTED.has(name)) options.unsupported.push(name);
                else options.unsupported.push(`unknown:${name}`);
        }
    }

    return options;
}
