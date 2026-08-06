import { describe, expect, it } from 'vitest';
import {
    anchoredDomain,
    buildCorpus,
    harvest,
    harvestSiteDomains,
    makeRandom,
    parseFilter,
    sample,
} from '../src/corpus.js';

describe('anchoredDomain', () => {
    it.each([
        ['||example.com^', 'example.com'],
        ['||ads.example.com^$script', 'ads.example.com'],
        ['||example.com/path/to/ad.js', 'example.com'],
        ['||example.com*', 'example.com'],
        ['||example.com$third-party', 'example.com'],
    ])('reads %j as %j', (line, expected) => {
        expect(anchoredDomain(line)).toBe(expected);
    });

    it.each([
        ['/banner/i', 'a regex filter'],
        ['ads.js', 'a bare substring'],
        ['||localhost^', 'no dot, so not a site'],
        ['||example.*^', 'a TLD wildcard cannot become one request'],
    ])('rejects %j (%s)', (line) => {
        expect(anchoredDomain(line)).toBeNull();
    });
});

describe('parseFilter', () => {
    it('reads the scope of a $domain= filter', () => {
        const parsed = parseFilter('||ads.example^$script,domain=a.com|b.com');
        expect(parsed?.domain).toBe('ads.example');
        expect(parsed?.types).toEqual(['script']);
        expect(parsed?.onlyOn).toEqual(['a.com', 'b.com']);
    });

    it('separates excluded sites from included ones', () => {
        const parsed = parseFilter('||ads.example^$domain=a.com|~b.com');
        expect(parsed?.onlyOn).toEqual(['a.com']);
        expect(parsed?.notOn).toEqual(['b.com']);
    });

    it('marks third-party filters, whose scope depends on the origin', () => {
        expect(parseFilter('||ads.example^$third-party')?.thirdParty).toBe(true);
        expect(parseFilter('||ads.example^$script')?.thirdParty).toBe(false);
    });

    it('keeps a literal path so the probe exercises the pattern', () => {
        expect(parseFilter('||example.com/pagead/js/x.js$script')?.path)
            .toBe('/pagead/js/x.js');
        expect(parseFilter('||example.com^$script')?.path).toBeNull();
    });

    it('recognises an exception', () => {
        expect(parseFilter('@@||example.com^$script')?.exception).toBe(true);
        expect(parseFilter('||example.com^$script')?.exception).toBe(false);
    });

    it('ignores comments and cosmetic rules', () => {
        expect(parseFilter('! a comment')).toBeNull();
        expect(parseFilter('example.com##.ad')).toBeNull();
        expect(parseFilter('')).toBeNull();
    });
});

describe('harvestSiteDomains', () => {
    it('takes real site names from cosmetic rules and $domain=', () => {
        const sites = harvestSiteDomains([
            'lemonde.fr,lefigaro.fr##.pub',
            '||ads.example^$domain=liberation.fr',
            '! comment',
        ]);
        expect(sites).toContain('lemonde.fr');
        expect(sites).toContain('lefigaro.fr');
        expect(sites).toContain('liberation.fr');
    });

    it('strips the negation from an excluded site', () => {
        expect(harvestSiteDomains(['~lemonde.fr##.pub'])).toContain('lemonde.fr');
    });

    it('skips wildcards, which are not one site', () => {
        expect(harvestSiteDomains(['example.*##.pub'])).toEqual([]);
    });
});

describe('harvest', () => {
    const lines = [
        '||ads.example^',
        '||tracker.example^$third-party',
        '||scoped.example^$domain=news.test',
        '||path.example/ads/banner.js',
        '@@||allowed.example^',
        '/regex-only/',
        'news.test##.ad',
    ];

    it('separates blocked from exception domains', () => {
        const result = harvest(lines);
        expect(result.blockedDomains).toContain('ads.example');
        expect(result.exceptionDomains).toEqual(['allowed.example']);
    });

    it('collects the scoped filters the discriminating probes need', () => {
        const result = harvest(lines);
        expect(result.scoped.map((f) => f.domain).sort())
            .toEqual(['scoped.example', 'tracker.example']);
    });

    it('counts filters no probe can be derived from', () => {
        // Reported rather than ignored: the coverage claim would otherwise
        // imply the corpus reaches parts of the lists it never touches.
        expect(harvest(lines).stats.unreachable).toBe(1);
    });
});

describe('buildCorpus', () => {
    const harvested = harvest([
        '||ads.example^',
        '||other.example^',
        '||scoped.example^$domain=news.test',
        '@@||allowed.example^',
        'news.test##.ad',
        'shop.test##.ad',
    ]);

    it('pairs each scoped filter with a context it does not cover', () => {
        const probes = buildCorpus(harvested, { sites: 2, requestsPerSite: 20, seed: 1 });
        expect(probes.some((p) => p.origin === 'scoped-in')).toBe(true);
        expect(probes.some((p) => p.origin === 'scoped-out')).toBe(true);
    });

    it('includes requests that must not be blocked', () => {
        const probes = buildCorpus(harvested, { sites: 2, requestsPerSite: 40, seed: 7 });
        // A blocker that blocks everything would score a perfect blocking rate;
        // the negatives are what make the number mean anything.
        expect(probes.some((p) => p.origin === 'control')).toBe(true);
        expect(probes.some((p) => p.origin === 'first-party')).toBe(true);
    });

    it('never uses a blocked domain as a first-party origin', () => {
        // Such a page cannot load at all, and its probes would read as misses.
        const blocked = new Set(harvested.blockedDomains);
        const probes = buildCorpus(harvested, { sites: 2, requestsPerSite: 10, seed: 3 });
        expect(probes.every((p) => !blocked.has(p.initiator))).toBe(true);
    });

    it('gives every probe a distinct URL', () => {
        // A repeated URL could be served from cache, never reach the network,
        // and read as "not blocked".
        const probes = buildCorpus(harvested, { sites: 2, requestsPerSite: 25, seed: 11 });
        expect(new Set(probes.map((p) => p.url)).size).toBe(probes.length);
    });

    it('is reproducible for a given seed', () => {
        const a = buildCorpus(harvested, { sites: 2, requestsPerSite: 10, seed: 42 });
        const b = buildCorpus(harvested, { sites: 2, requestsPerSite: 10, seed: 42 });
        expect(a.map((p) => p.url)).toEqual(b.map((p) => p.url));
    });
});

describe('sample', () => {
    it('returns everything when asked for more than there is', () => {
        expect(sample([1, 2, 3], 10, makeRandom(1))).toHaveLength(3);
    });

    it('returns distinct items', () => {
        const picked = sample([1, 2, 3, 4, 5, 6, 7, 8], 5, makeRandom(9));
        expect(new Set(picked).size).toBe(5);
    });
});
