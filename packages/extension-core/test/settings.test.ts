import { describe, expect, it } from 'vitest';
import {
    ALLOWLIST_PRIORITY,
    DEFAULT_SETTINGS,
    buildAllowlistRules,
    buildCosmeticUserRules,
    buildExcludeMatches,
    exclusionsDiffer,
    isSiteDisabled,
    normaliseHostname,
    parseUserFilter,
    planStaticRuleChanges,
    resolveRulesets,
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

describe('planStaticRuleChanges', () => {
    const ads = { rulesetId: 'ads', ruleId: 12 };
    const privacy = { rulesetId: 'privacy', ruleId: 7 };

    it('disables a newly killed rule', () => {
        expect(planStaticRuleChanges([ads], [])).toEqual([
            { rulesetId: 'ads', disableRuleIds: [12], enableRuleIds: [] },
        ]);
    });

    it('re-enables a rule the user restored', () => {
        // Dropping it from the kill list is not enough: Chrome keeps it
        // disabled until it is named, and the interface would then be lying.
        expect(planStaticRuleChanges([], [ads])).toEqual([
            { rulesetId: 'ads', disableRuleIds: [], enableRuleIds: [12] },
        ]);
    });

    it('groups by ruleset, since ids are only unique within one', () => {
        const changes = planStaticRuleChanges([ads, privacy], []);
        expect(changes).toHaveLength(2);
        expect(changes.map((c) => c.rulesetId).sort()).toEqual(['ads', 'privacy']);
    });

    it('handles a kill and a restore in different rulesets at once', () => {
        const changes = planStaticRuleChanges([ads], [privacy]);
        expect(changes).toContainEqual({ rulesetId: 'ads', disableRuleIds: [12], enableRuleIds: [] });
        expect(changes).toContainEqual({ rulesetId: 'privacy', disableRuleIds: [], enableRuleIds: [7] });
    });

    it('re-asserts a kill that was already applied', () => {
        // Whether Chrome keeps the disabled set across restarts is not
        // documented, and the worker replays this on every start. Re-asserting
        // costs one cheap call; relying on persistence would risk a killed
        // rule quietly coming back.
        expect(planStaticRuleChanges([ads], [ads])).toEqual([
            { rulesetId: 'ads', disableRuleIds: [12], enableRuleIds: [] },
        ]);
    });

    it('asks for nothing when there is nothing to assert', () => {
        expect(planStaticRuleChanges([], [])).toEqual([]);
    });

    it('does not repeat a rule killed twice', () => {
        expect(planStaticRuleChanges([ads, ads], [])).toEqual([
            { rulesetId: 'ads', disableRuleIds: [12], enableRuleIds: [] },
        ]);
    });
});

describe('resolveRulesets', () => {
    const declared = [
        { id: 'ads', enabled: true },
        { id: 'privacy', enabled: true },
        { id: 'annoyances', enabled: false },
    ];

    it('follows the manifest when the user has chosen nothing', () => {
        // The regression that mattered: a list shipping off must stay off,
        // rather than being switched on for everyone by an empty settings file.
        const { enable, disable } = resolveRulesets(DEFAULT_SETTINGS, declared);
        expect(enable).toEqual(['ads', 'privacy']);
        expect(disable).toEqual(['annoyances']);
    });

    it('honours a list the user turned off', () => {
        const { enable, disable } = resolveRulesets(
            settingsWith({ disabledRulesets: ['privacy'] }), declared,
        );
        expect(enable).toEqual(['ads']);
        expect(disable).toEqual(['privacy', 'annoyances']);
    });

    it('honours a list the user turned on although it ships off', () => {
        const { enable } = resolveRulesets(
            settingsWith({ enabledRulesets: ['annoyances'] }), declared,
        );
        expect(enable).toContain('annoyances');
    });

    it('lets an explicit choice win over the default either way', () => {
        const { enable, disable } = resolveRulesets(settingsWith({
            enabledRulesets: ['annoyances'], disabledRulesets: ['ads'],
        }), declared);
        expect(enable).toEqual(['privacy', 'annoyances']);
        expect(disable).toEqual(['ads']);
    });

    it('accounts for every declared ruleset exactly once', () => {
        const { enable, disable } = resolveRulesets(DEFAULT_SETTINGS, declared);
        expect([...enable, ...disable].sort()).toEqual(declared.map((r) => r.id).sort());
    });
});

describe('exclusionsDiffer', () => {
    it('treats never-applied as different', () => {
        expect(exclusionsDiffer(undefined, [])).toBe(true);
    });

    it('reports no difference when they match', () => {
        expect(exclusionsDiffer(['*://*.a.com/*'], ['*://*.a.com/*'])).toBe(false);
        expect(exclusionsDiffer([], [])).toBe(false);
    });

    it('catches a site being added or removed', () => {
        expect(exclusionsDiffer([], ['*://*.a.com/*'])).toBe(true);
        expect(exclusionsDiffer(['*://*.a.com/*'], [])).toBe(true);
    });

    it('catches a site being swapped for another', () => {
        // Same count, different content: missing this would leave scripts
        // running on the site the user just turned off.
        expect(exclusionsDiffer(['*://*.a.com/*'], ['*://*.b.com/*'])).toBe(true);
    });

    it('errs towards reapplying rather than skipping', () => {
        // A reordering is reported as a difference. That costs one needless
        // update; the opposite mistake would be a filtering bug.
        expect(exclusionsDiffer(['*://*.a.com/*', '*://*.b.com/*'],
            ['*://*.b.com/*', '*://*.a.com/*'])).toBe(true);
    });
});
