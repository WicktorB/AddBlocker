/**
 * Scriptlets that rewrite what a page receives from the network.
 *
 * This is how video ads are removed on sites that serve them from the same
 * hosts as the content, where no network rule can tell the two apart: the
 * player asks its own API what to play, and the answer is edited — the ad
 * descriptors taken out — before the player reads it.
 *
 * Two transports have to be covered, `fetch` and `XMLHttpRequest`, and for
 * each there is a structural variant (prune or edit the parsed JSON) and a
 * textual one (regex over the body). All of them follow one rule: when in
 * doubt, hand back exactly what the network returned. A response that cannot
 * be read, does not match, or comes out unchanged is passed through untouched,
 * and a failure in here never becomes an error the page — or the browser's
 * extension error log — gets to see.
 */

import { JSONPath } from './jsonpath.js';
import { objectPrune } from './object-prune.js';
import {
    collateFetchArguments, matchObjectProperties, parsePropertiesToMatch, type PropNeedles,
} from './props.js';
import { cloak } from './proxy-apply.js';
import { initPattern, natives, parseVarargs, patternToRegex } from './safe.js';

type FetchFn = typeof fetch;

/**
 * Wraps `fetch` so `transform` may substitute the response of the requests
 * that match `needles`. `transform` returns `undefined` to keep the original.
 */
function interceptFetch(
    needles: PropNeedles,
    transform: (response: Response) => Promise<Response | undefined>,
    cloaked: boolean,
): void {
    const g = globalThis as unknown as { fetch: FetchFn };
    const original = g.fetch;
    if (typeof original !== 'function') return;
    const proxied = new Proxy(original, {
        apply(target, thisArg, args: Parameters<FetchFn>) {
            const fetchPromise: Promise<Response> = Reflect.apply(target, thisArg, args);
            if (needles.size !== 0) {
                if (matchObjectProperties(needles, collateFetchArguments(...args)) === undefined) {
                    return fetchPromise;
                }
            }
            return fetchPromise.then((responseBefore) => (
                transform(responseBefore.clone())
                    .then((responseAfter) => responseAfter ?? responseBefore)
                    .catch(() => responseBefore)
            // A request that failed stays failed, with its own error.
            )).catch(() => fetchPromise);
        },
    });
    if (cloaked) cloak(proxied, original);
    g.fetch = proxied;
}

/** A response that differs from `before` by its body only. */
function substitute(before: Response, body: { json: unknown } | { text: string }): Response {
    const init = { status: before.status, statusText: before.statusText, headers: before.headers };
    let after: Response;
    if ('text' in body) {
        after = new Response(body.text, init);
    } else if (typeof (Response as unknown as { json?: unknown }).json === 'function') {
        after = (Response as unknown as { json(data: unknown, init: ResponseInit): Response })
            .json(body.json, init);
    } else {
        // Engines without the static `Response.json` (older WebKit).
        after = new Response(natives().jsonStringify(body.json), init);
    }
    Object.defineProperties(after, {
        ok: { value: before.ok },
        redirected: { value: before.redirected },
        type: { value: before.type },
        url: { value: before.url },
    });
    return after;
}

interface XhrDetails {
    method: unknown;
    url: unknown;
    response?: unknown;
    lastResponseLength?: number;
}

/**
 * Replaces `XMLHttpRequest` with a subclass whose `response` — for the
 * requests matching `needles` — goes through `transform`.
 *
 * The result is cached per request and recomputed only when the underlying
 * text has grown, so reading `responseText` on every progress event does not
 * re-run a regex over megabytes each time, and the page gets the same object
 * back on every read.
 */
function interceptXhr(
    needles: PropNeedles,
    transform: (response: unknown) => unknown,
): void {
    const g = globalThis as unknown as { XMLHttpRequest: typeof XMLHttpRequest };
    if (typeof g.XMLHttpRequest !== 'function') return;
    const instances = new WeakMap<object, XhrDetails>();
    g.XMLHttpRequest = class extends g.XMLHttpRequest {
        open(method: string, url: string | URL, ...rest: unknown[]): void {
            const details: XhrDetails = { method, url };
            if (needles.size === 0 || matchObjectProperties(needles, details) !== undefined) {
                instances.set(this, details);
            }
            return super.open(method, url, ...(rest as [boolean, string?, string?]));
        }

        get response(): unknown {
            const inner = super.response;
            const details = instances.get(this);
            if (details === undefined) return inner;
            const length = typeof inner === 'string' ? inner.length : undefined;
            if (details.lastResponseLength !== length) {
                details.response = undefined;
                details.lastResponseLength = length;
            }
            if (details.response !== undefined) return details.response;
            let outer = inner;
            // A rewrite that fails leaves the page with what the server sent.
            try { outer = transform(inner); } catch { /* keep the original */ }
            return (details.response = outer);
        }

        get responseText(): string {
            const response = this.response;
            return typeof response !== 'string' ? super.responseText : response;
        }
    };
}

/** Parses an XHR body that may be a string or, with `responseType: 'json'`, an object. */
function xhrBodyToObject(inner: unknown): unknown {
    if (typeof inner === 'object') return inner;
    if (typeof inner === 'string') {
        try { return natives().jsonParse(inner); } catch { /* not JSON */ }
    }
    return undefined;
}

