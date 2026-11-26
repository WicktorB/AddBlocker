/**
 * Compiles cosmetic filters into per-domain content scripts.
 *
 * The design choice that matters is doing this at build time. A content script
 * that asks the service worker for its selectors waits for a cold start —
 * 50-200ms during which the ad is visible, then vanishes. Generating static
 * scripts declared in the manifest means Chrome injects them itself at
 * document_start, with no round trip and no flash.
 *
 * Domains are grouped into buckets so the manifest stays a reasonable size. A
 * site loads a few selectors belonging to its bucket-mates, which costs
 * nothing measurable next to the latency avoided.
 */

import type { CosmeticFilter } from '@addblocker/filter-parser';
import { hideRules } from '@addblocker/cosmetic-runtime/css';

export interface DomainPayload {
    hide: string[];
    style: Array<[string, string]>;
    procedural: string[];
    exceptions: string[];
    /** `[anchor, selector]` pairs injected only once the anchor exists. */
    gated?: Array<[string, string]>;
}

/**
 * Finds the selectors whose subject is "anything", and what they hang off.
 *
 * `#overlay ~ *` reads as a narrow rule and matches as the widest one there
 * is. The style engine works right to left: the subject `*` is a candidate on
 * every element, and each candidate then walks its preceding siblings looking
 * for `#overlay`. On a page of 5 000 sibling nodes that is twelve million
 * steps, on every page visited, for a rule aimed at one scam site. Measured in
 * Chromium, a single such selector in the generic sheet took style
 * recalculation from 22 ms to 134 ms — more than the 13 000 class and id
 * selectors beside it, which are hashed and cost about a millisecond together.
 *
 * Returns the part before the last combinator — the anchor — when the last
 * compound selector names no tag, class, id or attribute; `null` otherwise.
 * The runtime tests for the anchor, which is cheap, and only injects the full
 * selector on pages where it is found.
 */
