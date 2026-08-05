import { describe, expect, it } from 'vitest';
import { parseCosmeticFilter } from '@addblocker/filter-parser';
import { compileCosmetic, renderBucket, isUsableDomain } from '../src/index.js';

const compileLines = (...lines: string[]) => {
    const filters = lines.map((line) => {
        const parsed = parseCosmeticFilter(line);
        if (parsed === null) throw new Error(`failed to parse: ${line}`);
        return parsed;
    });
    return compileCosmetic(filters);
};

const payloadFor = (result: ReturnType<typeof compileCosmetic>, domain: string) => {
    for (const bucket of result.buckets) {
        const payload = bucket.payloads[domain];
        if (payload !== undefined) return payload;
    }
    throw new Error(`no payload for ${domain}`);
};

describe('routing', () => {
    it('puts a site-specific selector under its domain', () => {
        const result = compileLines('example.com##.ad');
        expect(payloadFor(result, 'example.com').hide).toEqual(['.ad']);
        expect(result.generic.hide).toEqual([]);
    });

    it('puts a generic selector in the generic payload', () => {
        const result = compileLines('##.advert');
        expect(result.generic.hide).toEqual(['.advert']);
        expect(result.stats.domains).toBe(0);
    });

    it('separates procedural from plain selectors', () => {
        const result = compileLines('example.com##.a:has-text(Ad)', 'example.com##.b');
        const payload = payloadFor(result, 'example.com');
        expect(payload.procedural).toEqual(['.a:has-text(Ad)']);
        expect(payload.hide).toEqual(['.b']);
    });

    it('keeps :style declarations separate', () => {
        const result = compileLines('example.com##.ad:style(height: 0)');
        expect(payloadFor(result, 'example.com').style).toEqual([['.ad', 'height: 0']]);
    });

    it('records exceptions against their domain', () => {
        const result = compileLines('example.com#@#.ad');
        expect(payloadFor(result, 'example.com').exceptions).toEqual(['.ad']);
    });

    it('applies a multi-domain filter to each domain', () => {
        const result = compileLines('a.com,b.com##.ad');
        expect(payloadFor(result, 'a.com').hide).toEqual(['.ad']);
        expect(payloadFor(result, 'b.com').hide).toEqual(['.ad']);
    });

    it('deduplicates repeated selectors', () => {
        const result = compileLines('example.com##.ad', 'example.com##.ad');
        expect(payloadFor(result, 'example.com').hide).toEqual(['.ad']);
    });
});

describe('domain handling', () => {
    it('expands a wildcard TLD', () => {
        const result = compileLines('shop.*##.ad');
        expect(payloadFor(result, 'shop.com').hide).toEqual(['.ad']);
        expect(payloadFor(result, 'shop.fr').hide).toEqual(['.ad']);
    });

    it.each([
        ['*', false],
        ['exam ple.com', false],
        ['例え.com', false],
        ['.example.com', false],
        ['example.com.', false],
        ['example..com', false],
        ['example.com', true],
        ['sub.example.co.uk', true],
    ])('isUsableDomain(%j) === %s', (domain, expected) => {
        expect(isUsableDomain(domain)).toBe(expected);
    });

    it('drops filters whose domains cannot become match patterns', () => {
        // A malformed pattern makes Chrome refuse the whole extension.
        const result = compileLines('exam ple.com##.ad');
        expect(result.stats.domains).toBe(0);
        expect(result.stats.skipped).toBe(1);
    });

    it('skips a generic selector carrying domain exclusions', () => {
        // Static per-domain scripts cannot express "everywhere except here";
        // keeping it would silently over-hide.
        const result = compileLines('~example.com##.ad');
        expect(result.generic.hide).toEqual([]);
        expect(result.stats.skipped).toBe(1);
    });
});

describe('generated bucket code', () => {
    it('walks up the hostname so a rule on example.com covers www.example.com', () => {
        const result = compileLines('example.com##.ad');
        const code = renderBucket(result.buckets[0]);
        expect(code).toContain('host.indexOf');
        expect(code).toContain('example.com');
    });

    it('omits domains whose payload ended up empty', () => {
        const result = compileLines('example.com##.ad');
        result.buckets[0].payloads['empty.com'] = { hide: [], style: [], procedural: [], exceptions: [] };
        expect(renderBucket(result.buckets[0])).not.toContain('empty.com');
    });

    it('produces valid JSON in the emitted payload', () => {
        const result = compileLines("example.com##.ad[data-x='y']");
        const code = renderBucket(result.buckets[0]);
        const match = /^const P = (\{.*\});$/m.exec(code);
        expect(match).not.toBeNull();
        expect(() => JSON.parse(match![1])).not.toThrow();
    });
});
