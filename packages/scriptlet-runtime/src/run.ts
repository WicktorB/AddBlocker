/**
 * Entry point for the generated scriptlet bucket scripts.
 *
 * Runs at document_start, in the page's own world or in the isolated one
 * depending on the bucket. Each invocation is isolated: one throwing scriptlet
 * must not stop the others.
 */

import { lookup } from './catalog.js';
import { installing } from './helpers.js';

/**
 * `[name, ...args]`, optionally led by `~host|host`: hostnames (and their
 * subdomains) on which this invocation is not to run, for a filter written as
 * `example.com,~shop.example.com##+js(…)`.
 */
export type Invocation = string[];

export interface Runtime {
    run(invocations: Invocation[]): void;
}

/** Whether `host` is `domain` or one of its subdomains. */
function isUnder(host: string, domain: string): boolean {
    return host === domain || host.endsWith(`.${domain}`);
}

function createRuntime(): Runtime {
    // A page can be served by several buckets — one holds the rules for
    // `example.com`, another those for `www.example.com` — and the lists often
    // repeat a rule at both levels. Wrapping `fetch` twice with the same
    // rewrite is wasted work on every request, so each invocation runs once.
    const done = new Set<string>();

    return {
        run(invocations) {
            const host = typeof location === 'object' ? location.hostname : '';
            installing.active = true;
            try {
                for (const invocation of invocations) {
                    let [name, ...args] = invocation;
                    if (name.startsWith('~')) {
                        if (name.slice(1).split('|').some((domain) => isUnder(host, domain))) continue;
                        [name, ...args] = args;
                    }
                    const key = JSON.stringify([name, ...args]);
                    if (done.has(key)) continue;
                    done.add(key);
                    const scriptlet = lookup(name);
                    if (scriptlet === undefined) continue;
                    try {
                        scriptlet(...args);
                    } catch {
                        // A failing scriptlet is a broken filter, not a reason
                        // to abandon the rest of the page's protection.
                    }
                }
            } finally {
                installing.active = false;
            }
        },
    };
}

// The runtime file is injected once per matching bucket. The first copy to run
// owns the state; the others find it and step aside.
//
// Spelled `globalThis.__addblockerScriptlets` in full, every time: the
// userscript build redirects exactly that expression to a local variable, so
// the page never gets to see a global with our name on it.
declare global {
    // eslint-disable-next-line no-var
    var __addblockerScriptlets: Runtime | undefined;
}
globalThis.__addblockerScriptlets ??= createRuntime();

export function run(invocations: Invocation[]): void {
    globalThis.__addblockerScriptlets?.run(invocations);
}
