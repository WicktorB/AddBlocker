import { describe, expect, it } from 'vitest';
import { parseProcedural } from '../src/procedural.js';

describe('parseProcedural', () => {
    it('splits a prefix from its steps', () => {
        const parsed = parseProcedural('.item:has-text(Sponsored)');
        expect(parsed?.prefix).toBe('.item');
        expect(parsed?.steps).toEqual([{ name: 'has-text', arg: 'Sponsored' }]);
    });

    it('chains multiple steps in order', () => {
        const parsed = parseProcedural('.a:has-text(Ad):upward(2)');
        expect(parsed?.steps.map((s) => s.name)).toEqual(['has-text', 'upward']);
    });

    it('flags :remove() rather than treating it as a filter step', () => {
        const parsed = parseProcedural('.a:remove()');
        expect(parsed?.remove).toBe(true);
        expect(parsed?.steps).toEqual([]);
    });

    it('handles nested parentheses in an argument', () => {
        const parsed = parseProcedural('.a:has-text(foo (bar))');
        expect(parsed?.steps[0].arg).toBe('foo (bar)');
    });

    it('defaults the prefix to * when the selector starts with a pseudo', () => {
        expect(parseProcedural(':has-text(Ad)')?.prefix).toBe('*');
    });

    it('returns null for a plain CSS selector', () => {
        expect(parseProcedural('.plain')).toBeNull();
        // :has() is native CSS and must never reach the JS engine.
        expect(parseProcedural('.a:has(.b)')).toBeNull();
    });

    it('returns null on unbalanced parentheses', () => {
        expect(parseProcedural('.a:has-text(oops')).toBeNull();
    });
});
