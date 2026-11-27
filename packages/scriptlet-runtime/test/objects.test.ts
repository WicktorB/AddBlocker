import { afterEach, describe, expect, it } from 'vitest';
import { jsonEdit, jsonPrune, trustedEditInboundObject, trustedJsonEdit } from '../src/objects.js';

const realParse = JSON.parse;
const realStringify = JSON.stringify;
const realToString = Function.prototype.toString;

afterEach(() => {
    JSON.parse = realParse;
    JSON.stringify = realStringify;
});

describe('json-prune', () => {
    it('prunes what JSON.parse returns', () => {
        jsonPrune('playerResponse.adPlacements adPlacements');
        expect(JSON.parse('{"adPlacements":[1],"playerResponse":{"adPlacements":[2],"v":1}}'))
            .toEqual({ playerResponse: { v: 1 } });
    });

    it('returns what does not match exactly as parsed', () => {
        jsonPrune('adPlacements');
        expect(JSON.parse('{"a":[1,{"b":null}]}')).toEqual({ a: [1, { b: null }] });
        expect(JSON.parse('"text"')).toBe('text');
        expect(JSON.parse('null')).toBeNull();
    });

    it('passes the reviver through', () => {
        jsonPrune('adPlacements');
        expect(JSON.parse('{"n":1}', (_k, v) => (typeof v === 'number' ? v + 1 : v))).toEqual({ n: 2 });
    });

    it('lets invalid JSON throw as it always did', () => {
        jsonPrune('adPlacements');
        expect(() => JSON.parse('{nope')).toThrow(SyntaxError);
    });

    it('prunes only when the needle paths are present', () => {
        jsonPrune('adPlacements', 'streamingData');
        expect(JSON.parse('{"adPlacements":[1]}')).toEqual({ adPlacements: [1] });
        expect(JSON.parse('{"adPlacements":[1],"streamingData":{}}')).toEqual({ streamingData: {} });
    });

    it('still reads as the native function to the page', () => {
        const native = realToString.call(realParse);
        jsonPrune('adPlacements');
        expect(JSON.parse).not.toBe(realParse);
        expect(JSON.parse.toString()).toBe(native);
        expect(Function.prototype.toString.toString()).toBe(realToString.call(realToString));
    });
});

describe('json-edit', () => {
    it('removes what the query selects from parsed JSON', () => {
        jsonEdit('..nodes.*[?.sponsored_data]');
        expect(JSON.parse('{"nodes":[{"sponsored_data":{}},{"story":1}]}')).toEqual({ nodes: [{ story: 1 }] });
    });

    it('only looks at the texts its `matches` argument selects', () => {
        jsonEdit('.ad', 'matches', '/^.{20,}/');
        expect(JSON.parse('{"ad":1}')).toEqual({ ad: 1 });
        expect(JSON.parse('{"ad":1,"padding":"............"}')).toEqual({ padding: '............' });
    });

    it('needs the trusted variant to assign', () => {
        jsonEdit('.a=1');
        expect(JSON.parse).toBe(realParse);
        trustedJsonEdit('.a=1');
        expect(JSON.parse('{"a":0}')).toEqual({ a: 1 });
    });
});

describe('trusted-edit-inbound-object', () => {
    const query = '[?.attestationRequest][?.context.client.userAgent*="inline"]'
        + '.playbackContext.contentPlaybackContext+={"isInlinePlaybackNoAd":true}';

    it('edits the argument of the call, as serialised', () => {
        trustedEditInboundObject('JSON.stringify', '0', query);
        const request = {
            attestationRequest: {},
            context: { client: { userAgent: 'Mozilla; inline' } },
            playbackContext: { contentPlaybackContext: { referer: 'r' } },
        };
        expect(JSON.parse(JSON.stringify(request))).toEqual({
            attestationRequest: {},
            context: { client: { userAgent: 'Mozilla; inline' } },
            playbackContext: { contentPlaybackContext: { referer: 'r', isInlinePlaybackNoAd: true } },
        });
        // The caller's own object is not the one that was edited.
        expect(request.playbackContext.contentPlaybackContext).toEqual({ referer: 'r' });
    });

    it('leaves every other call exactly as it was', () => {
        trustedEditInboundObject('JSON.stringify', '0', query);
        expect(JSON.stringify({ a: [1, 'x', null] })).toBe('{"a":[1,"x",null]}');
        expect(JSON.stringify('s')).toBe('"s"');
        expect(JSON.stringify(undefined)).toBeUndefined();
        expect(JSON.stringify({ a: 1 }, null, 2)).toBe('{\n  "a": 1\n}');
        // A value that cannot be cloned is passed through, not dropped.
        expect(JSON.stringify({ f() { /* */ }, a: 1 })).toBe('{"a":1}');
    });

    it('counts a negative position from the end', () => {
        const seen: unknown[] = [];
        (globalThis as Record<string, unknown>).__probe = (...args: unknown[]) => { seen.push(...args); };
        trustedEditInboundObject('__probe', '-1', '.x=2');
        (globalThis as unknown as { __probe: (...a: unknown[]) => void }).__probe({ x: 1 }, { x: 1 });
        expect(seen).toEqual([{ x: 1 }, { x: 2 }]);
        delete (globalThis as Record<string, unknown>).__probe;
    });
});
