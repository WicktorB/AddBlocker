/**
 * Cosmetic filter parsing: `domains##selector` and its variants.
 *
 * The split that matters for the compiler is CSS-expressible vs not. Chrome has
 * supported `:has()` natively since 105, so the single most common "procedural"
 * pseudo-class needs no JavaScript at all — only the long tail does.
 */

/** Pseudo-classes that genuinely require a JS engine to evaluate. */
const PROCEDURAL_PSEUDO = [
    'has-text', 'contains', 'matches-css', 'matches-css-before', 'matches-css-after',
    'matches-attr', 'matches-path', 'matches-property', 'upward', 'xpath',
    'watch-attr', 'min-text-length', 'others', 'remove', 'remove-attr',
    'remove-class', 'if', 'if-not', '-abp-has', '-abp-contains',
];

const PROCEDURAL_RE = new RegExp(`:(${PROCEDURAL_PSEUDO.map((p) => p.replace(/[-]/g, '\\-')).join('|')})\\(`);

/** `:style(...)` restyles rather than hides. */
const STYLE_RE = /:style\(\s*(.+?)\s*\)\s*$/;

export type CosmeticKind =
    /** Hide the matched elements. */
    | 'hide'
    /** `#@#`: exempt the selector on these domains. */
    | 'exception'
    /** `:style(...)` or `#$#`: apply a declaration instead of hiding. */
    | 'style';

export interface CosmeticFilter {
    raw: string;
    kind: CosmeticKind;
    /** Selector with any `:style(...)` suffix removed. */
    selector: string;
    /** Declaration block for `style` filters. */
    declaration: string | null;
    /** Needs the JS engine: contains a pseudo-class CSS cannot express. */
    isProcedural: boolean;
    domains: string[];
    excludedDomains: string[];
    /** Applies everywhere — no domain scoping. */
    isGeneric: boolean;
}

/** Matches every cosmetic separator and captures its modifiers. */
const SEPARATOR = /#(@)?(\$\?|\?|\$|%)?#/;

/**
 * Rejects selectors that would break the whole stylesheet or are unsupported.
 *
 * One malformed selector in an injected sheet does not poison the rest — the
 * browser drops just that rule — but keeping them out makes the output smaller
 * and the failures visible at build time.
 */
function isPlausibleSelector(selector: string): boolean {
    if (selector === '' || selector.length > 512) return false;
    // Unbalanced brackets almost always mean a parsing mistake upstream.
    let depth = 0;
    for (const ch of selector) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        if (depth < 0) return false;
    }
    return depth === 0;
}

export function parseCosmeticFilter(line: string): CosmeticFilter | null {
    const text = line.trim();
    if (text === '' || text.startsWith('!') || text.startsWith('[Adblock')) return null;
    // A leading slash marks a network regex literal, not a cosmetic filter.
    if (text.startsWith('/')) return null;

    const match = SEPARATOR.exec(text);
    if (match === null) return null;

    const isException = match[1] === '@';
    const modifier = match[2];
    const domainPart = text.slice(0, match.index);
    let body = text.slice(match.index + match[0].length);

    // Scriptlets are phase 3; `#%#` is AdGuard's scriptlet syntax.
    if (body.startsWith('+js(') || body.startsWith('//scriptlet') || modifier === '%') return null;
    if (body === '') return null;

    const domains: string[] = [];
    const excludedDomains: string[] = [];
    for (const entry of domainPart.split(',')) {
        const domain = entry.trim().toLowerCase();
        if (domain === '') continue;
        // uBO spells "every domain" as a bare `*`; it is a generic filter, not
        // a domain named "*". Treated literally it yields the match pattern
        // `*://*.*/*`, which Chrome rejects — taking the whole manifest with it.
        if (domain === '*') continue;
        if (domain.startsWith('~')) excludedDomains.push(domain.slice(1));
        else domains.push(domain);
    }

    let kind: CosmeticKind = isException ? 'exception' : 'hide';
    let declaration: string | null = null;

    // `#$#` injects a declaration block: `example.com#$#body { color: red; }`.
    if (modifier === '$' || modifier === '$?') {
        const brace = body.indexOf('{');
        if (brace === -1) return null;
        const close = body.lastIndexOf('}');
        if (close <= brace) return null;
        declaration = body.slice(brace + 1, close).trim();
        body = body.slice(0, brace).trim();
        kind = isException ? 'exception' : 'style';
    } else {
        // uBO spells the same thing `selector:style(declaration)`.
        const style = STYLE_RE.exec(body);
        if (style !== null) {
            declaration = style[1];
            body = body.slice(0, style.index).trim();
            kind = isException ? 'exception' : 'style';
        }
    }

    if (!isPlausibleSelector(body)) return null;

    return {
        raw: line,
        kind,
        selector: body,
        declaration,
        // `:has()` is native CSS in Chrome — deliberately not procedural.
        isProcedural: PROCEDURAL_RE.test(body),
        domains,
        excludedDomains,
        isGeneric: domains.length === 0,
    };
}

export function parseCosmeticList(content: string): CosmeticFilter[] {
    const filters: CosmeticFilter[] = [];
    for (const line of content.split('\n')) {
        const parsed = parseCosmeticFilter(line);
        if (parsed !== null) filters.push(parsed);
    }
    return filters;
}
