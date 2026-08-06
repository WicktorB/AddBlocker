/**
 * Builds the request corpus the parity measurement runs on.
 *
 * The corpus is derived from the *raw* filter lists, not from our compiled
 * rules. That distinction is the whole point: a filter we failed to convert
 * leaves no trace in our rules, so a corpus built from them could never
 * contain the requests we get wrong, and the measurement would flatter us.
 *
 * The synthesised URLs do not have to faithfully match the filter they came
 * from. uBO's engine adjudicates every request, so it decides the truth; a URL
 * that happens to match nothing is simply an easy case both sides should agree
 * on. What matters is that the corpus reaches into the parts of the lists our
 * compiler struggles with.
 */

export type RequestType = 'script' | 'image' | 'xmlhttprequest' | 'sub_frame' | 'stylesheet';

/**
 * Where a probe came from.
 *
 * `scoped-in` / `scoped-out` are the pairs that matter most: the same request
 * from a context the filter covers and from one it does not. Dropping a
 * `$domain=` or `$third-party` restriction during compilation looks harmless
 * on `scoped-in` and shows up only on `scoped-out`.
 */
export type ProbeOrigin =
    | 'anchored' | 'path' | 'scoped-in' | 'scoped-out'
    | 'exception' | 'first-party' | 'control';

export interface Probe {
    /** Full URL of the request. */
    url: string;
    /** Hostname of the page making it. */
    initiator: string;
    type: RequestType;
    origin: ProbeOrigin;
    /** The filter line this was derived from, to make a miss diagnosable. */
    from?: string;
}

/** Deterministic pseudo-random source: a run must be reproducible. */
export function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        // xorshift32 — small, fast, and good enough to spread a sample.
        state ^= state << 13; state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5; state >>>= 0;
        return state / 0x1_0000_0000;
    };
}

export function sample<T>(items: T[], count: number, random: () => number): T[] {
    if (items.length <= count) return [...items];
    const picked = new Set<number>();
    const out: T[] = [];
    while (out.length < count) {
        const index = Math.floor(random() * items.length);
        if (picked.has(index)) continue;
        picked.add(index);
        out.push(items[index]);
    }
    return out;
}

const COSMETIC_MARKER = /#(@)?(\$\?|\?|\$|%)?#/;

/** True for lines that are comments, metadata, or empty. */
function isNoise(line: string): boolean {
    const text = line.trim();
    return text === '' || text.startsWith('!') || text.startsWith('[');
}

/**
 * Domain anchored by `||domain^`, when the filter has one.
 *
 * Deliberately permissive about what follows: `||a.com^$script`,
 * `||a.com/path`, `||a.com*` all yield `a.com`. Everything else — regex
 * filters, bare substrings — is skipped, and counted so the report can say how
 * much of the lists the corpus does not reach.
 */
export function anchoredDomain(line: string): string | null {
    if (!line.startsWith('||')) return null;
    const rest = line.slice(2);
    const end = rest.search(/[\^/*|$?]/);
    const domain = (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain)) return null;
    if (!domain.includes('.')) return null;
    // A wildcard TLD cannot be turned into one request.
    if (domain.endsWith('.')) return null;
    return domain;
}

/** Hostnames that look like real sites, harvested from the lists themselves. */
export function harvestSiteDomains(lines: string[]): string[] {
    const sites = new Set<string>();

    for (const line of lines) {
        if (isNoise(line)) continue;

        const cosmetic = COSMETIC_MARKER.exec(line);
        if (cosmetic !== null && !line.startsWith('/')) {
            for (const part of line.slice(0, cosmetic.index).split(',')) {
                const host = part.replace(/^~/, '').trim().toLowerCase();
                if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) && host.includes('.')
                    && !host.includes('*')) {
                    sites.add(host);
                }
            }
            continue;
        }

        // $domain= lists the sites a network filter applies to — real sites by
        // construction, and exactly the contexts where filtering is delicate.
        const domainOption = /\$(?:[^$]*,)?domain=([^,$]+)/.exec(line);
        if (domainOption !== null) {
            for (const part of domainOption[1].split('|')) {
                const host = part.replace(/^~/, '').trim().toLowerCase();
                if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) && host.includes('.')) {
                    sites.add(host);
                }
            }
        }
    }

    return [...sites].sort();
}

/** A network filter, parsed only as far as building a request needs. */
export interface ParsedFilter {
    raw: string;
    exception: boolean;
    domain: string;
    /** Literal path prefix from the pattern, when it has one. */
    path: string | null;
    types: RequestType[];
    /** Present when the filter is restricted to third-party requests. */
    thirdParty: boolean;
    /** Sites the filter applies to, from `$domain=`. */
    onlyOn: string[];
    /** Sites explicitly excluded, from `$domain=~site`. */
    notOn: string[];
}

