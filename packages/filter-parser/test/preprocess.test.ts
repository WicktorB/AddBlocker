import { describe, expect, it } from 'vitest';

import { EXTENSION_ENV, USERSCRIPT_ENV, evaluateDirective, preprocess } from '../src/preprocess.js';

describe('evaluateDirective', () => {
    const env = new Set(['env_chromium', 'env_mv3']);

    it('reads a bare token against the environment', () => {
        expect(evaluateDirective('env_chromium', env)).toBe(true);
        expect(evaluateDirective('env_firefox', env)).toBe(false);
    });

    it('treats a token it has never heard of as false', () => {
        expect(evaluateDirective('cap_something_new', env)).toBe(false);
        expect(evaluateDirective('!cap_something_new', env)).toBe(true);
    });

    it('handles negation, conjunction, disjunction and parentheses', () => {
        expect(evaluateDirective('!env_firefox', env)).toBe(true);
        expect(evaluateDirective('env_chromium && env_mv3', env)).toBe(true);
        expect(evaluateDirective('env_chromium && env_firefox', env)).toBe(false);
        expect(evaluateDirective('env_firefox || env_mv3', env)).toBe(true);
        expect(evaluateDirective('!(env_firefox || env_mobile) && env_mv3', env)).toBe(true);
    });

    it('reports an expression it cannot parse', () => {
        expect(evaluateDirective('', env)).toBeNull();
        expect(evaluateDirective('env_chromium &&', env)).toBeNull();
        expect(evaluateDirective('(env_chromium', env)).toBeNull();
    });
});

describe('preprocess', () => {
    const list = [
        '||always.example^',
        '!#if env_firefox',
        '||firefox-only.example^',
        '!#else',
        '||not-firefox.example^',
        '!#endif',
        '!#if env_mobile',
        'm.example.com##.mobile-ad',
        '!#endif',
        '||tail.example^',
    ].join('\n');

    it('keeps only the branch that holds', () => {
        const { text, blocks, droppedLines } = preprocess(list, EXTENSION_ENV);
        expect(text).toContain('||always.example^');
        expect(text).toContain('||not-firefox.example^');
        expect(text).toContain('||tail.example^');
        expect(text).not.toContain('firefox-only');
        expect(text).not.toContain('mobile-ad');
        expect(blocks).toBe(2);
        expect(droppedLines).toBe(2);
    });

    it('gives the userscript the mobile branch', () => {
        const { text } = preprocess(list, USERSCRIPT_ENV);
        expect(text).toContain('m.example.com##.mobile-ad');
        expect(text).not.toContain('firefox-only');
    });

    it('preserves line numbers', () => {
        const { text } = preprocess(list, EXTENSION_ENV);
        expect(text.split('\n')).toHaveLength(list.split('\n').length);
        expect(text.split('\n')[9]).toBe('||tail.example^');
    });

    it('drops everything nested inside a dead block', () => {
        const nested = [
            '!#if env_firefox',
            '!#if env_chromium',
            '||inner.example^',
            '!#endif',
            '!#endif',
            '||after.example^',
        ].join('\n');
        const { text } = preprocess(nested, EXTENSION_ENV);
        expect(text).not.toContain('inner.example');
        expect(text).toContain('||after.example^');
    });

    it('drops a block whose condition cannot be parsed', () => {
        const { text, malformed } = preprocess('!#if env_chromium &&\n||x.example^\n!#endif', EXTENSION_ENV);
        expect(text).not.toContain('x.example');
        expect(malformed).toBe(1);
    });

    it('leaves other directives and comments alone', () => {
        const { text } = preprocess('!#include other.txt\n! comment\n||x.example^', EXTENSION_ENV);
        expect(text).toBe('!#include other.txt\n! comment\n||x.example^');
    });
});
