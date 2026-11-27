/**
 * Conventions shared by every scriptlet, aligned on uBlock Origin's.
 *
 * The filter lists are written against uBO's scriptlets, so the way an
 * argument is read — when it is a regex, when a leading `!` negates, how the
 * trailing `name, value` pairs are paired up — has to be uBO's way exactly.
 * A scriptlet that reads its arguments slightly differently is a scriptlet
 * that silently does nothing on the one site the filter was written for.
 *
 * The natives are captured on first use rather than at module load: this file
 * is also imported by the build, under Node, where half of them do not exist.
 * At run time the first use is at document_start, before any page script, so
 * what is captured is still the browser's own.
 */

export interface Natives {
    regExpTest: (re: RegExp, text: string) => boolean;
    jsonParse: (text: string) => unknown;
    jsonStringify: (value: unknown, replacer?: null, indent?: number) => string;
    hasOwn: (owner: unknown, key: PropertyKey) => boolean;
    structuredClone: <T>(value: T) => T;
    objectToString: (value: unknown) => string;
    requestClone: ((request: Request) => Request) | undefined;
    addEventListener: typeof EventTarget.prototype.addEventListener | undefined;
    removeEventListener: typeof EventTarget.prototype.removeEventListener | undefined;
}

const hasOwnProperty = Object.prototype.hasOwnProperty;

/**
 * `Object.hasOwn`, spelled the old way: the userscript runs on iPhones whose
 * Safari predates it, and one missing method there would take every scriptlet
 * down with it.
 */
export function hasOwn(owner: unknown, key: PropertyKey): boolean {
    return hasOwnProperty.call(owner, key);
}

let captured: Natives | undefined;

export function natives(): Natives {
    if (captured !== undefined) return captured;
    const g = globalThis as unknown as Record<string, any>;
    const call = Function.prototype.call;
    const parse = JSON.parse;
    const stringify = JSON.stringify;
    captured = {
        regExpTest: call.bind(RegExp.prototype.test) as Natives['regExpTest'],
        jsonParse: (text) => parse(text),
        jsonStringify: (value, replacer, indent) => stringify(value, replacer, indent),
        hasOwn,
        structuredClone: typeof g.structuredClone === 'function'
            ? g.structuredClone.bind(g)
            : (value) => parse(stringify(value)),
        objectToString: call.bind(Object.prototype.toString) as Natives['objectToString'],
        requestClone: typeof g.Request === 'function'
            ? call.bind(g.Request.prototype.clone) as Natives['requestClone']
            : undefined,
        addEventListener: g.EventTarget?.prototype.addEventListener,
        removeEventListener: g.EventTarget?.prototype.removeEventListener,
    };
    return captured;
}

export function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `/body/flags`, as the lists write a regex argument. */
const REGEX_LITERAL = /^\/(.+)\/([gimsu]*)$/;

export interface PatternDetails {
    matchAll?: true;
    re?: RegExp;
    pattern?: string;
    /** `false` when the pattern was negated with a leading `!`. */
    expect: boolean;
}

/**
 * Compiles a "needle" argument: empty matches everything, `/…/` is a regex,
 * anything else a substring. With `canNegate`, a leading `!` inverts it.
 */
export function initPattern(
    pattern: string,
    options: { canNegate?: boolean; flags?: string } = {},
): PatternDetails {
    if (pattern === '') return { matchAll: true, expect: true };
    const expect = options.canNegate !== true || !pattern.startsWith('!');
    const body = expect ? pattern : pattern.slice(1);
    const literal = REGEX_LITERAL.exec(body);
    if (literal !== null) {
        return { re: new RegExp(literal[1], literal[2] || options.flags), expect };
    }
    if (options.flags !== undefined) {
        return { re: new RegExp(escapeRegex(body), options.flags), expect };
    }
    return { pattern: body, expect };
}

export function testPattern(details: PatternDetails, haystack: unknown): boolean {
    if (details.matchAll) return true;
    if (details.re !== undefined) {
        return natives().regExpTest(details.re, haystack as string) === details.expect;
    }
    return `${haystack}`.includes(details.pattern ?? '') === details.expect;
}

/**
 * Turns an argument into a regex. A plain string matches itself, literally;
 * `flags` and `verbatim` only apply to that case — a `/…/` literal carries its
 * own flags and nothing is added to them.
 */
export function patternToRegex(pattern: string, flags?: string, verbatim = false): RegExp {
    if (pattern === '') return /^/;
    const literal = REGEX_LITERAL.exec(pattern);
    if (literal === null) {
        const source = escapeRegex(pattern);
        return new RegExp(verbatim ? `^${source}$` : source, flags);
    }
    try {
        return new RegExp(literal[1], literal[2] || undefined);
    } catch {
        return /^/;
    }
}

/** Reads the trailing `name, value, name, value` arguments into an object. */
export function parseVarargs(varargs: string[]): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (let i = 0; i < varargs.length; i += 2) {
        const raw = varargs[i + 1];
        out[varargs[i]] = /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
    }
    return out;
}

/** A name no page can guess, for anything that has to be created under one. */
export function randomToken(): string {
    return String.fromCharCode(Date.now() % 26 + 97)
        + Math.floor(Math.random() * 982451653 + 982451653).toString(36);
}

type ReadyTarget = 'loading' | 'asap' | 'interactive' | 'end' | 'complete' | 'idle' | string | number;

const READY_STATES: Record<string, number> = {
    loading: 1, asap: 1,
    interactive: 2, end: 2, 2: 2,
    complete: 3, idle: 3, 3: 3,
};

/** Runs `fn` once the document has reached the given load milestone. */
export function runAt(fn: () => void, when: ReadyTarget | undefined): void {
    const rank = (state: unknown): number => {
        const key = `${state}`;
        return hasOwn(READY_STATES, key) ? READY_STATES[key] : 0;
    };
    const wanted = rank(when);
    if (rank(document.readyState) >= wanted) { fn(); return; }
    const { addEventListener, removeEventListener } = natives();
    const args: [string, () => void, { capture: boolean }] = ['readystatechange', () => {
        if (rank(document.readyState) < wanted) return;
        fn();
        removeEventListener?.apply(document, args);
    }, { capture: true }];
    addEventListener?.apply(document, args);
}
