/**
 * Scriptlets that edit JavaScript values in flight: what `JSON.parse` returns,
 * what a function is called with, what a property reads as.
 */

import { installing } from './helpers.js';
import { JSONPath } from './jsonpath.js';
import { objectPrune } from './object-prune.js';
import { proxyApply } from './proxy-apply.js';
import { initPattern, natives, parseVarargs, patternToRegex, runAt, testPattern } from './safe.js';

/** `json-prune`: removes properties from everything `JSON.parse` returns. */
export function jsonPrune(rawPrunePaths = '', rawNeedlePaths = '', stackNeedle = ''): void {
    const stackNeedleDetails = initPattern(stackNeedle, { canNegate: true });
    proxyApply('JSON.parse', (context) => {
        const objBefore = context.reflect();
        const objAfter = objectPrune(objBefore, rawPrunePaths, rawNeedlePaths, stackNeedleDetails);
        return objAfter === undefined ? objBefore : objAfter;
    });
}

function jsonEditFn(trusted: boolean, jsonq = '', ...varargs: string[]): void {
    const jsonp = JSONPath.create(jsonq);
    if (!jsonp.valid || (jsonp.value !== undefined && !trusted)) return;
    const extraArgs = parseVarargs(varargs);
    const pattern = extraArgs.matches ? initPattern(`${extraArgs.matches}`) : undefined;
    proxyApply('JSON.parse', (context) => {
        const json = context.callArgs[0];
        const obj = context.reflect();
        if (pattern && typeof json === 'string' && !testPattern(pattern, json)) return obj;
        const objAfter = jsonp.apply(obj);
        return objAfter === undefined ? obj : objAfter;
    });
}

export const jsonEdit = (...args: string[]): void => jsonEditFn(false, ...args);
export const trustedJsonEdit = (...args: string[]): void => jsonEditFn(true, ...args);

/**
 * Edits one argument of every call to a function, before the call is made.
 *
 * The argument is cloned first and the clone edited: the caller's own object
 * is left as it was, so the page cannot observe that anything changed by
 * looking at what it passed in.
 */
function editInboundObjectFn(trusted: boolean, propChain = '', argPosRaw = '', jsonq = ''): void {
    if (propChain === '') return;
    const jsonp = JSONPath.create(jsonq);
    if (!jsonp.valid || (jsonp.value !== undefined && !trusted)) return;
    const argPos = parseInt(argPosRaw, 10);
    if (isNaN(argPos)) return;
    const { structuredClone } = natives();

    // A negative position counts from the last argument.
    const indexOf = (args: unknown[]): number | undefined => {
        if (!Array.isArray(args)) return undefined;
        if (argPos >= 0) return args.length <= argPos ? undefined : argPos;
        return args.length < -argPos ? undefined : args.length + argPos;
    };
    const edit = (obj: unknown): unknown => {
        // Nearly every call is not the one the filter is about. Looking first
        // costs a few property reads; cloning first would deep-copy every
        // object the page ever passes to this function, once per filter — and
        // on a watch page that function is `JSON.stringify`, nine filters deep.
        //
        // Whatever goes wrong in here — an object that throws when read, one
        // that cannot be cloned — the page's call goes ahead unedited.
        try {
            if (jsonp.evaluate(obj).length === 0) return undefined;
            const clone = structuredClone(obj);
            if (typeof clone !== 'object' || clone === null) return undefined;
            return jsonp.apply(clone);
        } catch {
            return undefined;
        }
    };
    proxyApply(propChain, (context) => {
        const i = indexOf(context.callArgs);
        if (i !== undefined) {
            const objBefore = context.callArgs[i];
            if (typeof objBefore === 'object') {
                const objAfter = edit(objBefore);
                if (objAfter) context.callArgs[i] = objAfter;
            }
        }
        return context.reflect();
    });
}

export const editInboundObject = (...args: string[]): void => editInboundObjectFn(false, ...args);
export const trustedEditInboundObject = (...args: string[]): void => editInboundObjectFn(true, ...args);

/**
 * Stops a page from fetching pristine natives out of a throwaway iframe.
 *
 * A fresh `about:blank` frame has its own untouched `fetch` and `JSON.parse`.
 * A page that knows its own have been wrapped appends such a frame and uses
 * the frame's instead. This watches the method used to attach the frame and,
 * as soon as it is attached, points the named properties of the frame's
 * window back at this window's — the wrapped ones.
 */
