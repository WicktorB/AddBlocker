import { describe, expect, it } from 'vitest';
import { SELECTORS_PER_RULE, buildCss } from '../src/apply.js';

const payload = (hide: string[], extra: Partial<{
    style: Array<[string, string]>; exceptions: string[];
}> = {}) => ({
    hide, procedural: [], style: extra.style ?? [], exceptions: extra.exceptions ?? [],
});

const rules = (css: string): string[] => css.split('\n').filter((l) => l !== '');

describe('buildCss', () => {
    it('groups selectors into one rule when they fit', () => {
        expect(rules(buildCss(payload(['.a', '.b'])))).toEqual(['.a,.b{display:none!important;}']);
    });

    it('splits past the per-rule limit', () => {
        // Blink parses a longer selector list but silently stops matching past
        // 8192 entries, so a single rule would drop the tail without a word.
        const many = Array.from({ length: SELECTORS_PER_RULE * 2 + 5 }, (_, i) => `.s${String(i)}`);
        expect(rules(buildCss(payload(many)))).toHaveLength(3);
    });

    it('keeps every selector across the split', () => {
        const many = Array.from({ length: SELECTORS_PER_RULE + 1 }, (_, i) => `.s${String(i)}`);
        const css = buildCss(payload(many));
        // The last one is the one a single oversized rule would have lost.
        expect(css).toContain(`.s${String(SELECTORS_PER_RULE)}{`);
        for (const selector of many) expect(css).toContain(selector);
    });

    it('stays well under what the engine will match', () => {
        expect(SELECTORS_PER_RULE).toBeLessThanOrEqual(8_192);
    });

    it('drops selectors an exception covers', () => {
        expect(buildCss(payload(['.a', '.b'], { exceptions: ['.a'] })))
            .toBe('.b{display:none!important;}');
    });

    it('emits nothing when everything is excepted', () => {
        expect(buildCss(payload(['.a'], { exceptions: ['.a'] }))).toBe('');
    });

    it('keeps :style() rules separate from the hide groups', () => {
        const css = buildCss(payload(['.a'], { style: [['.b', 'height:0']] }));
        expect(rules(css)).toEqual(['.a{display:none!important;}', '.b{height:0}']);
    });
});
