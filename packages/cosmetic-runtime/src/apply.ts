/**
 * Content-script entry point.
 *
 * Runs at document_start in the isolated world. Plain CSS goes into a
 * stylesheet immediately — that is what prevents the flash of an ad appearing
 * before it disappears. Procedural selectors need the DOM, so they are
 * evaluated once it exists and re-evaluated on mutation.
 */

import { parseProcedural, resolve, type ProceduralSelector } from './procedural.js';

export interface CosmeticPayload {
    /** Plain CSS selectors to hide. */
    hide: string[];
    /** `[selector, declaration]` pairs to restyle instead of hiding. */
    style: Array<[string, string]>;
    /** Selectors needing the procedural engine. */
    procedural: string[];
    /** Selectors exempted on this site. */
    exceptions: string[];
}

const HIDE_DECLARATION = 'display:none!important;';

/** How long to keep re-checking procedural selectors after load. */
const OBSERVE_WINDOW_MS = 10_000;
/**
 * Coalescing delay for mutation bursts.
 *
 * Zero while the page is still parsing: a procedural selector can only be
 * evaluated once its target exists, so any delay between insertion and
 * evaluation is a window where the ad is on screen. Once the document is
 * complete, batching is worth the few frames it saves.
 */
const EARLY_DEBOUNCE_MS = 0;
const SETTLED_DEBOUNCE_MS = 50;

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

/**
 * Selectors per rule.
 *
 * Blink stops matching a selector list past **8192 entries**: the rule still
 * parses, `cssRules` still reports it, and `element.matches()` still says the
 * selector fits — but the style is never applied. Nothing is logged. Measured
 * exactly: at 8192 the last selector applies, at 8193 it does not.
 *
 * The generic sheet alone holds ~13 700 selectors, so a single rule silently
 * dropped some five thousand of them. This is well under the limit, and low
 * enough to be safe on engines whose own threshold is undocumented — Safari in
 * particular, which the userscript build targets and which cannot be measured
 * from here.
 */
export const SELECTORS_PER_RULE = 1_000;

export function buildCss(payload: CosmeticPayload): string {
    const exempt = new Set(payload.exceptions);
    const parts: string[] = [];

    const hide = payload.hide.filter((selector) => !exempt.has(selector));
    // Grouping is still worth it — a rule per selector would be thousands of
    // rules — but the group has to stay under what the engine will match.
    for (let start = 0; start < hide.length; start += SELECTORS_PER_RULE) {
        const group = hide.slice(start, start + SELECTORS_PER_RULE);
        parts.push(`${group.join(',')}{${HIDE_DECLARATION}}`);
    }

    for (const [selector, declaration] of payload.style) {
        if (exempt.has(selector)) continue;
        parts.push(`${selector}{${declaration}}`);
    }

    return parts.join('\n');
}

function hideElement(element: Element, declaration: string | null): void {
    if (declaration === null) {
        (element as HTMLElement).style.setProperty('display', 'none', 'important');
    } else {
        element.setAttribute('style', declaration);
    }
}

/**
 * Applies procedural selectors and keeps applying them as the DOM changes.
 *
 * Starts observing at document_start rather than waiting for DOMContentLoaded:
 * a selector like `.item:has-text(Sponsored)` needs its target to exist, so the
 * earliest safe moment to evaluate it is the mutation that inserts it. Waiting
 * for the document to finish parsing leaves the element on screen in between —
 * exactly the flash this design exists to prevent.
 *
 * The observer is dropped after a bounded window rather than left on the page
 * forever.
 */
function runProcedural(selectors: ProceduralSelector[]): void {
    if (selectors.length === 0) return;

    const applyAll = (): void => {
        for (const selector of selectors) {
            for (const element of resolve(selector)) {
                if (selector.remove) element.remove();
                else hideElement(element, selector.declaration);
            }
        }
    };

    applyAll();

    let timer: number | undefined;
    const observer = new MutationObserver(() => {
        if (timer !== undefined) return;
        const delay = document.readyState === 'complete' ? SETTLED_DEBOUNCE_MS : EARLY_DEBOUNCE_MS;
        timer = setTimeout(() => {
            timer = undefined;
            applyAll();
        }, delay) as unknown as number;
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    // One last pass once everything has settled, for content added by scripts
    // that run at the very end of parsing.
    document.addEventListener('DOMContentLoaded', applyAll, { once: true });
    setTimeout(() => observer.disconnect(), OBSERVE_WINDOW_MS);
}

export function apply(payload: CosmeticPayload): void {
    injectStylesheet(buildCss(payload));

    const exempt = new Set(payload.exceptions);
    const procedural = payload.procedural
        .filter((selector) => !exempt.has(selector))
        .map((selector) => parseProcedural(selector))
        .filter((selector): selector is ProceduralSelector => selector !== null);

    if (procedural.length === 0) return;

    // Start immediately, even at document_start: the observer catches targets
    // as they are inserted, which is the whole point.
    runProcedural(procedural);
}

// Expose for the generated bucket scripts, which run after this file in the
// same isolated world.
(globalThis as unknown as { __addblocker: { apply: typeof apply } }).__addblocker = { apply };
