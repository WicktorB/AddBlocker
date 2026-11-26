import { parseOptions } from './options.js';
import type { LineKind, NetworkFilter, ParseStats } from './types.js';

/**
 * Every cosmetic/scriptlet separator: `##`, `#@#`, `#?#`, `#@?#`, `#$#`,
 * `#$?#`, `#%#` and their exception forms.
 */
const COSMETIC_MARKER = /#(@)?(\$\?|\?|\$|%)?#/;

export function classifyLine(line: string): LineKind {
    const trimmed = line.trim();
    if (trimmed === '') return 'empty';
    if (trimmed.startsWith('!') || trimmed.startsWith('[Adblock')) return 'comment';

    // A `#` inside a regex literal is not a separator.
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

/** Splits a filter into pattern and options, respecting regex literals. */
function splitOptions(text: string): { pattern: string; optionText: string } {
    if (text.startsWith('/')) {
        const close = text.lastIndexOf('/');
        if (close > 0) {
            const rest = text.slice(close + 1);
            return rest.startsWith('$')
                ? { pattern: text.slice(0, close + 1), optionText: rest.slice(1) }
                : { pattern: text, optionText: '' };
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

/**
 * Reduces `||example.com^` to `example.com`.
 *
 * Only patterns anchored with `||` **and** terminated by `^` qualify. Without
 * the separator, `||example.com` also matches `example.com.evil.net`, which
 * `requestDomains` would not — getting this wrong silently over-blocks.
 */
function extractAnchoredDomain(pattern: string): string | null {
    if (!pattern.startsWith('||')) return null;
    const body = pattern.slice(2);
    if (!body.endsWith('^')) return null;

    const host = body.slice(0, -1);
    if (host === '' || !/^[a-z0-9.-]+$/i.test(host)) return null;
    if (host.startsWith('.') || host.endsWith('.') || !host.includes('.')) return null;
    if (host.includes('..')) return null;
    return host.toLowerCase();
}

export function parseNetworkFilter(line: string): NetworkFilter | null {
    let text = line.trim();
    if (text === '') return null;

    const isException = text.startsWith('@@');
    if (isException) text = text.slice(2);

    const split = splitOptions(text);
    const { optionText } = split;
    // `$script,third-party,domain=a.com|b.com` — options and no pattern — means
    // "every URL, under these conditions"; uBO reads it as `*$…`. Regional
    // lists lean on the form heavily, and treating it as an empty line dropped
    // those filters without even counting them as unconverted.
    const pattern = split.pattern === '' && optionText !== '' ? '*' : split.pattern;
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

export function parseList(content: string): { filters: NetworkFilter[]; stats: ParseStats } {
    const stats: ParseStats = { total: 0, network: 0, cosmetic: 0, scriptlet: 0, comment: 0, empty: 0 };
    const filters: NetworkFilter[] = [];

    for (const line of content.split('\n')) {
        stats.total += 1;
        const kind = classifyLine(line);
        if (kind !== 'network') {
            stats[kind] += 1;
            continue;
        }

        const parsed = parseNetworkFilter(line);
        if (parsed === null) {
            stats.empty += 1;
            continue;
        }
        filters.push(parsed);
        stats.network += 1;
    }

    return { filters, stats };
}