const TYPE_OPTIONS: Record<string, RequestType> = {
    script: 'script',
    image: 'image',
    xmlhttprequest: 'xmlhttprequest',
    xhr: 'xmlhttprequest',
    subdocument: 'sub_frame',
    stylesheet: 'stylesheet',
    css: 'stylesheet',
};

/**
 * Parses a network filter far enough to synthesise requests from it.
 *
 * This is not a faithful ABP parser and does not need to be: uBO adjudicates
 * every probe, so a misreading yields a request that is merely less
 * interesting, never a wrong expected answer.
 */
export function parseFilter(raw: string): ParsedFilter | null {
    const line = raw.trim();
    if (isNoise(line)) return null;
    if (COSMETIC_MARKER.test(line) && !line.startsWith('/')) return null;

    const exception = line.startsWith('@@');
    const body = exception ? line.slice(2) : line;

    const dollar = body.lastIndexOf('$');
    const pattern = dollar === -1 ? body : body.slice(0, dollar);
    const optionText = dollar === -1 ? '' : body.slice(dollar + 1);

    const domain = anchoredDomain(pattern);
    if (domain === null) return null;

    // What follows the domain, up to the first wildcard or separator, is a
    // literal the URL must contain for the filter to bite.
    const afterDomain = pattern.slice(2 + domain.length);
    const literal = /^\/[\w\-./]{1,40}/.exec(afterDomain);
    const path = literal === null ? null : literal[0];

    const types: RequestType[] = [];
    let thirdParty = false;
    const onlyOn: string[] = [];
    const notOn: string[] = [];

    for (const option of optionText.split(',')) {
        const name = option.trim().toLowerCase();
        if (name === '') continue;
        if (name === 'third-party' || name === '3p') { thirdParty = true; continue; }
        const known = TYPE_OPTIONS[name];
        if (known !== undefined) { types.push(known); continue; }
        if (name.startsWith('domain=')) {
            for (const part of name.slice('domain='.length).split('|')) {
                const host = part.trim();
                if (host === '' || host.includes('*')) continue;
                if (host.startsWith('~')) notOn.push(host.slice(1));
                else onlyOn.push(host);
            }
        }
    }

    return { raw: line, exception, domain, path, types, thirdParty, onlyOn, notOn };
}

export interface HarvestStats {
    lines: number;
    networkFilters: number;
    anchored: number;
    exceptions: number;
    /** Network filters the corpus builder cannot turn into a request. */
    unreachable: number;
}

export interface Harvest {
    blockedDomains: string[];
    exceptionDomains: string[];
    sites: string[];
    /** Filters restricted by `$domain=` or `$third-party`. */
    scoped: ParsedFilter[];
    /** Filters whose pattern carries a literal path. */
    withPath: ParsedFilter[];
    stats: HarvestStats;
}

export function harvest(lines: string[]): Harvest {
    const blocked = new Set<string>();
    const exceptions = new Set<string>();
    const scoped: ParsedFilter[] = [];
    const withPath: ParsedFilter[] = [];
    const stats: HarvestStats = {
        lines: lines.length, networkFilters: 0, anchored: 0, exceptions: 0, unreachable: 0,
    };

    for (const raw of lines) {
        if (isNoise(raw)) continue;
        const line = raw.trim();
        if (COSMETIC_MARKER.test(line) && !line.startsWith('/')) continue;

        stats.networkFilters += 1;
        const parsed = parseFilter(line);
        if (parsed === null) {
            stats.unreachable += 1;
            continue;
        }

        if (parsed.exception) {
            exceptions.add(parsed.domain);
            stats.exceptions += 1;
        } else {
            blocked.add(parsed.domain);
            stats.anchored += 1;
            if (parsed.onlyOn.length > 0 || parsed.thirdParty) scoped.push(parsed);
            if (parsed.path !== null) withPath.push(parsed);
        }
    }

    return {
        blockedDomains: [...blocked].sort(),
        exceptionDomains: [...exceptions].sort(),
        sites: harvestSiteDomains(lines),
        scoped,
        withPath,
        stats,
    };
}

/** Domains that must keep working; none of them belongs in a filter list. */
export const CONTROL_DOMAINS = [
    'wikipedia.org', 'github.com', 'mozilla.org', 'debian.org', 'kernel.org',
    'service-public.fr', 'insee.fr', 'openstreetmap.org', 'archive.org',
    'gnu.org', 'python.org', 'rust-lang.org', 'postgresql.org', 'sqlite.org',
];

const TYPES: RequestType[] = ['script', 'image', 'xmlhttprequest', 'sub_frame', 'stylesheet'];

