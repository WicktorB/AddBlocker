import { describe, expect, it } from 'vitest';
import { parseNetworkFilter } from '@addblocker/filter-parser';
import { BAND, compile, expandWildcardDomains, validateRule, validateRuleset } from '../src/index.js';

const rulesFor = (...lines: string[]) => {
    const filters = lines.map((line) => {
        const parsed = parseNetworkFilter(line);
        if (parsed === null) throw new Error(`failed to parse: ${line}`);
        return parsed;
    });
    return compile(filters);
};

const ruleFor = (line: string) => {
    const { rules } = rulesFor(line);
    expect(rules).toHaveLength(1);
    return rules[0];
};

describe('translation', () => {
    it('turns a domain anchor into requestDomains', () => {
        const rule = ruleFor('||ads.example.com^');
        expect(rule.condition.requestDomains).toEqual(['ads.example.com']);
        expect(rule.action.type).toBe('block');
    });

    it('keeps a non-anchored pattern as urlFilter', () => {
        expect(ruleFor('/banner.gif').condition.urlFilter).toBe('/banner.gif');
    });

    it('maps third-party to domainType', () => {
        expect(ruleFor('||x.com^$third-party').condition.domainType).toBe('thirdParty');
    });

    it('maps an exception to allow', () => {
        const rule = ruleFor('@@||cdn.x.com^');
        expect(rule.action.type).toBe('allow');
        expect(rule.priority).toBeGreaterThanOrEqual(BAND.allow);
        expect(rule.priority).toBeLessThan(BAND.importantBlock);
    });

    it('maps a document exception to allowAllRequests', () => {
        const rule = ruleFor('@@||x.com^$document');
        expect(rule.action.type).toBe('allowAllRequests');
        expect(rule.priority).toBe(BAND.allowAllRequests);
    });

    it('lifts $important into its own band', () => {
        const rule = ruleFor('||x.com^$important');
        expect(rule.priority).toBeGreaterThanOrEqual(BAND.importantBlock);
        expect(rule.priority).toBeLessThan(BAND.importantAllow);
    });

    it('orders bands so exceptions outrank plain blocks', () => {
        expect(ruleFor('@@||x.com^').priority).toBeGreaterThan(ruleFor('||x.com^').priority);
    });

    it('gives a domain-scoped filter more specificity than a bare one', () => {
        expect(ruleFor('||x.com^$domain=a.com').priority).toBeGreaterThan(ruleFor('||x.com^').priority);
    });

    it('turns $popup into a main_frame block', () => {
        const rule = ruleFor('||spam.example^$popup');
        expect(rule.action.type).toBe('block');
        expect(rule.condition.resourceTypes).toEqual(['main_frame']);
    });

    it('turns $csp into a header append', () => {
        const rule = ruleFor("||x.com^$csp=script-src 'none'");
        expect(rule.action.type).toBe('modifyHeaders');
        expect(rule.action.responseHeaders?.[0]).toMatchObject({
            header: 'content-security-policy',
            operation: 'append',
        });
    });

    it('turns $removeparam into a query transform', () => {
        const rule = ruleFor('||x.com^$removeparam=utm_source');
        expect(rule.action.redirect?.transform?.queryTransform?.removeParams).toEqual(['utm_source']);
    });

    it('points $redirect at a bundled resource', () => {
        expect(ruleFor('||x.com^$redirect=noopjs').action.redirect?.extensionPath).toBe('/redirects/noopjs');
    });
});

describe('wildcard TLD expansion', () => {
    it('expands example.* across known TLDs', () => {
        const { expanded, didExpand } = expandWildcardDomains(['example.*']);
        expect(didExpand).toBe(true);
        expect(expanded).toContain('example.com');
        expect(expanded).toContain('example.fr');
        expect(expanded.every((d) => !d.includes('*'))).toBe(true);
    });

    it('leaves plain domains untouched', () => {
        const { expanded, didExpand } = expandWildcardDomains(['a.com', 'b.net']);
        expect(didExpand).toBe(false);
        expect(expanded).toEqual(['a.com', 'b.net']);
    });

    it('recovers a filter that would otherwise be dropped', () => {
        const { rules, stats } = rulesFor('||ads.com^$domain=shop.*');
        expect(stats.unconvertible).toBe(0);
        expect(stats.tldExpanded).toBe(1);
        expect(rules[0].condition.initiatorDomains).toContain('shop.com');
    });
});