export function splitUniversalTail(selector: string): string | null {
    let depth = 0;
    let quote = '';
    let lastCombinator = -1;

    for (let i = 0; i < selector.length; i += 1) {
        const ch = selector[i];
        if (quote !== '') {
            if (ch === '\\') i += 1;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '\\') { i += 1; continue; }
        if (ch === '(' || ch === '[') { depth += 1; continue; }
        if (ch === ')' || ch === ']') { depth -= 1; continue; }
        if (depth !== 0) continue;
        // A selector list has several subjects; leave those in the sheet.
        if (ch === ',') return null;
        if (ch === ' ' || ch === '>' || ch === '+' || ch === '~') lastCombinator = i;
    }

    if (lastCombinator === -1) return null;

    const tail = selector.slice(lastCombinator + 1).trim();
    const universal = tail === '*' || /^\*?:(?:not|is|where)\(/.test(tail);
    if (!universal) return null;

    const anchor = selector.slice(0, lastCombinator + 1).replace(/[\s>+~]+$/, '').trim();
    return anchor === '' ? null : anchor;
}

export interface Bucket {
    id: string;
    /** Domains this bucket serves, for the manifest `matches` patterns. */
    domains: string[];
    /** Per-domain payloads, keyed by domain. */
    payloads: Record<string, DomainPayload>;
}

export interface CosmeticCompileResult {
    buckets: Bucket[];
    /** Selectors applying to every site. */
    generic: DomainPayload;
    /**
     * Per-domain exceptions that name a *generic* selector.
     *
     * `example.com#@#.ad-banner` means "the generic `.ad-banner` rule does not
     * apply here". The generic sheet is built without knowing which site it
     * will land on, so it needs this index to honour them — without it the
     * exception only ever filtered the site's own selectors, never the generic
     * ones it was written against.
     */
    genericExceptions: Record<string, string[]>;
    stats: {
        inputFilters: number;
        genericSelectors: number;
        specificPairs: number;
        proceduralSelectors: number;
        exceptions: number;
        domains: number;
        buckets: number;
        /** Filters dropped because DNR/CSS cannot express them. */
        skipped: number;
        /** Generic selectors held back until their anchor appears. */
        gatedSelectors: number;
        /** Site exceptions that target a generic selector. */
        genericExceptionPairs: number;
    };
}

/** Domains per bucket. Larger buckets mean a smaller manifest but more spill. */
const BUCKET_SIZE = 400;

/**
 * TLDs used to expand uBO's `example.*` form, matching the network compiler's
 * behaviour so both halves of a filter list agree on which sites they cover.
 */
const EXPANSION_TLDS = [
    'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'me', 'tv', 'cc', 'ru',
    'de', 'fr', 'it', 'es', 'nl', 'pl', 'br', 'in', 'uk', 'jp', 'cn', 'au',
    'ca', 'se', 'no', 'fi', 'dk', 'cz', 'gr', 'pt', 'ro', 'hu', 'at', 'ch',
    'be', 'tr', 'ua', 'mx', 'ar', 'kr', 'tw', 'us', 'eu',
];

/**
 * Hostnames that can appear in a Chrome match pattern.
 *
 * This matters more than it looks: Chrome refuses to load the *entire
 * extension* when one match pattern is malformed, so a single bad domain
 * silently disables every content script. Validated here rather than trusted.
 */
const VALID_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export function isUsableDomain(domain: string): boolean {
    if (domain === '' || domain.includes('*') || domain.includes('/')) return false;
    if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
    return VALID_HOST.test(domain);
}

function expandDomain(domain: string): string[] {
    if (!domain.endsWith('.*')) return [domain];
    const stem = domain.slice(0, -2);
    return EXPANSION_TLDS.map((tld) => `${stem}.${tld}`);
}

function emptyPayload(): DomainPayload {
    return { hide: [], style: [], procedural: [], exceptions: [] };
}

function addTo(payload: DomainPayload, filter: CosmeticFilter): void {
    if (filter.kind === 'exception') {
        payload.exceptions.push(filter.selector);
        return;
    }
    if (filter.kind === 'style' && filter.declaration !== null) {
        payload.style.push([filter.selector, filter.declaration]);
        return;
    }
    if (filter.isProcedural) payload.procedural.push(filter.selector);
    else payload.hide.push(filter.selector);
}

function dedupePayload(payload: DomainPayload): DomainPayload {
    const seenStyle = new Set<string>();
    return {
        hide: [...new Set(payload.hide)],
        procedural: [...new Set(payload.procedural)],
        exceptions: [...new Set(payload.exceptions)],
        style: payload.style.filter(([selector, declaration]) => {
            const key = `${selector}|${declaration}`;
            if (seenStyle.has(key)) return false;
            seenStyle.add(key);
            return true;
        }),
    };
}

export function compileCosmetic(filters: CosmeticFilter[]): CosmeticCompileResult {
    const generic = emptyPayload();
    const byDomain = new Map<string, DomainPayload>();
    let skipped = 0;

    for (const filter of filters) {
        // A selector excluded on some domains but applying everywhere else
        // cannot be expressed as a static per-domain script; the exclusion
        // would be silently lost, so skip rather than over-hide.
        if (filter.isGeneric && filter.excludedDomains.length > 0) {
            skipped += 1;
            continue;
        }

        if (filter.isGeneric) {
            const anchor = filter.kind === 'hide' && !filter.isProcedural
                ? splitUniversalTail(filter.selector) : null;
            if (anchor !== null) (generic.gated ??= []).push([anchor, filter.selector]);
            else addTo(generic, filter);
            continue;
        }

        let placed = false;
        for (const raw of filter.domains) {
            for (const domain of expandDomain(raw)) {
                if (!isUsableDomain(domain)) continue;
                placed = true;
                let payload = byDomain.get(domain);
                if (payload === undefined) {
                    payload = emptyPayload();
                    byDomain.set(domain, payload);
                }
                addTo(payload, filter);
            }
        }
        if (!placed) skipped += 1;
    }

    // Bucket domains alphabetically: neighbouring domains often share a
    // registrable suffix, so their match patterns compress well.
    const domains = [...byDomain.keys()].sort();
    const buckets: Bucket[] = [];

    for (let start = 0; start < domains.length; start += BUCKET_SIZE) {
        const slice = domains.slice(start, start + BUCKET_SIZE);
        const payloads: Record<string, DomainPayload> = {};
        for (const domain of slice) {
            payloads[domain] = dedupePayload(byDomain.get(domain) ?? emptyPayload());
        }
        buckets.push({
            id: `bucket-${String(buckets.length).padStart(3, '0')}`,
            domains: slice,
            payloads,
        });
    }

    const deduped = dedupePayload(generic);
    if (generic.gated !== undefined) {
        const seen = new Set<string>();
        deduped.gated = generic.gated.filter(([, selector]) => {
            if (seen.has(selector)) return false;
            seen.add(selector);
            return true;
        });
    }

    const genericSelectors = new Set<string>([
        ...deduped.hide, ...deduped.procedural,
        ...deduped.style.map(([selector]) => selector),
        ...(deduped.gated ?? []).map(([, selector]) => selector),
    ]);
    const genericExceptions: Record<string, string[]> = {};
    let genericExceptionPairs = 0;
    for (const domain of domains) {
        const hits = [...new Set(byDomain.get(domain)?.exceptions ?? [])]
            .filter((selector) => genericSelectors.has(selector));
        if (hits.length === 0) continue;
        genericExceptions[domain] = hits;
        genericExceptionPairs += hits.length;
    }
    const specificPairs = [...byDomain.values()]
        .reduce((n, p) => n + p.hide.length + p.style.length + p.procedural.length, 0);
    const proceduralSelectors = deduped.procedural.length
        + [...byDomain.values()].reduce((n, p) => n + p.procedural.length, 0);

    return {
        buckets,
        generic: deduped,
        genericExceptions,
        stats: {
            inputFilters: filters.length,
            genericSelectors: deduped.hide.length + deduped.style.length + deduped.procedural.length,
            specificPairs,
            proceduralSelectors,
            exceptions: deduped.exceptions.length
                + [...byDomain.values()].reduce((n, p) => n + p.exceptions.length, 0),
            domains: byDomain.size,
            buckets: buckets.length,
            skipped,
            gatedSelectors: deduped.gated?.length ?? 0,
            genericExceptionPairs,
        },
    };
}

/**
 * Emits the JS for one bucket.
 *
 * The script picks the payload for the current hostname, walking up the domain
 * so a filter on `example.com` also applies to `www.example.com`.
 */
export function renderBucket(bucket: Bucket): string {
    // Drop empty payloads: a domain may exist only as an exception target.
    const payloads: Record<string, DomainPayload> = {};
    for (const [domain, payload] of Object.entries(bucket.payloads)) {
        if (payload.hide.length === 0 && payload.style.length === 0
            && payload.procedural.length === 0 && payload.exceptions.length === 0) continue;
        payloads[domain] = payload;
    }

    return `(() => {
const P = ${JSON.stringify(payloads)};
const rt = globalThis.__addblocker;
if (!rt) return;
let host = location.hostname;
const merged = {hide: [], style: [], procedural: [], exceptions: []};
let found = false;
// Walk up the domain: a rule on example.com covers www.example.com too.
while (host.includes('.')) {
  const p = P[host];
  if (p) {
    found = true;
    merged.hide.push(...(p.hide || []));
    merged.style.push(...(p.style || []));
    merged.procedural.push(...(p.procedural || []));
    merged.exceptions.push(...(p.exceptions || []));
  }
  const dot = host.indexOf('.');
  host = host.slice(dot + 1);
}
if (found) rt.apply(merged);
})();
`;
}

/**
 * Emits the generic stylesheet as a file.
 *
 * Registered as extension CSS, the browser applies it itself: no script runs,
 * the parsed sheet is shared by every frame instead of being rebuilt from a
 * 240 kB string in each one, and the page has no `<style>` element to remove.
 * It carries everything that is the same on every site — the plain hide and
 * restyle rules, minus the list's own global exceptions.
 */
export function renderGenericCss(generic: DomainPayload): string {
    const exempt = new Set(generic.exceptions);
    const rules = hideRules(generic.hide.filter((selector) => !exempt.has(selector)));
    for (const [selector, declaration] of generic.style) {
        if (!exempt.has(selector)) rules.push(`${selector}{${declaration}}`);
    }
    return `${rules.join('\n')}\n`;
}

/**
 * Emits the script that accompanies the generic stylesheet.
 *
 * It carries only what a static sheet cannot: procedural selectors and the
 * gated ones. On a typical build that is a few hundred bytes.
 */
export function renderGenericDynamic(generic: DomainPayload): string {
    const payload: DomainPayload = {
        hide: [], style: [],
        procedural: generic.procedural,
        exceptions: generic.exceptions,
        ...(generic.gated !== undefined ? { gated: generic.gated } : {}),
    };
    return `(() => {
const rt = globalThis.__addblocker;
if (rt) rt.apply(${JSON.stringify(payload)});
})();
`;
}

/**
 * Emits the full generic script, for the sites that have exceptions to it.
 *
 * A static stylesheet cannot leave one selector out on one site, so the sites
 * with a `#@#` aimed at a generic selector are excluded from the sheet and get
 * this instead: the whole generic payload, filtered by the exceptions for the
 * current hostname.
 */
export function renderGeneric(
    payload: DomainPayload,
    genericExceptions: Record<string, string[]> = {},
): string {
    return `(() => {
const rt = globalThis.__addblocker;
if (!rt) return;
const G = ${JSON.stringify(payload)};
const X = ${JSON.stringify(genericExceptions)};
let host = location.hostname;
// Walk up the domain: an exception on example.com covers www.example.com too.
while (host.includes('.')) {
  const x = X[host];
  if (x) G.exceptions.push(...x);
  host = host.slice(host.indexOf('.') + 1);
}
rt.apply(G);
})();
`;
}
