import { describe, expect, it } from 'vitest';
import { parseCosmeticFilter } from '../src/index.js';

const parse = (line: string) => {
    const result = parseCosmeticFilter(line);
    if (result === null) throw new Error(`failed to parse: ${line}`);
    return result;
};

describe('separators', () => {
    it('parses a site-specific hide filter', () => {
        const filter = parse('example.com##.ad-banner');
        expect(filter.kind).toBe('hide');
        expect(filter.selector).toBe('.ad-banner');
        expect(filter.domains).toEqual(['example.com']);
        expect(filter.isGeneric).toBe(false);
    });

    it('parses a generic filter', () => {
        const filter = parse('##.advert');
        expect(filter.isGeneric).toBe(true);
        expect(filter.domains).toEqual([]);
    });

    it('parses an exception', () => {
        expect(parse('example.com#@#.ad').kind).toBe('exception');
    });

    it('splits included and excluded domains', () => {
        const filter = parse('a.com,~b.com,c.com##.ad');
        expect(filter.domains).toEqual(['a.com', 'c.com']);
        expect(filter.excludedDomains).toEqual(['b.com']);
    });

    it('lowercases domains', () => {
        expect(parse('EXAMPLE.com##.ad').domains).toEqual(['example.com']);
    });

    it('treats a bare * domain as generic', () => {
        // Taken literally this yields the match pattern `*://*.*/*`, which
        // Chrome rejects — refusing to load the entire extension.
        const filter = parse('*##.ad');
        expect(filter.isGeneric).toBe(true);
        expect(filter.domains).toEqual([]);
    });

    it('ignores scriptlets, which belong to phase 3', () => {
        expect(parseCosmeticFilter('example.com##+js(aopr, ads)')).toBeNull();
        expect(parseCosmeticFilter('example.com#%#//scriptlet("abort")')).toBeNull();
    });

    it('ignores network rules and comments', () => {
        expect(parseCosmeticFilter('||ads.com^')).toBeNull();
        expect(parseCosmeticFilter('! a comment')).toBeNull();
        expect(parseCosmeticFilter('/regex#with-hash/')).toBeNull();
    });
});

describe('procedural detection', () => {
    it('does not treat :has() as procedural — Chrome supports it natively', () => {
        const filter = parse('example.com##.item:has(.sponsor)');
        expect(filter.isProcedural).toBe(false);
    });

    it.each([
        ['example.com##.item:has-text(Sponsored)'],
        ['example.com##.item:upward(2)'],
        ['example.com##.item:matches-css(display: none)'],
        ['example.com##.item:xpath(//div)'],
        ['example.com##.item:-abp-contains(Ad)'],
    ])('treats %s as procedural', (line) => {
        expect(parse(line).isProcedural).toBe(true);
    });
});

describe(':style and CSS injection', () => {
    it('parses uBO :style() syntax', () => {
        const filter = parse('example.com##.ad:style(height: 0 !important)');
        expect(filter.kind).toBe('style');
        expect(filter.selector).toBe('.ad');
        expect(filter.declaration).toBe('height: 0 !important');
    });

    it('parses AdGuard #$# syntax', () => {
        const filter = parse('example.com#$#.ad { height: 0; }');
        expect(filter.kind).toBe('style');
        expect(filter.selector).toBe('.ad');
        expect(filter.declaration).toBe('height: 0;');
    });
});

describe('malformed input', () => {
    it('rejects an empty selector', () => {
        expect(parseCosmeticFilter('example.com##')).toBeNull();
    });

    it('rejects unbalanced brackets', () => {
        expect(parseCosmeticFilter('example.com##.ad:has-text(oops')).toBeNull();
    });
});