export function trustedPreventDomBypass(methodPath = '', targetProp = ''): void {
    if (methodPath === '') return;
    proxyApply(methodPath, (context) => {
        const elems = new Set(context.callArgs.filter((e) => e instanceof HTMLElement));
        const r = context.reflect();
        for (const elem of elems as Set<HTMLIFrameElement>) {
            try {
                const inner = elem.contentWindow as any;
                if (`${inner}` !== '[object Window]') continue;
                if (inner.location.href !== 'about:blank' && inner.location.href !== self.location.href) {
                    continue;
                }
                if (targetProp !== '') {
                    let me: any = self;
                    let it: any = inner;
                    for (let chain of targetProp.split(/\s+/)) {
                        for (;;) {
                            const dot = chain.indexOf('.');
                            if (dot === -1) break;
                            const prop = chain.slice(0, dot);
                            me = me[prop];
                            it = it[prop];
                            chain = chain.slice(dot + 1);
                        }
                        it[chain] = me[chain];
                    }
                } else {
                    Object.defineProperty(elem, 'contentWindow', { value: self });
                }
            } catch {
                // A cross-origin frame, or one already gone.
            }
        }
        return r;
    });
}

const INVALID = Symbol('invalid');

/** Reads a `set-constant` value. Only a fixed vocabulary is allowed unless trusted. */
function validateConstant(trusted: boolean, raw: string, extraArgs: Record<string, unknown>): unknown {
    let value: unknown;
    if (raw === 'undefined') value = undefined;
    else if (raw === 'false') value = false;
    else if (raw === 'true') value = true;
    else if (raw === 'null') value = null;
    else if (raw === "''" || raw === '') value = '';
    else if (raw === '[]' || raw === 'emptyArr') value = [];
    else if (raw === '{}' || raw === 'emptyObj') value = {};
    else if (raw === 'noopFunc') value = function () { /* noop */ };
    else if (raw === 'trueFunc') value = function () { return true; };
    else if (raw === 'falseFunc') value = function () { return false; };
    else if (raw === 'throwFunc') value = function () { throw ''; };
    else if (/^-?\d+$/.test(raw)) {
        value = parseInt(raw);
        if (Math.abs(value as number) > 0x7FFF) return INVALID;
    } else if (trusted) {
        if (raw.startsWith('json:')) {
            try { value = natives().jsonParse(raw.slice(5)); } catch { return INVALID; }
        } else if (raw.startsWith('{') && raw.endsWith('}')) {
            try { value = (natives().jsonParse(raw) as { value: unknown }).value; } catch { return INVALID; }
        }
    } else {
        return INVALID;
    }
    if (extraArgs.as !== undefined) {
        const constant = value;
        if (extraArgs.as === 'function') return () => constant;
        if (extraArgs.as === 'callback') return () => (() => constant);
        if (extraArgs.as === 'resolved') return Promise.resolve(constant);
        if (extraArgs.as === 'rejected') {
            const rejected = Promise.reject(constant);
            // Whoever reads the property may never attach a handler.
            rejected.catch(() => { /* by design */ });
            return rejected;
        }
    }
    return value;
}

interface Trap {
    init(v: unknown): boolean;
    getter(): unknown;
    setter(a: unknown): void;
}

/**
 * `set-constant`: pins a property, however deep, to a fixed value.
 *
 * The chain may not exist yet — `ytInitialPlayerResponse.adPlacements` is set
 * on an object the page has not created — so each missing level is trapped
 * and the trap moved down as the page builds the objects.
 */
