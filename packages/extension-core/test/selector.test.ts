import { describe, expect, it } from 'vitest';
import {
    buildCosmeticFilter, buildSelector, looksGenerated, rateSelector,
    type ElementDescriptor,
} from '../src/selector.js';

const el = (partial: Partial<ElementDescriptor>): ElementDescriptor => ({
    tag: 'div', id: null, classes: [], attributes: [], nthOfType: 1, ...partial,
});

describe('looksGenerated', () => {
    it.each([['css-1x7ab3'], ['a1b2c3d4'], ['Button__x9k2m'], ['col-1234']])(
        'flags %j as machine-generated', (name) => {
            expect(looksGenerated(name)).toBe(true);
        },
    );

    it.each([
        ['ad-banner'], ['sidebar'], ['promo'], ['header-ad'],
        // These matter most: wrongly flagging a meaningful class pushes the
        // picker onto a positional selector, which is strictly worse.
        ['col-md-6'], ['h2'], ['btn-primary'], ['ad-slot-top'], ['banner'],
    ])('accepts %j as meaningful', (name) => {
        expect(looksGenerated(name)).toBe(false);
    });
});

describe('buildSelector', () => {
    it('prefers a stable id above all', () => {
        expect(buildSelector([el({ id: 'ad-slot', classes: ['x'] })])).toBe('#ad-slot');
    });

    it('ignores a generated id', () => {
        // Anchoring on css-1a2b3c would break at the site's next deploy.
        expect(buildSelector([el({ id: 'css-1a2b3c', classes: ['promo'] })])).toBe('div.promo');
    });

    it('prefers a meaningful attribute over a class', () => {
        expect(buildSelector([el({ classes: ['promo'], attributes: [['data-ad', 'top']] })]))
            .toBe('div[data-ad="top"]');
    });

    it('uses only stable classes', () => {
        expect(buildSelector([el({ classes: ['css-9f8e7d', 'ad-unit'] })])).toBe('div.ad-unit');
    });

    it('falls back to an ancestor anchor when the element has nothing stable', () => {
        const selector = buildSelector([
            el({ tag: 'section', id: 'content' }),
            el({ tag: 'div', classes: ['css-1a2b3c'], nthOfType: 2 }),
        ]);
        expect(selector).toBe('#content > div:nth-of-type(2)');
    });

    it('falls back to structure only as a last resort', () => {
        const selector = buildSelector([
            el({ tag: 'section', classes: ['css-000aaa'] }),
            el({ tag: 'div', classes: ['css-1a2b3c'], nthOfType: 3 }),
        ]);
        expect(selector).toBe('section:nth-of-type(1) > div:nth-of-type(3)');
    });

    it('returns nothing for an empty path', () => {
        expect(buildSelector([])).toBe('');
    });
});

describe('rateSelector', () => {
    it('rates an id anchor as strong', () => {
        expect(rateSelector('#ad-slot').score).toBe('strong');
    });

    it('rates an attribute anchor as strong', () => {
        expect(rateSelector('div[data-ad="top"]').score).toBe('strong');
    });

    it('rates a class anchor as fair', () => {
        expect(rateSelector('div.promo').score).toBe('fair');
    });

    it('rates a positional selector as brittle', () => {
        // The user should know this one will break, at the moment they make it.
        expect(rateSelector('div:nth-of-type(3) > span:nth-of-type(1)').score).toBe('brittle');
    });
});

describe('buildCosmeticFilter', () => {
    it('assembles host and selector, dropping www', () => {
        expect(buildCosmeticFilter('www.example.com', '.ad')).toBe('example.com##.ad');
    });
});
