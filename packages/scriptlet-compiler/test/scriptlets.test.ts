import { describe, expect, it } from 'vitest';
import {
    compileScriptlets, parseScriptletFilter, renderScriptletBucket, splitArgs,
} from '../src/index.js';

const parse = (line: string) => {
    const result = parseScriptletFilter(line);
    if (result === null) throw new Error(`failed to parse: ${line}`);
    return result;
};

const compileLines = (...lines: string[]) => compileScriptlets(lines.map(parse));

describe('splitArgs', () => {
    it('splits on commas', () => {
        expect(splitArgs('set, flag, true')).toEqual(['set', 'flag', 'true']);
    });

    it('keeps a regex containing commas as one argument', () => {
        expect(splitArgs('aeld, /^(a|b){2,3}$/, x')).toEqual(['aeld', '/^(a|b){2,3}$/', 'x']);
    });

    it('honours an escaped comma', () => {
        expect(splitArgs('set, a\\,b, 1')).toEqual(['set', 'a,b', '1']);
    });

    it('preserves empty arguments, which are positional', () => {
        expect(splitArgs('trusted-click-element, button, , 500'))
            .toEqual(['trusted-click-element', 'button', '', '500']);
    });
});

describe('parsing', () => {
    it('parses uBO syntax', () => {
        const filter = parse('example.com##+js(aopr, document.oncontextmenu)');
        expect(filter.name).toBe('aopr');
        expect(filter.args).toEqual(['document.oncontextmenu']);
        expect(filter.domains).toEqual(['example.com']);
    });

    it('parses AdGuard syntax with quotes stripped', () => {
        const filter = parse('example.com#%#//scriptlet("abort-on-property-read", "foo")');
        expect(filter.name).toBe('abort-on-property-read');
        expect(filter.args).toEqual(['foo']);
    });

    it('parses an exception', () => {
        expect(parse('example.com#@#+js(aopr, foo)').isException).toBe(true);
    });

    it('splits included and excluded domains', () => {
        const filter = parse('a.com,~b.com##+js(nowebrtc)');
        expect(filter.domains).toEqual(['a.com']);
        expect(filter.excludedDomains).toEqual(['b.com']);
    });

    it('ignores cosmetic and network filters', () => {
        expect(parseScriptletFilter('example.com##.ad')).toBeNull();
        expect(parseScriptletFilter('||ads.com^')).toBeNull();
    });

    it('rejects an unterminated invocation', () => {
        expect(parseScriptletFilter('example.com##+js(aopr, foo')).toBeNull();
    });
});

describe('compilation', () => {
    it('indexes an invocation under its domain', () => {
        const result = compileLines('example.com##+js(nowebrtc)');
        expect(result.buckets[0].invocations['example.com']).toEqual([['nowebrtc']]);
    });

    it('deduplicates identical invocations', () => {
        const result = compileLines('example.com##+js(nowebrtc)', 'example.com##+js(nowebrtc)');
        expect(result.buckets[0].invocations['example.com']).toHaveLength(1);
    });

    it('keeps invocations that differ by argument', () => {
        const result = compileLines('example.com##+js(set, a, 1)', 'example.com##+js(set, b, 2)');
        expect(result.buckets[0].invocations['example.com']).toHaveLength(2);
    });

    it('counts scriptlets missing from the catalogue instead of silently dropping them', () => {
        const result = compileLines('example.com##+js(not-a-real-scriptlet)');
        expect(result.stats.unknownScriptlets).toBe(1);
        expect(result.stats.unknownByName['not-a-real-scriptlet']).toBe(1);
        expect(result.stats.domains).toBe(0);
    });

    it('resolves an alias to its implementation', () => {
        // `aopr` is uBO shorthand for abort-on-property-read.
        expect(compileLines('example.com##+js(aopr, foo)').stats.unknownScriptlets).toBe(0);
    });

    it('lets an exception disable a scriptlet on its domain', () => {
        const result = compileLines('example.com##+js(nowebrtc)', 'example.com#@#+js(nowebrtc)');
        expect(result.stats.domains).toBe(0);
    });

    it('leaves other scriptlets on the domain untouched by an exception', () => {
        const result = compileLines(
            'example.com##+js(nowebrtc)',
            'example.com##+js(aopr, foo)',
            'example.com#@#+js(nowebrtc)',
        );
        expect(result.buckets[0].invocations['example.com']).toEqual([['aopr', 'foo']]);
    });

    it('does not apply generic scriptlets site-wide', () => {
        // Hooking globals on every site has a far larger blast radius than a
        // generic cosmetic selector.
        const result = compileLines('##+js(nowebrtc)');
        expect(result.stats.genericSkipped).toBe(1);
        expect(result.stats.domains).toBe(0);
    });

    it('expands a wildcard TLD', () => {
        const result = compileLines('shop.*##+js(nowebrtc)');
        const domains = result.buckets.flatMap((b) => b.domains);
        expect(domains).toContain('shop.com');
        expect(domains).toContain('shop.fr');
    });

    it('drops domains that cannot become match patterns', () => {
        const result = compileLines('exam ple.com##+js(nowebrtc)');
        expect(result.stats.domains).toBe(0);
        expect(result.stats.skippedDomains).toBe(1);
    });
});

describe('generated bucket code', () => {
    it('walks up the hostname', () => {
        const code = renderScriptletBucket(compileLines('example.com##+js(nowebrtc)').buckets[0]);
        expect(code).toContain('host.indexOf');
        expect(code).toContain('example.com');
    });

    it('emits parseable JSON', () => {
        const code = renderScriptletBucket(
            compileLines('example.com##+js(set, a.b, /re,gex/)').buckets[0],
        );
        const match = /^const I = (\{.*\});$/m.exec(code);
        expect(match).not.toBeNull();
        expect(() => JSON.parse(match![1])).not.toThrow();
    });
});
