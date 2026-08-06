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

export interface DomainPayload {
    hide: string[];
    style: Array<[string, string]>;
    procedural: string[];
    exceptions: string[];
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
            addTo(generic, filter);
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
    const specificPairs = [...byDomain.values()]
        .reduce((n, p) => n + p.hide.length + p.style.length + p.procedural.length, 0);
    const proceduralSelectors = deduped.procedural.length
        + [...byDomain.values()].reduce((n, p) => n + p.procedural.length, 0);

    return {
        buckets,
        generic: deduped,
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

/** Emits the generic script applied to every site. */
export function renderGeneric(payload: DomainPayload): string {
    return `(() => {
const rt = globalThis.__addblocker;
if (rt) rt.apply(${JSON.stringify(payload)});
})();
`;
}