describe('merging', () => {
    it('collapses rules that differ only by domain', () => {
        const { rules } = rulesFor('||a.com^$third-party', '||b.com^$third-party');
        expect(rules).toHaveLength(1);
        expect(rules[0].condition.requestDomains).toEqual(['a.com', 'b.com']);
    });

    it('keeps rules apart when any other condition differs', () => {
        const { rules } = rulesFor('||a.com^$script', '||b.com^$image');
        expect(rules).toHaveLength(2);
    });

    it('never merges regex rules', () => {
        const { rules } = rulesFor('/ad1/', '/ad2/');
        expect(rules).toHaveLength(2);
    });

    it('never merges unsafe actions, whose payloads are per-rule', () => {
        const { rules } = rulesFor('||a.com^$redirect=noopjs', '||b.com^$redirect=noopjs');
        expect(rules).toHaveLength(2);
    });

    it('deduplicates identical filters', () => {
        const { rules } = rulesFor('||a.com^', '||a.com^');
        expect(rules).toHaveLength(1);
    });

    it('tracks every source filter behind a merged rule', () => {
        const { rules, sourceMap } = rulesFor('||a.com^', '||b.com^');
        expect(sourceMap.get(rules[0].id)).toEqual(['||a.com^', '||b.com^']);
    });
});

describe('$badfilter', () => {
    it('removes the filter it targets', () => {
        const { rules, stats } = rulesFor('||ads.com^', '||ads.com^$badfilter');
        expect(stats.badfilterRemoved).toBe(1);
        expect(rules).toHaveLength(0);
    });

    it('leaves other filters alone', () => {
        const { rules } = rulesFor('||ads.com^', '||other.com^', '||ads.com^$badfilter');
        expect(rules).toHaveLength(1);
        expect(rules[0].condition.requestDomains).toEqual(['other.com']);
    });
});

describe('conversion accounting', () => {
    it('counts cosmetic-scoped filters separately, not as failures', () => {
        const { stats } = rulesFor('@@||x.com^$elemhide');
        expect(stats.cosmeticScoped).toBe(1);
        expect(stats.unconvertible).toBe(0);
    });

    it('rejects a regex with a lookahead rather than poisoning the ruleset', () => {
        const { rules, stats } = rulesFor('/(?=ads)x/');
        expect(rules).toHaveLength(0);
        expect(stats.unconvertibleReasons['regex:lookahead']).toBe(1);
    });

    it('rejects unsupported options', () => {
        expect(rulesFor('||x.com^$replace=/a/b/').stats.unconvertible).toBe(1);
    });
});

describe('rule validation', () => {
    it('accepts a well-formed rule', () => {
        expect(validateRule(ruleFor('||ads.com^'))).toEqual([]);
    });

    it('rejects a condition that would match everything', () => {
        const problems = validateRule({
            id: 1, priority: 1000, action: { type: 'block' }, condition: {},
        });
        expect(problems.join(' ')).toContain('matches everything');
    });

    it('rejects an unsupported regex', () => {
        const problems = validateRule({
            id: 1, priority: 1000, action: { type: 'block' }, condition: { regexFilter: '(?=x)' },
        });
        expect(problems.join(' ')).toContain('lookahead');
    });

    it('rejects a malformed domain entry', () => {
        const problems = validateRule({
            id: 1, priority: 1000, action: { type: 'block' }, condition: { requestDomains: ['bad.*'] },
        });
        expect(problems.join(' ')).toContain('malformed');
    });

    it('rejects duplicate ids across a ruleset', () => {
        const rule = { id: 1, priority: 1000, action: { type: 'block' as const }, condition: { requestDomains: ['a.com'] } };
        const broken = validateRuleset([rule, { ...rule }]);
        expect(broken.map((b) => b.problems.join(' ')).join(' ')).toContain('duplicate rule id');
    });

    it('produces rulesets that always pass validation', () => {
        const { rules } = rulesFor(
            '||a.com^$third-party', '@@||b.com^$document', '||c.com^$redirect=noopjs',
            "||d.com^$csp=script-src 'none'", '||e.com^$removeparam=utm', '||f.com^$popup',
        );
        expect(validateRuleset(rules)).toEqual([]);
    });
});
