/**
 * Stylesheet generation, shared by the runtime (which builds a sheet in the
 * page) and the build (which writes the generic sheet to a file ahead of time).
 *
 * Kept free of any DOM access so the build can import it.
 */

export interface CosmeticPayload {
    /** Plain CSS selectors to hide. */
    hide: string[];
    /** `[selector, declaration]` pairs to restyle instead of hiding. */
    style: Array<[string, string]>;
    /** Selectors needing the procedural engine. */
    procedural: string[];
    /** Selectors exempted on this site. */
    exceptions: string[];
    /**
     * `[anchor, selector]` pairs: plain CSS selectors too expensive to leave in
     * a stylesheet on every page, injected only once `anchor` matches something.
     * See `splitUniversalTail` in the compiler for which ones qualify.
     */
    gated?: Array<[string, string]>;
    /** A ready-made stylesheet, used as is. Exceptions are not applied to it. */
    css?: string;
}

export const HIDE_DECLARATION = 'display:none!important;';

/**
 * Selectors per rule.
 *
 * Two constraints pull the same way.
 *
 * Blink stops matching a selector list past **8192 entries**: the rule still
 * parses, `cssRules` still reports it, and `element.matches()` still says the
 * selector fits — but the style is never applied. Nothing is logged. Measured
 * exactly: at 8192 the last selector applies, at 8193 it does not.
 *
 * And a selector list is all-or-nothing: one selector the engine cannot parse
 * invalidates every other selector in the same rule. The lists are written
 * against Chromium and Firefox; the userscript runs in Safari, which nobody
 * validated them against. The group size is therefore the blast radius of one
 * selector WebKit rejects — at 1 000 it took 999 working selectors down with
 * it, at 100 it takes 99. Measured in Chromium, the smaller groups cost nothing
 * in style recalculation.
 */
export const SELECTORS_PER_RULE = 100;

/** Groups selectors into hide rules of at most `SELECTORS_PER_RULE` each. */
export function hideRules(selectors: string[]): string[] {
    const rules: string[] = [];
    for (let start = 0; start < selectors.length; start += SELECTORS_PER_RULE) {
        const group = selectors.slice(start, start + SELECTORS_PER_RULE);
        rules.push(`${group.join(',')}{${HIDE_DECLARATION}}`);
    }
    return rules;
}

export function buildCss(payload: CosmeticPayload): string {
    const exempt = new Set(payload.exceptions);

    // Grouping is still worth it — a rule per selector would be thousands of
    // rules — but the group has to stay under what the engine will match.
    const parts = hideRules(payload.hide.filter((selector) => !exempt.has(selector)));

    for (const [selector, declaration] of payload.style) {
        if (exempt.has(selector)) continue;
        parts.push(`${selector}{${declaration}}`);
    }

    return parts.join('\n');
}
