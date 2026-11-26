/**
 * Content-script entry point.
 *
 * Runs at document_start in the isolated world. Plain CSS goes into a
 * stylesheet immediately — that is what prevents the flash of an ad appearing
 * before it disappears. Procedural selectors need the DOM, so they are
 * evaluated once it exists and re-evaluated on mutation.
 */

import { HIDE_DECLARATION, buildCss, type CosmeticPayload } from './css.js';
import { parseProcedural, resolve, type ProceduralSelector } from './procedural.js';

export { SELECTORS_PER_RULE, buildCss } from './css.js';
export type { CosmeticPayload } from './css.js';

/** How long after start-up the page is treated as still settling. */
const SETTLING_WINDOW_MS = 10_000;
/**
 * Coalescing delays for mutation bursts.
 *
 * Zero while the page is still parsing: a procedural selector can only be
 * evaluated once its target exists, so any delay between insertion and
 * evaluation is a window where the ad is on screen. Once the document is
 * complete, batching is worth the few frames it saves. And once the page has
 * settled, what remains is content arriving as the user scrolls — a sponsored
 * post in a feed — where a quarter of a second goes unnoticed and a tighter
 * loop would tax every keystroke in a web app.
 */
const EARLY_DEBOUNCE_MS = 0;
const SETTLED_DEBOUNCE_MS = 50;
const IDLE_DEBOUNCE_MS = 250;

function injectStylesheet(css: string): void {
    if (css === '') return;

    const style = document.createElement('style');
    style.textContent = css;

    // At document_start there may be no <head> yet; documentElement always exists.
    const parent = document.head ?? document.documentElement;
    parent.append(style);

    // A page that rebuilds <head> can drop our sheet; put it back if so.
    if (document.head === null) {
        const restore = new MutationObserver(() => {
            if (document.head !== null && !document.head.contains(style)) {
                document.head.append(style);
                restore.disconnect();
            }
        });
        restore.observe(document.documentElement, { childList: true });
    }
}

function hideElement(element: Element, declaration: string | null): void {
    if (declaration === null) {
        (element as HTMLElement).style.setProperty('display', 'none', 'important');
    } else {
        element.setAttribute('style', declaration);
    }
}

/**
 * Work to redo whenever the DOM changes. Returns `true` once it has nothing
 * left to wait for, at which point it is dropped.
 */
type DomTask = () => boolean;

/**
 * Runs tasks now and again on every DOM change, for as long as any remains.
 *
 * Starts observing at document_start rather than waiting for DOMContentLoaded:
 * a selector like `.item:has-text(Sponsored)` needs its target to exist, so the
 * earliest safe moment to evaluate it is the mutation that inserts it. Waiting
 * for the document to finish parsing leaves the element on screen in between —
 * exactly the flash this design exists to prevent.
 *
 * The observer is *not* dropped after a fixed window. It used to be, after ten
 * seconds, which meant anything inserted later — every sponsored post in an
 * infinitely scrolling feed — was never looked at. It now stays for the life of
 * the page and simply slows down; it disconnects only when no task is left.
 */
function watchDom(initial: DomTask[]): void {
    let tasks = initial;
    const started = Date.now();

    const runAll = (): void => {
        tasks = tasks.filter((task) => {
            try {
                return !task();
            } catch {
                // A task that throws would throw again on every mutation.
                return false;
            }
        });
    };

    runAll();
    if (tasks.length === 0) return;

    let timer: number | undefined;
    const observer = new MutationObserver(() => {
        if (timer !== undefined) return;
        const delay = document.readyState !== 'complete' ? EARLY_DEBOUNCE_MS
            : Date.now() - started < SETTLING_WINDOW_MS ? SETTLED_DEBOUNCE_MS
                : IDLE_DEBOUNCE_MS;
        timer = setTimeout(() => {
            timer = undefined;
            runAll();
            if (tasks.length === 0) observer.disconnect();
        }, delay) as unknown as number;
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    // One last pass once everything has settled, for content added by scripts
    // that run at the very end of parsing.
    document.addEventListener('DOMContentLoaded', runAll, { once: true });
}

/** Applies procedural selectors; never finishes, since new matches can always arrive. */
function proceduralTask(selectors: ProceduralSelector[]): DomTask {
    return () => {
        for (const selector of selectors) {
            for (const element of resolve(selector)) {
                if (selector.remove) element.remove();
                else hideElement(element, selector.declaration);
            }
        }
        return false;
    };
}

/**
 * Injects each gated selector once its anchor shows up.
 *
 * A selector such as `#overlay ~ *` is cheap to state and ruinous to match:
 * its subject is every element, and each one walks its preceding siblings
 * looking for the anchor. Left in a stylesheet on every page it cost more than
 * the thirteen thousand other generic selectors combined. Asking whether the
 * anchor exists is a plain lookup, and on nearly every page the answer is no —
 * so the selector is only handed to the style engine on the pages it is for.
 */
function gatedTask(gated: Array<[string, string]>): DomTask {
    let pending = gated;
    return () => {
        const ready: string[] = [];
        pending = pending.filter(([anchor, selector]) => {
            let found = false;
            try {
                found = document.querySelector(anchor) !== null;
            } catch {
                // An anchor the engine cannot parse will never match; drop it.
                return false;
            }
            if (found) ready.push(selector);
            return !found;
        });
        // One rule each: a selector this engine rejects must not take the
        // others down with it.
        if (ready.length > 0) {
            injectStylesheet(ready.map((selector) => `${selector}{${HIDE_DECLARATION}}`).join('\n'));
        }
        return pending.length === 0;
    };
}

export function apply(payload: CosmeticPayload): void {
    if (payload.css !== undefined) injectStylesheet(payload.css);
    injectStylesheet(buildCss(payload));

    const exempt = new Set(payload.exceptions);
    const tasks: DomTask[] = [];

    const gated = (payload.gated ?? []).filter(([, selector]) => !exempt.has(selector));
    if (gated.length > 0) tasks.push(gatedTask(gated));

    const procedural = payload.procedural
        .filter((selector) => !exempt.has(selector))
        .map((selector) => parseProcedural(selector))
        .filter((selector): selector is ProceduralSelector => selector !== null);
    if (procedural.length > 0) tasks.push(proceduralTask(procedural));

    // Start immediately, even at document_start: the observer catches targets
    // as they are inserted, which is the whole point.
    if (tasks.length > 0) watchDom(tasks);
}

// Expose for the generated bucket scripts, which run after this file in the
// same isolated world.
(globalThis as unknown as { __addblocker: { apply: typeof apply } }).__addblocker = { apply };