/** `/` escaped as `\/`, as a server would for JSON embedded in a script. */
function toJson(obj: unknown): string {
    return natives().jsonStringify(obj).replace(/\//g, '\\/');
}

export function jsonPruneFetchResponse(rawPrunePaths = '', rawNeedlePaths = '', ...varargs: string[]): void {
    const extraArgs = parseVarargs(varargs);
    const needles = parsePropertiesToMatch(extraArgs.propsToMatch, 'url');
    const stackNeedle = initPattern(`${extraArgs.stackToMatch || ''}`, { canNegate: true });
    interceptFetch(needles, (response) => response.json().then((objBefore) => {
        if (typeof objBefore !== 'object') return undefined;
        if (rawPrunePaths === '') return undefined;
        const objAfter = objectPrune(objBefore, rawPrunePaths, rawNeedlePaths, stackNeedle);
        if (typeof objAfter !== 'object') return undefined;
        return substitute(response, { json: objAfter });
    }), false);
}

export function jsonPruneXhrResponse(rawPrunePaths = '', rawNeedlePaths = '', ...varargs: string[]): void {
    const extraArgs = parseVarargs(varargs);
    const needles = parsePropertiesToMatch(extraArgs.propsToMatch, 'url');
    const stackNeedle = initPattern(`${extraArgs.stackToMatch || ''}`, { canNegate: true });
    interceptXhr(needles, (inner) => {
        const objBefore = xhrBodyToObject(inner);
        if (typeof objBefore !== 'object') return inner;
        const objAfter = objectPrune(objBefore, rawPrunePaths, rawNeedlePaths, stackNeedle);
        if (typeof objAfter !== 'object') return inner;
        return typeof inner === 'string' ? natives().jsonStringify(objAfter) : objAfter;
    });
}

export function trustedReplaceFetchResponse(
    pattern = '', replacement = '', propsToMatch = '', ...varargs: string[]
): void {
    if (pattern === '*') pattern = '.*';
    const rePattern = patternToRegex(pattern);
    const needles = parsePropertiesToMatch(propsToMatch, 'url');
    const extraArgs = parseVarargs(varargs);
    const reIncludes = extraArgs.includes ? patternToRegex(`${extraArgs.includes}`) : null;
    if (pattern === '') return;
    interceptFetch(needles, (response) => response.text().then((textBefore) => {
        if (reIncludes && !reIncludes.test(textBefore)) return undefined;
        const textAfter = textBefore.replace(rePattern, replacement);
        if (textAfter === textBefore) return undefined;
        return substitute(response, { text: textAfter });
    }), false);
}

export function trustedReplaceXhrResponse(
    pattern = '', replacement = '', propsToMatch = '', ...varargs: string[]
): void {
    if (pattern === '*') pattern = '.*';
    const rePattern = patternToRegex(pattern);
    const needles = parsePropertiesToMatch(propsToMatch, 'url');
    const extraArgs = parseVarargs(varargs);
    const reIncludes = extraArgs.includes ? patternToRegex(`${extraArgs.includes}`) : null;
    interceptXhr(needles, (inner) => {
        if (typeof inner !== 'string') return inner;
        if (reIncludes && !reIncludes.test(inner)) return inner;
        return inner.replace(rePattern, replacement);
    });
}

function compileQuery(trusted: boolean, jsonq: string): JSONPath | undefined {
    const jsonp = JSONPath.create(jsonq);
    // Assigning a value is a trusted operation; removing is not.
    if (!jsonp.valid || (jsonp.value !== undefined && !trusted)) return undefined;
    return jsonp;
}

function jsonEditFetchResponseFn(trusted: boolean, jsonq = '', ...varargs: string[]): void {
    const jsonp = compileQuery(trusted, jsonq);
    if (jsonp === undefined) return;
    const extraArgs = parseVarargs(varargs);
    const needles = parsePropertiesToMatch(extraArgs.propsToMatch, 'url');
    interceptFetch(needles, (response) => response.json().then((obj) => {
        if (typeof obj !== 'object') return undefined;
        const objAfter = jsonp.apply(obj);
        if (objAfter === undefined) return undefined;
        return substitute(response, { json: objAfter });
    }), true);
}

function jsonEditXhrResponseFn(trusted: boolean, jsonq = '', ...varargs: string[]): void {
    const jsonp = compileQuery(trusted, jsonq);
    if (jsonp === undefined) return;
    const extraArgs = parseVarargs(varargs);
    const needles = parsePropertiesToMatch(extraArgs.propsToMatch, 'url');
    interceptXhr(needles, (inner) => {
        const obj = xhrBodyToObject(inner);
        if (typeof obj !== 'object' || obj === null) return inner;
        const objAfter = jsonp.apply(obj);
        if (objAfter === undefined) return inner;
        return typeof inner === 'string' ? toJson(objAfter) : objAfter;
    });
}

export const jsonEditFetchResponse = (...args: string[]): void => jsonEditFetchResponseFn(false, ...args);
export const trustedJsonEditFetchResponse = (...args: string[]): void => jsonEditFetchResponseFn(true, ...args);
export const jsonEditXhrResponse = (...args: string[]): void => jsonEditXhrResponseFn(false, ...args);
export const trustedJsonEditXhrResponse = (...args: string[]): void => jsonEditXhrResponseFn(true, ...args);
