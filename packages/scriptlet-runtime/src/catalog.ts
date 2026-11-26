/**
 * Scriptlet catalogue.
 *
 * Covers the scriptlets the filter lists actually invoke. Unknown names are
 * reported by the build rather than silently ignored — and the count that
 * matters is not how many invocations are covered but which: the handful that
 * rewrite a video player's API responses are a rounding error by number and
 * the whole of what removes ads on the sites that use them.
 *
 * Most run in the page's own world at document_start, before the site's
 * scripts — the only moment where hooking a global still works. A few only
 * need the DOM and run in the extension's isolated world instead (`worldOf`).
 */

import { abort, armAbort, currentScriptText, definePath, matcher, resolveValue } from './helpers.js';
import { removeNodeText, replaceNodeText } from './node-text.js';
import { hasOwn } from './safe.js';
import {
    adjustSetInterval, adjustSetTimeout, editInboundObject, jsonEdit, jsonPrune, setConstant,
    trustedEditInboundObject, trustedJsonEdit, trustedPreventDomBypass, trustedSetConstant,
} from './objects.js';
import {
    jsonEditFetchResponse, jsonEditXhrResponse, jsonPruneFetchResponse, jsonPruneXhrResponse,
    trustedJsonEditFetchResponse, trustedJsonEditXhrResponse, trustedReplaceFetchResponse,
    trustedReplaceXhrResponse,
} from './responses.js';

export type Scriptlet = (...args: string[]) => void;

/** Aliases used in filter lists, mapped to their canonical name. */
export const ALIASES: Record<string, string> = {
    aopr: 'abort-on-property-read',
    aopw: 'abort-on-property-write',
    acs: 'abort-current-script',
    'abort-current-inline-script': 'abort-current-script',
    acis: 'abort-current-script',
    set: 'set-constant',
    aeld: 'addEventListener-defuser',
    'prevent-addEventListener': 'addEventListener-defuser',
    nostif: 'no-setTimeout-if',
    'prevent-setTimeout': 'no-setTimeout-if',
    nosiif: 'no-setInterval-if',
    'prevent-setInterval': 'no-setInterval-if',
    ra: 'remove-attr',
    nowoif: 'no-window-open-if',
    'prevent-window-open': 'no-window-open-if',
    rmnt: 'remove-node-text',
    'nano-sib': 'adjust-setInterval',
    'nano-setInterval-booster': 'adjust-setInterval',
    'nano-stb': 'adjust-setTimeout',
    'nano-setTimeout-booster': 'adjust-setTimeout',
    rpnt: 'trusted-replace-node-text',
    'replace-node-text': 'trusted-replace-node-text',
    'trusted-rpnt': 'trusted-replace-node-text',
    'trusted-rpfr': 'trusted-replace-fetch-response',
    'trusted-set': 'trusted-set-constant',
    aost: 'abort-on-stack-trace',
    'trusted-set-cookie': 'set-cookie',
    'trusted-set-local-storage-item': 'set-local-storage-item',
    'prevent-fetch': 'no-fetch-if',
    'prevent-xhr': 'no-xhr-if',
};

function setCookie(name: string, value: string, path = '/'): void {
    try {
        const encoded = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
        // One year out, mirroring uBO's default lifetime.
        const expires = new Date(Date.now() + 31_536_000_000).toUTCString();
        document.cookie = `${encoded}; expires=${expires}; path=${path}`;
    } catch { /* cookies may be blocked; nothing to do */ }
}