function setConstantFn(trusted: boolean, chain = '', rawValue = '', ...varargs: string[]): void {
    if (chain === '') return;
    const extraArgs = parseVarargs(varargs);
    const install = (): void => {
        const dot = chain.lastIndexOf('.');
        const trappedProp = dot === -1 ? chain : chain.slice(dot + 1);
        if (trappedProp === '') return;
        const thisScript = document.currentScript;
        let normalValue = validateConstant(trusted, rawValue, extraArgs);
        if (normalValue === INVALID) normalValue = undefined;
        if (rawValue === 'noopFunc' || rawValue === 'trueFunc' || rawValue === 'falseFunc') {
            // The stand-in function reports itself as a native of that name.
            const fn = normalValue as Function;
            Object.defineProperty(fn, 'name', { value: trappedProp });
            normalValue = new Proxy(fn, {
                defineProperty(target, prop, descriptor) {
                    return prop !== 'toString' ? Reflect.defineProperty(target, prop, descriptor) : true;
                },
                deleteProperty(target, prop) {
                    return prop !== 'toString' ? Reflect.deleteProperty(target, prop) : true;
                },
                get(target, prop, receiver) {
                    if (prop === 'toString') {
                        return function () { return `function ${trappedProp}() { [native code] }`; }.bind(null);
                    }
                    return Reflect.get(target, prop, receiver);
                },
            });
        }
        let aborted = false;
        // The page already holds a value of another type there: forcing ours
        // would break it, so the property is left to the page.
        const mustAbort = (v: unknown): boolean => {
            if (trusted) return false;
            if (aborted) return true;
            aborted = (v !== undefined && v !== null)
                && (normalValue !== undefined && normalValue !== null)
                && (typeof v !== typeof normalValue);
            return aborted;
        };
        const trapProp = (owner: any, prop: string, configurable: boolean, handler: Trap): void => {
            if (!handler.init(configurable ? owner[prop] : normalValue)) return;
            const odesc = Object.getOwnPropertyDescriptor(owner, prop);
            let prevGetter: (() => unknown) | undefined;
            let prevSetter: ((a: unknown) => void) | undefined;
            if (odesc instanceof Object) {
                try { owner[prop] = normalValue; } catch { /* read-only: the trap below decides */ }
                if (odesc.get instanceof Function) prevGetter = odesc.get;
                if (odesc.set instanceof Function) prevSetter = odesc.set;
            }
            try {
                Object.defineProperty(owner, prop, {
                    configurable,
                    get() {
                        if (prevGetter !== undefined) prevGetter();
                        return handler.getter();
                    },
                    set(a: unknown) {
                        if (prevSetter !== undefined) prevSetter(a);
                        handler.setter(a);
                    },
                });
            } catch {
                // Not configurable: someone locked it first.
            }
        };
        const trapChain = (owner: any, rest: string): void => {
            const pos = rest.indexOf('.');
            if (pos === -1) {
                let held: unknown;
                trapProp(owner, rest, false, {
                    init(v) {
                        if (mustAbort(v)) return false;
                        held = v;
                        return true;
                    },
                    getter() {
                        // Our own installation sees the real value, so that
                        // a second trap on the same property starts from it.
                        const ours = thisScript !== null
                            ? document.currentScript === thisScript
                            : installing.active;
                        return ours ? held : normalValue;
                    },
                    setter(a) {
                        if (!mustAbort(a)) return;
                        normalValue = a;
                    },
                });
                return;
            }
            const prop = rest.slice(0, pos);
            const v = owner[prop];
            const tail = rest.slice(pos + 1);
            if (v instanceof Object || (typeof v === 'object' && v !== null)) {
                trapChain(v, tail);
                return;
            }
            let held: unknown;
            trapProp(owner, prop, true, {
                init(initial) { held = initial; return true; },
                getter() { return held; },
                setter(a) {
                    held = a;
                    if (a instanceof Object) trapChain(a, tail);
                },
            });
        };
        trapChain(window, chain);
    };
    runAt(install, extraArgs.runAt);
}

export const setConstant = (...args: string[]): void => setConstantFn(false, ...args);
export const trustedSetConstant = (...args: string[]): void => setConstantFn(true, ...args);

/** Shared by `adjust-setTimeout` and `adjust-setInterval`. */
function adjustTimer(name: 'setTimeout' | 'setInterval', needleArg = '', delayArg = '', boostArg = ''): void {
    if (typeof needleArg !== 'string') return;
    const reNeedle = patternToRegex(needleArg);
    let delay = delayArg !== '*' ? parseInt(delayArg, 10) : -1;
    if (isNaN(delay) || !isFinite(delay)) delay = 1000;
    let boost = parseFloat(boostArg);
    boost = !isNaN(boost) && isFinite(boost) ? Math.min(Math.max(boost, 0.001), 50) : 0.05;
    const g = self as unknown as Record<string, Function>;
    g[name] = new Proxy(g[name], {
        apply(target, thisArg, args: [unknown, number, ...unknown[]]) {
            const [a, b] = args;
            if (delay === -1 || b === delay) {
                let source = '';
                try { source = String(a); } catch { /* a callback that will not be read */ }
                if (reNeedle.test(source)) args[1] = b * boost;
            }
            return Reflect.apply(target, thisArg, args);
        },
    });
}

/**
 * Speeds up (or slows down) the timers whose callback matches. The delay
 * defaults to 1000 ms and `*` matches any; the factor is clamped to 50× either
 * way and defaults to 0.05.
 */
export const adjustSetTimeout = (...args: string[]): void => adjustTimer('setTimeout', ...args);
export const adjustSetInterval = (...args: string[]): void => adjustTimer('setInterval', ...args);
