import { describe, expect, it } from 'vitest';
import { classifyLine, parseNetworkFilter } from '../src/index.js';

const parse = (line: string) => {
    const result = parseNetworkFilter(line);
    if (result === null) throw new Error(`failed to parse: ${line}`);
    return result;
};

describe('classifyLine', () => {
    it.each([
        ['! comment', 'comment'],
        ['[Adblock Plus 2.0]', 'comment'],
        ['', 'empty'],
        ['   ', 'empty'],
        ['||ads.com^', 'network'],
        ['||ads.com^$script,third-party', 'network'],
        ['example.com##.ad', 'cosmetic'],
        ['example.com#@#.ad', 'cosmetic'],
        ['example.com#?#.ad:has(.sponsor)', 'cosmetic'],
        ['example.com##+js(aopr, ads)', 'scriptlet'],
        ['example.com#%#//scriptlet("abort-on-property-read")', 'scriptlet'],
        ['example.com#$#body { color: red; }', 'scriptlet'],
    ])('classifies %j as %s', (line, expected) => {
        expect(classifyLine(line)).toBe(expected);
    });

    it('does not mistake a hash inside a regex literal for a cosmetic marker', () => {
        expect(classifyLine('/ads#tracker/')).toBe('network');
    });
});

describe('pattern parsing', () => {
    it('strips the exception marker', () => {
        const filter = parse('@@||cdn.example.com^');
        expect(filter.isException).toBe(true);
        expect(filter.pattern).toBe('||cdn.example.com^');
    });

    it('extracts an anchored domain from ||domain^', () => {
        expect(parse('||ads.example.com^').anchoredDomain).toBe('ads.example.com');
    });

    it('refuses to extract without a trailing separator', () => {
        // ||example.com also matches example.com.evil.net, which
        // requestDomains would not.
        expect(parse('||example.com').anchoredDomain).toBeNull();
    });

    it.each([
        ['||example.com/path^'],
        ['||sub..example.com^'],
        ['||localhost^'],
        ['|http://example.com/'],
    ])('refuses to extract a domain from %s', (pattern) => {
        expect(parse(pattern).anchoredDomain).toBeNull();
    });

    it('recognises a regex literal', () => {
        const filter = parse('/banner\\d+\\.gif/');
        expect(filter.isRegex).toBe(true);
        expect(filter.anchoredDomain).toBeNull();
    });

    it('keeps a dollar sign inside a regex literal out of the options', () => {
        const filter = parse('/ads\\.com\\/x$/$script');
        expect(filter.isRegex).toBe(true);
        expect(filter.pattern).toBe('/ads\\.com\\/x$/');
        expect(filter.options.resourceTypes).toEqual(['script']);
    });
});

describe('options', () => {
    it('maps resource types to DNR names', () => {
        const o = parse('||x.com^$script,image,subdocument,xhr,css').options;
        expect(o.resourceTypes).toEqual(['script', 'image', 'sub_frame', 'xmlhttprequest', 'stylesheet']);
    });

    it('records negated resource types separately', () => {
        const o = parse('||x.com^$~script').options;
        expect(o.excludedResourceTypes).toEqual(['script']);
        expect(o.resourceTypes).toEqual([]);
    });

    it.each([
        ['$third-party', true],
        ['$3p', true],
        ['$~third-party', false],
        ['$first-party', false],
        ['$~first-party', true],
        ['$strict3p', true],
        ['$strict1p', false],
    ])('maps %s to thirdParty=%s', (option, expected) => {
        expect(parse(`||x.com^${option}`).options.thirdParty).toBe(expected);
    });

    it('splits domain= into included and excluded', () => {
        const o = parse('||x.com^$domain=a.com|~b.com|c.com').options;
        expect(o.domains).toEqual(['a.com', 'c.com']);
        expect(o.excludedDomains).toEqual(['b.com']);
    });

    it('treats $to= as an include list, not the inverse of denyallow', () => {
        const o = parse('||x.com^$to=a.com|~b.com').options;
        expect(o.toDomains).toEqual(['a.com']);
        expect(o.denyAllow).toEqual(['b.com']);
    });

    it('treats $denyallow= as an exclusion', () => {
        expect(parse('||x.com^$denyallow=a.com|b.com').options.denyAllow).toEqual(['a.com', 'b.com']);
    });

    it('recognises $popup and $popunder', () => {
        expect(parse('||x.com^$popup').options.popup).toBe(true);
        expect(parse('||x.com^$popunder').options.popup).toBe(true);
    });

    it('accepts $rewrite as a spelling of $redirect', () => {
        expect(parse('||x.com^$rewrite=abp-resource:blank-js').options.redirect).toBe('blank-js');
        expect(parse('||x.com^$redirect=noopjs').options.redirect).toBe('noopjs');
    });

    it('tells $redirect-rule apart from $redirect', () => {
        // They differ in kind, not degree: $redirect blocks and substitutes,
        // $redirect-rule only substitutes for requests already blocked.
        expect(parse('||x.com^$redirect=noopjs').options.redirectRuleOnly).toBe(false);
        expect(parse('||x.com^$redirect-rule=noopjs').options.redirectRuleOnly).toBe(true);
        expect(parse('||x.com^$redirect-rule=noopjs').options.redirect).toBe('noopjs');
    });

    it('separates cosmetic-scoped options from unsupported ones', () => {
        const o = parse('@@||x.com^$elemhide,generichide').options;
        expect(o.cosmeticScope).toEqual(['elemhide', 'generichide']);
        expect(o.unsupported).toEqual([]);
    });

    it('flags genuinely unsupported options', () => {
        expect(parse('||x.com^$replace=/a/b/').options.unsupported).toContain('replace');
    });

    it('ignores uBO no-op padding', () => {
        const o = parse('||x.com^$script,_,__').options;
        expect(o.unsupported).toEqual([]);
        expect(o.resourceTypes).toEqual(['script']);
    });

    it('uppercases methods', () => {
        expect(parse('||x.com^$method=get|post').options.methods).toEqual(['GET', 'POST']);
    });

    it('records important and badfilter', () => {
        expect(parse('||x.com^$important').options.important).toBe(true);
        expect(parse('||x.com^$badfilter').options.badfilter).toBe(true);
    });
});

describe('filters with options and no pattern', () => {
    it('reads `$options` as `*$options`', () => {
        const filter = parse('$script,third-party,domain=a.com|b.com');
        expect(filter.pattern).toBe('*');
        expect(filter.options.resourceTypes).toEqual(['script']);
        expect(filter.options.thirdParty).toBe(true);
        expect(filter.options.domains).toEqual(['a.com', 'b.com']);
    });

    it('still treats a line with neither as nothing', () => {
        expect(parseNetworkFilter('')).toBeNull();
        expect(parseNetworkFilter('@@')).toBeNull();
    });
});
