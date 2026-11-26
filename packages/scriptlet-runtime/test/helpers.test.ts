import { describe, expect, it } from 'vitest';
import { matcher, resolveValue } from '../src/helpers.js';
import { CATALOG, lookup, requiresTrust, worldOf } from '../src/catalog.js';

describe('matcher', () => {
    it('matches a plain substring', () => {
        expect(matcher('ads')('an ads url')).toBe(true);
        expect(matcher('ads')('clean url')).toBe(false);
    });

    it('matches a regex literal', () => {
        expect(matcher('/^ab+c$/')('abbc')).toBe(true);
        expect(matcher('/^ab+c$/')('ac')).toBe(false);
    });

    it('treats an empty pattern as match-anything', () => {
        expect(matcher('')('whatever')).toBe(true);
        expect(matcher(undefined)('whatever')).toBe(true);
    });

    it('negates with a leading bang', () => {
        expect(matcher('!ads')('clean')).toBe(true);
        expect(matcher('!ads')('ads')).toBe(false);
    });

    it('does not throw on an invalid regex', () => {
        expect(() => matcher('/[/')('x')).not.toThrow();
    });
});

describe('resolveValue', () => {
    it.each([
        ['true', true],
        ['false', false],
        ['null', null],
        ['undefined', undefined],
        ['42', 42],
        ['1.5', 1.5],
        ['hello', 'hello'],
    ])('resolves %j', (raw, expected) => {
        expect(resolveValue(raw)).toBe(expected);
    });

    it('resolves function keywords to callables', () => {
        expect(typeof resolveValue('noopFunc')).toBe('function');
        expect((resolveValue('trueFunc') as () => boolean)()).toBe(true);
        expect((resolveValue('falseFunc') as () => boolean)()).toBe(false);
    });

    it('resolves empty container keywords', () => {
        expect(resolveValue('emptyObj')).toEqual({});
        expect(resolveValue('emptyArr')).toEqual([]);
    });
});

describe('catalogue', () => {
    it('covers the scriptlets the lists invoke most', () => {
        // These account for the bulk of the 7 131 invocations upstream.
        for (const name of ['aopr', 'aopw', 'acs', 'set', 'aeld', 'nostif', 'nosiif',
            'ra', 'nowoif', 'trusted-set-cookie', 'rmnt', 'nowebrtc', 'json-prune']) {
            expect(lookup(name), `missing: ${name}`).toBeTypeOf('function');
        }
    });

    // By count these are a rounding error; by effect they are the whole of
    // what removes video ads on YouTube. They were once all missing while
    // the build reported 99.5 % coverage.
    it('covers every scriptlet the YouTube filters use', () => {
        for (const name of ['json-prune', 'json-prune-fetch-response', 'json-prune-xhr-response',
            'trusted-replace-fetch-response', 'trusted-rpfr', 'trusted-replace-xhr-response',
            'trusted-edit-inbound-object', 'trusted-prevent-dom-bypass', 'rpnt', 'trusted-rpnt', 'rmnt',
            'json-edit-fetch-response', 'set', 'trusted-set', 'nano-stb', 'aeld', 'trusted-click-element']) {
            expect(lookup(name), `missing: ${name}`).toBeTypeOf('function');
        }
    });

    it('does not mistake an inherited property for a scriptlet', () => {
        expect(lookup('constructor')).toBeUndefined();
        expect(lookup('toString')).toBeUndefined();
    });

    it('knows which scriptlets only a trusted list may use', () => {
        expect(requiresTrust('trusted-replace-fetch-response')).toBe(true);
        expect(requiresTrust('trusted-set-cookie')).toBe(true);
        // An alias of a trusted scriptlet is no less trusted for its short name.
        expect(requiresTrust('rpnt')).toBe(true);
        expect(requiresTrust('replace-node-text')).toBe(true);
        expect(requiresTrust('json-prune')).toBe(false);
        expect(requiresTrust('rmnt')).toBe(false);
    });

    it('runs the DOM-only scriptlets in the isolated world and the rest in the page\'s', () => {
        expect(worldOf('rmnt')).toBe('ISOLATED');
        expect(worldOf('rpnt')).toBe('ISOLATED');
        expect(worldOf('json-prune')).toBe('MAIN');
        expect(worldOf('set')).toBe('MAIN');
    });

    it('returns undefined for an unknown name rather than throwing', () => {
        expect(lookup('no-such-scriptlet')).toBeUndefined();
    });

    it('exposes every catalogue entry as a function', () => {
        for (const [name, fn] of Object.entries(CATALOG)) {
            expect(fn, name).toBeTypeOf('function');
        }
    });
});
