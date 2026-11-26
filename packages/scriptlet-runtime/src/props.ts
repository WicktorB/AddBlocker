/**
 * Matching a request against the `propsToMatch` argument.
 *
 * The argument is a space-separated list of `prop:needle` pairs — `url:/player`
 * `method:POST` — and a bare needle is matched against the URL. Every pair has
 * to hold for the request to be the one the filter is about.
 */

import { initPattern, natives, testPattern, type PatternDetails } from './safe.js';

export type PropNeedles = Map<string, PatternDetails>;

export function parsePropertiesToMatch(propsToMatch: unknown, implicit = ''): PropNeedles {
    const needles: PropNeedles = new Map();
    if (propsToMatch === undefined || propsToMatch === '') return needles;
    const options = { canNegate: true };
    for (const needle of `${propsToMatch}`.split(/\s+/)) {
        let [prop, pattern] = needle.split(':') as [string, string | undefined];
        if (prop === '') continue;
        // `https://…` is not a property named `https`: put the colon back.
        if (pattern !== undefined && /[^$\w -]/.test(prop)) {
            prop = `${prop}:${pattern}`;
            pattern = undefined;
        }
        if (pattern !== undefined) {
            needles.set(prop, initPattern(pattern, options));
        } else if (implicit !== '') {
            needles.set(implicit, initPattern(prop, options));
        }
    }
    return needles;
}

/**
 * Returns what matched, or `undefined` as soon as one needle does not. A
 * property the object does not have is not a mismatch — it is skipped.
 */
export function matchObjectProperties(needles: PropNeedles, ...objs: unknown[]): string[] | undefined {
    const matched: string[] = [];
    for (const obj of objs) {
        if (!(obj instanceof Object)) continue;
        for (const [prop, details] of needles) {
            let value = (obj as Record<string, unknown>)[prop];
            if (value === undefined) continue;
            if (typeof value !== 'string') {
                try { value = natives().jsonStringify(value); } catch { /* not serialisable */ }
                if (typeof value !== 'string') continue;
            }
            if (!testPattern(details, value)) return undefined;
            matched.push(`${prop}: ${value}`);
        }
    }
    return matched;
}

const FETCH_PROPS = [
    'body', 'cache', 'credentials', 'duplex', 'headers',
    'integrity', 'keepalive', 'method', 'mode', 'priority',
    'redirect', 'referrer', 'referrerPolicy', 'url',
] as const;

/** Flattens `fetch(resource, options)` into one object of request properties. */
export function collateFetchArguments(resource?: unknown, options?: unknown): Record<string, unknown> {
    const { objectToString, requestClone } = natives();
    const out: Record<string, unknown> = {};
    const collect = (src: Record<string, unknown>): void => {
        for (const prop of FETCH_PROPS) {
            if (src[prop] === undefined) continue;
            out[prop] = src[prop];
        }
    };
    if (typeof resource !== 'object' || objectToString(resource) !== '[object Request]') {
        out.url = `${resource}`;
    } else {
        let clone: Request | undefined;
        try { clone = requestClone?.(resource as Request); } catch { /* body already used */ }
        collect((clone ?? resource) as unknown as Record<string, unknown>);
    }
    if (typeof options === 'object' && options !== null) collect(options as Record<string, unknown>);
    return out;
}