const PATHS: Record<RequestType, string[]> = {
    script: ['/ads.js', '/tag/js/gpt.js', '/analytics.js', '/js/track.js'],
    image: ['/pixel.gif', '/img/banner.png', '/beacon.gif'],
    xmlhttprequest: ['/api/track', '/collect?v=1', '/rt'],
    sub_frame: ['/iframe.html', '/ad/frame'],
    stylesheet: ['/style.css', '/css/ads.css'],
};

export interface CorpusOptions {
    /** Distinct first-party origins, each becoming one page load. */
    sites: number;
    /** Third-party requests issued per site. */
    requestsPerSite: number;
    seed: number;
}

/**
 * Assembles the corpus.
 *
 * Each site gets a mix: mostly domains that appear in block filters, some from
 * exception filters, one first-party request, and one control. The negatives
 * matter as much as the positives — a blocker that blocks everything would
 * score a perfect blocking rate and be useless.
 */
export function buildCorpus(harvested: Harvest, options: CorpusOptions): Probe[] {
    const random = makeRandom(options.seed);

    // A few harvested names are themselves blocked domains — `ad.mail.ru` is
    // both a filter target and a `$domain=` value. Using one as a first-party
    // origin makes the page itself unreachable, so they are not eligible.
    const blocked = new Set(harvested.blockedDomains);
    const eligible = harvested.sites.filter((s) => !blocked.has(s));
    const sites = sample(eligible, options.sites, random);
    if (sites.length === 0) throw new Error('no usable site domains harvested from the lists');

    const probes: Probe[] = [];
    let counter = 0;
    const uniquify = (url: string): string => {
        counter += 1;
        return `${url}${url.includes('?') ? '&' : '?'}p=${String(counter)}`;
    };
    const nextUrl = (domain: string, type: RequestType): string => {
        const paths = PATHS[type];
        // Unique per probe: a repeated URL could be served from cache and never
        // reach the network, which would read as "not blocked".
        return uniquify(`http://${domain}${paths[Math.floor(random() * paths.length)]}`);
    };
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];

    // Scoped filters, in pairs. These are the discriminating probes: the same
    // request from a context the filter covers and from one it does not.
    const scopedBudget = Math.floor(options.sites * options.requestsPerSite * 0.2);
    for (const filter of sample(harvested.scoped, Math.floor(scopedBudget / 2), random)) {
        const type = filter.types.length > 0 ? pick(filter.types) : pick(TYPES);
        const url = uniquify(`http://${filter.domain}${filter.path ?? pick(PATHS[type])}`);

        const inside = filter.onlyOn.length > 0 ? pick(filter.onlyOn) : pick(sites);
        probes.push({ url, initiator: inside, type, origin: 'scoped-in', from: filter.raw });

        // Outside: a site the filter does not name, or — for a third-party-only
        // filter — the first-party context, where it must not apply.
        const outside = filter.onlyOn.length > 0
            ? (sites.find((s) => !filter.onlyOn.includes(s)) ?? 'unrelated-9f3a2b.test')
            : filter.domain;
        probes.push({
            url: uniquify(`http://${filter.domain}${filter.path ?? pick(PATHS[type])}`),
            initiator: outside, type, origin: 'scoped-out', from: filter.raw,
        });
    }

    // Filters with a literal path, using that path rather than a generic one.
    const pathBudget = Math.floor(options.sites * options.requestsPerSite * 0.1);
    for (const filter of sample(harvested.withPath, pathBudget, random)) {
        const type = filter.types.length > 0 ? pick(filter.types) : pick(TYPES);
        probes.push({
            url: uniquify(`http://${filter.domain}${filter.path ?? ''}`),
            initiator: filter.onlyOn.length > 0 ? pick(filter.onlyOn) : pick(sites),
            type, origin: 'path', from: filter.raw,
        });
    }

    for (const site of sites) {
        for (let i = 0; i < options.requestsPerSite; i += 1) {
            const type = pick(TYPES);
            const roll = random();

            if (roll < 0.7 && harvested.blockedDomains.length > 0) {
                probes.push({
                    url: nextUrl(pick(harvested.blockedDomains), type),
                    initiator: site, type, origin: 'anchored',
                });
            } else if (roll < 0.82 && harvested.exceptionDomains.length > 0) {
                probes.push({
                    url: nextUrl(pick(harvested.exceptionDomains), type),
                    initiator: site, type, origin: 'exception',
                });
            } else if (roll < 0.91) {
                probes.push({ url: nextUrl(site, type), initiator: site, type, origin: 'first-party' });
            } else {
                probes.push({
                    url: nextUrl(pick(CONTROL_DOMAINS), type),
                    initiator: site, type, origin: 'control',
                });
            }
        }
    }

    return probes;
}
