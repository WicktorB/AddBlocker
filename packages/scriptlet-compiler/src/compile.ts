/**
 * Compiles scriptlet filters into per-domain bucket scripts, mirroring the
 * cosmetic pipeline: generated at build time, injected natively at
 * document_start, no service-worker round trip.
 *
 * The difference is the world. Scriptlets must run in the page's own context
 * (`world: MAIN`) to hook the globals the site's scripts will read, and they
 * must run *before* those scripts.
 */

import { lookup, requiresTrust, worldOf, type World } from '@addblocker/scriptlet-runtime/catalog';
import type { ScriptletFilter } from './parse.js';

/**
 * `[name, ...args]`. When the invocation must not run on some subdomains of
 * the domain it is filed under, it is led by `~host|host` — see the runtime.
 */
export type Invocation = string[];

export interface ScriptletBucket {
    id: string;
    /** The world these invocations must run in. */
    world: World;
    domains: string[];
    invocations: Record<string, Invocation[]>;
}

export interface ScriptletCompileResult {
    buckets: ScriptletBucket[];
    stats: {
        inputFilters: number;
        domains: number;
        buckets: number;
        invocations: number;
        exceptions: number;
        /** Invocations dropped because the catalogue has no such scriptlet. */
        unknownScriptlets: number;
        unknownByName: Record<string, number>;
        /** `trusted-*` invocations dropped because their list is not a trusted one. */
        untrustedDropped: number;
        /** Generic invocations, which we do not apply site-wide. */
        genericSkipped: number;
        skippedDomains: number;
    };
}

const BUCKET_SIZE = 400;

const EXPANSION_TLDS = [
    'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'me', 'tv', 'cc', 'ru',
    'de', 'fr', 'it', 'es', 'nl', 'pl', 'br', 'in', 'uk', 'jp', 'cn', 'au',
    'ca', 'se', 'no', 'fi', 'dk', 'cz', 'gr', 'pt', 'ro', 'hu', 'at', 'ch',
    'be', 'tr', 'ua', 'mx', 'ar', 'kr', 'tw', 'us', 'eu',
];

const VALID_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function isUsableDomain(domain: string): boolean {
    if (domain === '' || domain.includes('*') || domain.includes('/')) return false;
    if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
    return VALID_HOST.test(domain);
}

function expandDomain(domain: string): string[] {
    if (!domain.endsWith('.*')) return [domain];
    const stem = domain.slice(0, -2);
    return EXPANSION_TLDS.map((tld) => `${stem}.${tld}`);
}

function invocationKey(invocation: Invocation): string {
    return JSON.stringify(invocation);
}

/** Whether `host` is `domain` or one of its subdomains. */
function isUnder(host: string, domain: string): boolean {
    return host === domain || host.endsWith(`.${domain}`);
}

interface Placed {
    invocation: Invocation;
    /**
     * Subdomains this invocation must not run on. `null` once some filter
     * applies it to the whole domain: an exclusion written on one filter does
     * not restrict another that has none.
     */
    excluded: Set<string> | null;
}

