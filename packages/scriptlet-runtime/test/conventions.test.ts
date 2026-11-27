import { describe, expect, it } from 'vitest';
import { initPattern, parseVarargs, patternToRegex, testPattern } from '../src/safe.js';
import { collateFetchArguments, matchObjectProperties, parsePropertiesToMatch } from '../src/props.js';

describe('needle patterns', () => {
    it('matches anything when empty', () => {
        expect(testPattern(initPattern(''), 'whatever')).toBe(true);
    });

    it('matches a substring, or a regex literal', () => {
        expect(testPattern(initPattern('/player'), 'https://x/youtubei/v1/player?key=1')).toBe(true);
        expect(testPattern(initPattern('/\\/player(\\?|$)/'), 'https://x/youtubei/v1/player')).toBe(true);
        expect(testPattern(initPattern('/\\/player(\\?|$)/'), 'https://x/youtubei/v1/playerz')).toBe(false);
    });

    it('negates on a leading bang only where the scriptlet allows it', () => {
        expect(testPattern(initPattern('!ads', { canNegate: true }), 'clean')).toBe(true);
        expect(testPattern(initPattern('!ads', { canNegate: true }), 'ads')).toBe(false);
        expect(testPattern(initPattern('!ads'), 'say !ads')).toBe(true);
    });
});

describe('patternToRegex', () => {
    it('escapes a plain string, so `player?` means those seven characters', () => {
        const re = patternToRegex('player?');
        expect(re.test('/youtubei/v1/player?prettyPrint=false')).toBe(true);
        expect(re.test('/youtubei/v1/playe')).toBe(false);
    });

    it('anchors a plain string when asked for a verbatim match', () => {
        const re = patternToRegex('script', 'i', true);
        expect(re.test('SCRIPT')).toBe(true);
        expect(re.test('NOSCRIPT')).toBe(false);
    });

    it('takes a regex literal with its own flags, and adds none', () => {
        const re = patternToRegex('/"adPlacements.*?("adSlots"|"adBreakHeartbeatParams")/gms', 'i');
        expect(re.flags).toBe('gms');
        expect(patternToRegex('/abc/', 'gms').flags).toBe('');
    });

    it('falls back to a regex that changes nothing when the literal is invalid', () => {
        expect('abc'.replace(patternToRegex('/(/'), 'X')).toBe('Xabc');
    });
});

describe('parseVarargs', () => {
    it('pairs names with values and reads integers as numbers', () => {
        expect(parseVarargs(['propsToMatch', '/player', 'sedCount', '1']))
            .toEqual({ propsToMatch: '/player', sedCount: 1 });
    });
});

describe('propsToMatch', () => {
    it('matches a bare needle against the URL', () => {
        const needles = parsePropertiesToMatch('/get_watch', 'url');
        expect(matchObjectProperties(needles, { url: 'https://m.youtube.com/youtubei/v1/get_watch?x' }))
            .toBeDefined();
        expect(matchObjectProperties(needles, { url: 'https://m.youtube.com/youtubei/v1/next' }))
            .toBeUndefined();
    });

    it('reads `prop:needle` pairs, all of which must hold', () => {
        const needles = parsePropertiesToMatch('url:/reel_watch_sequence? method:POST', 'url');
        expect(matchObjectProperties(needles, { url: '/youtubei/v1/reel/reel_watch_sequence?a', method: 'POST' }))
            .toBeDefined();
        expect(matchObjectProperties(needles, { url: '/youtubei/v1/reel/reel_watch_sequence?a', method: 'GET' }))
            .toBeUndefined();
    });

    it('does not mistake a regex containing a colon for a `prop:needle` pair', () => {
        const needles = parsePropertiesToMatch('/\\/player(?:\\?.+)?$/', 'url');
        expect([...needles.keys()]).toEqual(['url']);
        expect(matchObjectProperties(needles, { url: 'https://www.youtube.com/youtubei/v1/player?key=1' }))
            .toBeDefined();
        expect(matchObjectProperties(needles, { url: 'https://www.youtube.com/youtubei/v1/next' }))
            .toBeUndefined();
    });

    it('skips a property the request does not have', () => {
        const needles = parsePropertiesToMatch('method:POST', 'url');
        expect(matchObjectProperties(needles, { url: '/x' })).toEqual([]);
    });
});

describe('collateFetchArguments', () => {
    it('reads a URL string, a Request, and lets the options override', () => {
        expect(collateFetchArguments('/a').url).toBe('/a');
        const collated = collateFetchArguments(new Request('https://example.com/b', { method: 'POST', body: 'x' }));
        expect(collated.url).toBe('https://example.com/b');
        expect(collated.method).toBe('POST');
        expect(collateFetchArguments('/c', { method: 'PUT' })).toMatchObject({ url: '/c', method: 'PUT' });
    });
});
