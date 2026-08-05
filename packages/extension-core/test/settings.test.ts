import { describe, expect, it } from 'vitest';
import {
    ALLOWLIST_PRIORITY,
    DEFAULT_SETTINGS,
    buildAllowlistRules,
    buildCosmeticUserRules,
    buildExcludeMatches,
    isSiteDisabled,
    normaliseHostname,
    parseUserFilter,
    type Settings,
} from '../src/settings.js';

const settingsWith = (partial: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...partial });

describe('normaliseHostname', () => {
    it.each([
        ['example.com', 'example.com'],
        ['www.example.com', 'example.com'],
        ['EXAMPLE.com', 'example.com'],
        ['https://example.com/path?q=1', 'example.com'],
        ['example.com:8080', 'example.com'],
        ['  example.com  ', 'example.com'],
    ])('normalises %j to %j', (input, expected) => {
        expect(normaliseHostname(input)).toBe(expected);
    });

    it.each([[''], ['localhost'], ['not a host'], ['*'], ['..']])(
        'rejects %j', (input) => {
            expect(normaliseHostname(input)).toBeNull();
        },
    );
});

describe('isSiteDisabled', () => {
    const settings = settingsWith({ disabledSites: ['example.com'] });

    it('matches the domain itself', () => {
        expect(isSiteDisabled(settings, 'example.com')).toBe(true);
    });

    it('matches subdomains', () => {
        expect(isSiteDisabled(settings, 'news.example.com')).toBe(true);
        expect(isSiteDisabled(settings, 'www.example.com')).toBe(true);
    });

    it('does not match a lookalike domain', () => {
        // notexample.com must not be caught by a rule on example.com.
        expect(isSiteDisabled(settings, 'notexample.com')).toBe(false);
        expect(isSiteDisabled(settings, 'example.com.evil.net')).toBe(false);
    });
});

describe('buildAllowlistRules', () => {
    it('uses allowAllRequests so subresources are covered too', () => {
        const [rule] = buildAllowlistRules(settingsWith({ disabledSites: ['example.com'] }));
        expect(rule.action.type).toBe('allowAllRequests');
        expect(rule.condition.requestDomains).toEqual(['example.com']);
    });

    it('outranks every static band, including $important blocks', () => {
        const [rule] = buildAllowlistRules(settingsWith({ disabledSites: ['example.com'] }));
        // Static bands top out at 5000; "off here" must mean off.
        expect(rule.priority).toBe(ALLOWLIST_PRIORITY);
        expect(rule.priority).toBeGreaterThan(5_000);
    });

    it('gives each site a distinct id', () => {
        const rules = buildAllowlistRules(settingsWith({ disabledSites: ['a.com', 'b.com'] }));
        expect(new Set(rules.map((r) => r.id)).size).toBe(2);
    });

    it('produces nothing when no site is disabled', () => {
        expect(buildAllowlistRules(DEFAULT_SETTINGS)).toEqual([]);
    });
});

describe('parseUserFilter', () => {
    it('recognises a cosmetic filter', () => {
        const parsed = parseUserFilter('example.com##.ad');
        expect(parsed.kind).toBe('cosmetic');
        expect(parsed.domains).toEqual(['example.com']);
        expect(parsed.selector).toBe('.ad');
    });

    it('recognises a generic cosmetic filter', () => {
        const parsed = parseUserFilter('##.ad');
        expect(parsed.kind).toBe('cosmetic');
        expect(parsed.domains).toEqual([]);
    });

    it('recognises a network filter', () => {
        expect(parseUserFilter('||ads.example.com^').kind).toBe('network');
    });

    it('rejects blanks and comments', () => {
        expect(parseUserFilter('').kind).toBe('invalid');
        expect(parseUserFilter('! note').kind).toBe('invalid');
        expect(parseUserFilter('example.com##').kind).toBe('invalid');
    });
});

describe('buildCosmeticUserRules', () => {
    it('splits generic from per-domain selectors', () => {
        const rules = buildCosmeticUserRules(settingsWith({
            userFilters: ['##.everywhere', 'example.com##.here', '||net.example^'],
        }));
        expect(rules.generic).toEqual(['.everywhere']);
        expect(rules.byDomain).toEqual({ 'example.com': ['.here'] });
    });

    it('collects several selectors for one domain', () => {
        const rules = buildCosmeticUserRules(settingsWith({
            userFilters: ['example.com##.a', 'example.com##.b'],
        }));
        expect(rules.byDomain['example.com']).toEqual(['.a', '.b']);
    });
});

describe('buildExcludeMatches', () => {
    it('produces a valid match pattern per disabled site', () => {
        expect(buildExcludeMatches(settingsWith({ disabledSites: ['example.com'] })))
            .toEqual(['*://*.example.com/*']);
    });

    it('produces nothing when no site is disabled', () => {
        expect(buildExcludeMatches(DEFAULT_SETTINGS)).toEqual([]);
    });
});