export function compileScriptlets(filters: ScriptletFilter[]): ScriptletCompileResult {
    const byDomain = new Map<string, Map<string, Placed>>();
    const exceptionFilters: ScriptletFilter[] = [];
    const unknownByName: Record<string, number> = {};
    let unknownScriptlets = 0;
    let untrustedDropped = 0;
    let genericSkipped = 0;
    let skippedDomains = 0;

    for (const filter of filters) {
        if (filter.isException) {
            exceptionFilters.push(filter);
            continue;
        }

        // A scriptlet we do not implement would be a silent no-op at runtime.
        // Counting them keeps the coverage gap visible.
        if (lookup(filter.name) === undefined) {
            unknownScriptlets += 1;
            unknownByName[filter.name] = (unknownByName[filter.name] ?? 0) + 1;
            continue;
        }

        // A list we do not vouch for does not get to inject text into pages.
        if (requiresTrust(filter.name) && !filter.trusted) {
            untrustedDropped += 1;
            continue;
        }

        // Generic scriptlets would hook globals on every site visited. The
        // blast radius is far larger than a generic cosmetic selector, so they
        // are not applied site-wide.
        if (filter.isGeneric) {
            genericSkipped += 1;
            continue;
        }

        const invocation: Invocation = [filter.name, ...filter.args];
        const key = invocationKey(invocation);
        const excludedDomains = filter.excludedDomains.flatMap(expandDomain).filter(isUsableDomain);
        let placed = false;
        for (const raw of filter.domains) {
            for (const domain of expandDomain(raw)) {
                if (!isUsableDomain(domain)) continue;
                // `a.com,~a.com` or `sub.a.com,~a.com`: excluded outright.
                if (excludedDomains.some((excluded) => isUnder(domain, excluded))) continue;
                placed = true;
                // `a.com,~sub.a.com`: applies, except under those subdomains.
                const inside = excludedDomains.filter((excluded) => isUnder(excluded, domain));
                const map = byDomain.get(domain) ?? new Map<string, Placed>();
                const existing = map.get(key);
                if (existing === undefined) {
                    map.set(key, { invocation, excluded: inside.length > 0 ? new Set(inside) : null });
                } else if (existing.excluded !== null) {
                    existing.excluded = inside.length > 0
                        ? new Set(inside.filter((d) => existing.excluded?.has(d)))
                        : null;
                    if (existing.excluded?.size === 0) existing.excluded = null;
                }
                byDomain.set(domain, map);
            }
        }
        if (!placed) skippedDomains += 1;
    }

    // Exceptions. `#@#+js(name, args)` cancels that exact invocation — same
    // name as written, same arguments — and `#@#+js()` cancels all of them.
    // It holds for the exception's domain and everything under it, so an
    // invocation filed under a parent domain keeps running there but learns
    // to stay off that subtree.
    for (const filter of exceptionFilters) {
        const all = filter.name === '';
        const key = invocationKey([filter.name, ...filter.args]);
        for (const raw of filter.domains) {
            for (const domain of expandDomain(raw)) {
                if (!isUsableDomain(domain)) continue;
                for (const [placedDomain, map] of byDomain) {
                    const below = isUnder(placedDomain, domain);
                    if (!below && !isUnder(domain, placedDomain)) continue;
                    for (const [placedKey, placed] of [...map]) {
                        if (!all && placedKey !== key) continue;
                        if (below) map.delete(placedKey);
                        else (placed.excluded ??= new Set()).add(domain);
                    }
                    if (map.size === 0) byDomain.delete(placedDomain);
                }
            }
        }
    }

    const buckets: ScriptletBucket[] = [];
    let invocationCount = 0;
    const placedDomains = new Set<string>();

    for (const world of ['MAIN', 'ISOLATED'] as const) {
        const perDomain = new Map<string, Invocation[]>();
        for (const [domain, map] of byDomain) {
            const list: Invocation[] = [];
            for (const { invocation, excluded } of map.values()) {
                if (worldOf(invocation[0]) !== world) continue;
                list.push(excluded !== null && excluded.size > 0
                    ? [`~${[...excluded].sort().join('|')}`, ...invocation]
                    : invocation);
            }
            if (list.length === 0) continue;
            perDomain.set(domain, list);
            placedDomains.add(domain);
            invocationCount += list.length;
        }

        const domains = [...perDomain.keys()].sort();
        // The main-world buckets keep the names they have always had; the
        // isolated ones are numbered apart so neither series shifts the other.
        const prefix = world === 'MAIN' ? 'scriptlets' : 'scriptlets-isolated';
        let index = 0;
        for (let start = 0; start < domains.length; start += BUCKET_SIZE) {
            const slice = domains.slice(start, start + BUCKET_SIZE);
            const invocations: Record<string, Invocation[]> = {};
            for (const domain of slice) invocations[domain] = perDomain.get(domain) ?? [];
            buckets.push({
                id: `${prefix}-${String(index).padStart(3, '0')}`,
                world,
                domains: slice,
                invocations,
            });
            index += 1;
        }
    }

    return {
        buckets,
        stats: {
            inputFilters: filters.length,
            domains: placedDomains.size,
            buckets: buckets.length,
            invocations: invocationCount,
            exceptions: exceptionFilters.length,
            unknownScriptlets,
            unknownByName,
            untrustedDropped,
            genericSkipped,
            skippedDomains,
        },
    };
}

/** Emits the JS for one scriptlet bucket. */
export function renderScriptletBucket(bucket: ScriptletBucket): string {
    const invocations: Record<string, Invocation[]> = {};
    for (const [domain, list] of Object.entries(bucket.invocations)) {
        if (list.length > 0) invocations[domain] = list;
    }

    return `(() => {
const I = ${JSON.stringify(invocations)};
const rt = globalThis.__addblockerScriptlets;
if (!rt) return;
let host = location.hostname;
const all = [];
// Walk up the domain so a filter on example.com also covers www.example.com.
while (host.includes('.')) {
  const list = I[host];
  if (list) all.push(...list);
  host = host.slice(host.indexOf('.') + 1);
}
if (all.length) rt.run(all);
})();
`;
}
