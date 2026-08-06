/**
 * Compiles scriptlet filters into per-domain bucket scripts, mirroring the
 * cosmetic pipeline: generated at build time, injected natively at
 * document_start, no service-worker round trip.
 *
 * The difference is the world. Scriptlets must run in the page's own context
 * (`world: MAIN`) to hook the globals the site's scripts will read, and they
 * must run *before* those scripts.
 */

import { lookup } from '@addblocker/scriptlet-runtime/catalog';
import type { ScriptletFilter } from './parse.js';

export type Invocation = [name: string, ...args: string[]];

export interface ScriptletBucket {
    id: string;
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

export function compileScriptlets(filters: ScriptletFilter[]): ScriptletCompileResult {
    const byDomain = new Map<string, Map<string, Invocation>>();
    const exceptionsByDomain = new Map<string, Set<string>>();
    const unknownByName: Record<string, number> = {};
    let unknownScriptlets = 0;
    let genericSkipped = 0;
    let skippedDomains = 0;
    let exceptions = 0;

    for (const filter of filters) {
        // A scriptlet we do not implement would be a silent no-op at runtime.
        // Counting them keeps the coverage gap visible.
        if (!filter.isException && lookup(filter.name) === undefined) {
            unknownScriptlets += 1;
            unknownByName[filter.name] = (unknownByName[filter.name] ?? 0) + 1;
            continue;
        }

        if (filter.isException) {
            exceptions += 1;
            for (const raw of filter.domains) {
                for (const domain of expandDomain(raw)) {
                    if (!isUsableDomain(domain)) continue;
                    const set = exceptionsByDomain.get(domain) ?? new Set<string>();
                    set.add(filter.name);
                    exceptionsByDomain.set(domain, set);
                }
            }
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
        let placed = false;
        for (const raw of filter.domains) {
            for (const domain of expandDomain(raw)) {
                if (!isUsableDomain(domain)) continue;
                placed = true;
                const map = byDomain.get(domain) ?? new Map<string, Invocation>();
                map.set(invocationKey(invocation), invocation);
                byDomain.set(domain, map);
            }
        }
        if (!placed) skippedDomains += 1;
    }

    // Apply exceptions: a `#@#+js(name)` disables that scriptlet on the domain.
    for (const [domain, disabled] of exceptionsByDomain) {
        const map = byDomain.get(domain);
        if (map === undefined) continue;
        for (const [key, invocation] of map) {
            if (disabled.has(invocation[0])) map.delete(key);
        }
        if (map.size === 0) byDomain.delete(domain);
    }

    const domains = [...byDomain.keys()].sort();
    const buckets: ScriptletBucket[] = [];

    for (let start = 0; start < domains.length; start += BUCKET_SIZE) {
        const slice = domains.slice(start, start + BUCKET_SIZE);
        const invocations: Record<string, Invocation[]> = {};
        for (const domain of slice) {
            invocations[domain] = [...(byDomain.get(domain)?.values() ?? [])];
        }
        buckets.push({
            id: `scriptlets-${String(buckets.length).padStart(3, '0')}`,
            domains: slice,
            invocations,
        });
    }

    return {
        buckets,
        stats: {
            inputFilters: filters.length,
            domains: byDomain.size,
            buckets: buckets.length,
            invocations: [...byDomain.values()].reduce((n, m) => n + m.size, 0),
            exceptions,
            unknownScriptlets,
            unknownByName,
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
