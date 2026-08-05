/**
 * Entry point for the generated scriptlet bucket scripts.
 *
 * Runs in the page's own world (`world: MAIN`) at document_start. Each
 * invocation is isolated: one throwing scriptlet must not stop the others.
 */

import { lookup } from './catalog.js';

export type Invocation = [name: string, ...args: string[]];

export function run(invocations: Invocation[]): void {
    for (const [name, ...args] of invocations) {
        const scriptlet = lookup(name);
        if (scriptlet === undefined) continue;
        try {
            scriptlet(...args);
        } catch {
            // A failing scriptlet is a broken filter, not a reason to abandon
            // the rest of the page's protection.
        }
    }
}

(globalThis as unknown as { __addblockerScriptlets: { run: typeof run } })
    .__addblockerScriptlets = { run };