export const CATALOG: Record<string, Scriptlet> = {
    'abort-on-property-read': (path) => {
        if (!path) return;
        armAbort();
        definePath(window, path, (owner, prop) => {
            try {
                Object.defineProperty(owner, prop, {
                    configurable: false,
                    get: () => abort(),
                    set: () => { /* ignore */ },
                });
            } catch { /* already locked */ }
        });
    },

    'abort-on-property-write': (path) => {
        if (!path) return;
        armAbort();
        definePath(window, path, (owner, prop) => {
            let stored: unknown = owner[prop];
            try {
                Object.defineProperty(owner, prop, {
                    configurable: false,
                    get: () => stored,
                    set: () => abort(),
                });
            } catch { /* already locked */ }
        });
    },

    'abort-current-script': (path, search) => {
        if (!path) return;
        armAbort();
        const matches = matcher(search);
        definePath(window, path, (owner, prop) => {
            const original = owner[prop];
            try {
                Object.defineProperty(owner, prop, {
                    configurable: false,
                    get() {
                        if (matches(currentScriptText())) abort();
                        return original;
                    },
                    set(value: unknown) { (owner as Record<string, unknown>)[prop] = value; },
                });
            } catch { /* already locked */ }
        });
    },

    'addEventListener-defuser': (type, handler) => {
        const matchesType = matcher(type);
        const matchesHandler = matcher(handler);
        const original = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (this: EventTarget, ...args: unknown[]) {
            const [eventType, listener] = args as [string, unknown];
            if (matchesType(String(eventType)) && matchesHandler(String(listener))) return;
            return original.apply(this, args as Parameters<typeof original>);
        } as typeof original;
    },

    'no-setTimeout-if': (search, delay) => {
        const matches = matcher(search);
        const wanted = delay === undefined || delay === '' ? null : Number(delay);
        const original = window.setTimeout;
        window.setTimeout = function (this: unknown, ...args: unknown[]) {
            const [callback, ms] = args as [unknown, number];
            if (matches(String(callback)) && (wanted === null || wanted === ms)) {
                return 0 as unknown as ReturnType<typeof setTimeout>;
            }
            return original.apply(this, args as Parameters<typeof original>);
        } as typeof window.setTimeout;
    },

    'no-setInterval-if': (search, delay) => {
        const matches = matcher(search);
        const wanted = delay === undefined || delay === '' ? null : Number(delay);
        const original = window.setInterval;
        window.setInterval = function (this: unknown, ...args: unknown[]) {
            const [callback, ms] = args as [unknown, number];
            if (matches(String(callback)) && (wanted === null || wanted === ms)) {
                return 0 as unknown as ReturnType<typeof setInterval>;
            }
            return original.apply(this, args as Parameters<typeof original>);
        } as typeof window.setInterval;
    },

    'no-window-open-if': (pattern) => {
        const matches = matcher(pattern);
        const original = window.open;
        window.open = function (this: unknown, ...args: unknown[]) {
            const [url] = args as [string];
            if (matches(String(url ?? ''))) return null;
            return original.apply(this, args as Parameters<typeof original>);
        } as typeof window.open;
    },

    'remove-attr': (attrs, selector, behaviour) => {
        if (!attrs) return;
        const names = attrs.split(/[|,]/).map((a) => a.trim()).filter(Boolean);
        const target = selector === undefined || selector === '' ? `[${names[0]}]` : selector;

        const strip = (): void => {
            let elements: Element[];
            try {
                elements = [...document.querySelectorAll(target)];
            } catch { return; }
            for (const element of elements) {
                for (const name of names) element.removeAttribute(name);
            }
        };

        strip();
        const observer = new MutationObserver(strip);
        const start = (): void => observer.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true,
        });
        if (document.documentElement) start();
        else document.addEventListener('DOMContentLoaded', start, { once: true });
        if (behaviour !== 'stay') setTimeout(() => observer.disconnect(), 10_000);
    },

    'set-cookie': (name, value, path) => {
        if (name) setCookie(name, value ?? '', path);
    },

    'remove-cookie': (pattern) => {
        const matches = matcher(pattern);
        const clear = (): void => {
            for (const pair of document.cookie.split(';')) {
                const name = pair.split('=')[0]?.trim();
                if (name === undefined || name === '' || !matches(name)) continue;
                for (const scope of ['/', location.pathname]) {
                    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${scope}`;
                }
            }
        };
        clear();
        window.addEventListener('load', clear, { once: true });
    },

    'set-local-storage-item': (key, value) => {
        if (!key) return;
        try {
            localStorage.setItem(key, String(resolveValue(value ?? '') ?? value ?? ''));
        } catch { /* storage may be unavailable */ }
    },

    'trusted-click-element': (selector, _extra, delayMs) => {
        if (!selector) return;
        const delay = Number(delayMs ?? 0);
        const click = (): boolean => {
            let element: Element | null;
            try {
                element = document.querySelector(selector);
            } catch { return true; }
            if (element === null) return false;
            (element as HTMLElement).click();
            return true;
        };

        const start = (): void => {
            if (click()) return;
            const observer = new MutationObserver(() => { if (click()) observer.disconnect(); });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => observer.disconnect(), 10_000);
        };

        if (delay > 0) setTimeout(start, delay);
        else if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else start();
    },

    'no-fetch-if': (pattern) => {
        const matches = matcher(pattern);
        const original = window.fetch;
        window.fetch = function (this: unknown, ...args: unknown[]) {
            const [input] = args as [RequestInfo];
            const url = typeof input === 'string' ? input : (input as Request)?.url ?? '';
            if (matches(String(url))) return Promise.resolve(new Response(''));
            return original.apply(this, args as Parameters<typeof original>);
        } as typeof window.fetch;
    },

    'no-xhr-if': (pattern) => {
        const matches = matcher(pattern);
        const original = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
            const [, url] = args as [string, string];
            if (matches(String(url ?? ''))) {
                // Point it somewhere inert rather than throwing, so callers
                // that assume open() succeeds keep working.
                args[1] = 'data:text/plain,';
            }
            return original.apply(this, args as Parameters<typeof original>);
        } as typeof original;
    },

    nowebrtc: () => {
        const Stub = function () { throw new Error('RTCPeerConnection disabled'); };
        for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
            try {
                (window as unknown as Record<string, unknown>)[name] = Stub;
            } catch { /* ignore */ }
        }
    },

    'href-sanitizer': (selector, source) => {
        if (!selector) return;
        const clean = (): void => {
            let anchors: Element[];
            try {
                anchors = [...document.querySelectorAll(selector)];
            } catch { return; }
            for (const anchor of anchors) {
                const href = anchor.getAttribute('href');
                if (href === null) continue;
                try {
                    const url = new URL(href, location.href);
                    // Default behaviour: unwrap a redirect carried in `?url=`.
                    const param = source === undefined || source === '' || source === '?'
                        ? url.searchParams.get('url') ?? url.searchParams.get('u')
                        : url.searchParams.get(source.replace(/^\?/, ''));
                    if (param !== null && /^https?:\/\//.test(param)) anchor.setAttribute('href', param);
                } catch { /* not a URL we can parse */ }
            }
        };
        clean();
        document.addEventListener('DOMContentLoaded', clean, { once: true });
    },

    'abort-on-stack-trace': (path, needle) => {
        if (!path) return;
        armAbort();
        const matches = matcher(needle);
        definePath(window, path, (owner, prop) => {
            const original = owner[prop];
            try {
                Object.defineProperty(owner, prop, {
                    configurable: false,
                    get() {
                        if (matches(new Error().stack ?? '')) abort();
                        return original;
                    },
                    set: () => { /* ignore */ },
                });
            } catch { /* already locked */ }
        });
    },

    'set-constant': setConstant,
    'trusted-set-constant': trustedSetConstant,
    'adjust-setTimeout': adjustSetTimeout,
    'adjust-setInterval': adjustSetInterval,

    'remove-node-text': removeNodeText,
    'trusted-replace-node-text': replaceNodeText,

    'json-prune': jsonPrune,
    'json-prune-fetch-response': jsonPruneFetchResponse,
    'json-prune-xhr-response': jsonPruneXhrResponse,
    'json-edit': jsonEdit,
    'trusted-json-edit': trustedJsonEdit,
    'json-edit-fetch-response': jsonEditFetchResponse,
    'trusted-json-edit-fetch-response': trustedJsonEditFetchResponse,
    'json-edit-xhr-response': jsonEditXhrResponse,
    'trusted-json-edit-xhr-response': trustedJsonEditXhrResponse,
    'trusted-replace-fetch-response': trustedReplaceFetchResponse,
    'trusted-replace-xhr-response': trustedReplaceXhrResponse,
    'edit-inbound-object': editInboundObject,
    'trusted-edit-inbound-object': trustedEditInboundObject,
    'trusted-prevent-dom-bypass': trustedPreventDomBypass,
};

/** The name a scriptlet is implemented under, whatever alias a list used. */
export function canonicalName(name: string): string {
    return ALIASES[name] ?? name;
}

/** Resolves an alias to its implementation. */
export function lookup(name: string): Scriptlet | undefined {
    const canonical = canonicalName(name);
    return hasOwn(CATALOG, canonical) ? CATALOG[canonical] : undefined;
}

/**
 * Whether a scriptlet may only be used by a list we trust.
 *
 * The `trusted-` scriptlets take text from the filter and put it into the
 * page — a replacement string, a cookie value, a JSON fragment. uBlock Origin
 * honours them from its own lists only, so that a third-party list cannot use
 * them to inject content; the same line is drawn here.
 */
export function requiresTrust(name: string): boolean {
    return name.startsWith('trusted-') || canonicalName(name).startsWith('trusted-');
}

export type World = 'MAIN' | 'ISOLATED';

/** These only read and write the DOM, and are better off out of the page's reach. */
const ISOLATED_WORLD = new Set(['remove-node-text', 'trusted-replace-node-text']);

export function worldOf(name: string): World {
    return ISOLATED_WORLD.has(canonicalName(name)) ? 'ISOLATED' : 'MAIN';
}
