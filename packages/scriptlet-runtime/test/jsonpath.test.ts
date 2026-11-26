import { describe, expect, it } from 'vitest';
import { JSONPath } from '../src/jsonpath.js';

const apply = (query: string, obj: unknown): unknown => JSONPath.create(query).apply(obj);

describe('JSONPath selection', () => {
    it('removes what a plain query selects', () => {
        expect(apply('.a.b', { a: { b: 1, c: 2 } })).toEqual({ a: { c: 2 } });
    });

    it('reports nothing selected as undefined', () => {
        expect(apply('.a.b', { a: {} })).toBeUndefined();
    });

    it('descends with ..', () => {
        expect(apply('..ad', { x: { ad: 1, y: [{ ad: 2, keep: 3 }] } })).toEqual({ x: { y: [{ keep: 3 }] } });
    });

    it('removes array elements by filter, splicing rather than leaving holes', () => {
        const obj = { items: [{ ad: {} }, { video: 1 }, { ad: {} }, { video: 2 }] };
        expect(apply('.items[?.ad]', obj)).toEqual({ items: [{ video: 1 }, { video: 2 }] });
    });

    it('handles the mobile watch-page ad slots', () => {
        const obj = {
            a: { itemSectionRenderer: { contents: [{ adSlotRenderer: {} }, { videoWithContextRenderer: {} }] } },
        };
        expect(apply('..itemSectionRenderer.contents.*[?.adSlotRenderer]', obj)).toEqual({
            a: { itemSectionRenderer: { contents: [{ videoWithContextRenderer: {} }] } },
        });
    });

    it('supports the comparison operators', () => {
        const list = () => ({ l: [{ n: 1, s: 'abcd' }, { n: 2, s: 'bcde' }, { n: 3, s: 'cdef' }] });
        const left = (q: string) => (apply(q, list()) as { l: Array<{ n: number }> }).l.map((e) => e.n);
        expect(left('.l[?.n==2]')).toEqual([1, 3]);
        expect(left('.l[?.n!=2]')).toEqual([2]);
        expect(left('.l[?.n<2]')).toEqual([2, 3]);
        expect(left('.l[?.n>=2]')).toEqual([1]);
        expect(left('.l[?.s^="ab"]')).toEqual([2, 3]);
        expect(left('.l[?.s$="ef"]')).toEqual([1, 2]);
        expect(left('.l[?.s*="cd"]')).toEqual([]);
        expect(left('.l[?.s=/^b/]')).toEqual([1, 3]);
    });

    it('rejects a malformed query instead of guessing', () => {
        for (const query of ['', '.a[', '.a..', '.a=notjson', '.a=']) {
            expect(JSONPath.create(query).valid, query).toBe(false);
        }
    });
});

describe('JSONPath assignment', () => {
    it('sets a value', () => {
        expect(apply('.a.b=false', { a: { b: true } })).toEqual({ a: { b: false } });
        expect(JSONPath.create('.a.b=false').value).toBe(false);
        expect(JSONPath.create('.a.b').value).toBeUndefined();
    });

    it('merges into an object and appends to an array with +=', () => {
        expect(apply('.a+={"y":2}', { a: { x: 1 } })).toEqual({ a: { x: 1, y: 2 } });
        expect(apply('.l+=[3,4]', { l: [1, 2] })).toEqual({ l: [1, 2, 3, 4] });
    });

    it('rewrites a string with repl()', () => {
        expect(apply('.ua=repl({"regex":"; (adunit|channel)\\\\b","replacement":""})', { ua: 'Mozilla; channel' }))
            .toEqual({ ua: 'Mozilla' });
    });

    // The queries below are the ones the lists carry for the watch page: the
    // player request is recognised by a marker in its user agent, then edited.
    it('applies a chain of root filters before the edit', () => {
        const query = '[?.attestationRequest][?.context.client.userAgent*="channel"]'
            + '.context.client[?.clientName=="WEB"]+={"clientScreen":"CHANNEL"}';
        const request = () => ({
            attestationRequest: {},
            context: { client: { userAgent: 'Mozilla; channel', clientName: 'WEB' } },
        });
        expect(apply(query, request())).toEqual({
            attestationRequest: {},
            context: { client: { userAgent: 'Mozilla; channel', clientName: 'WEB', clientScreen: 'CHANNEL' } },
        });

        const other = request();
        other.context.client.userAgent = 'Mozilla';
        expect(apply(query, other)).toBeUndefined();

        const embedded = request();
        embedded.context.client.clientName = 'WEB_EMBEDDED_PLAYER';
        expect(apply(query, embedded)).toBeUndefined();
    });

    it('merges into the root when the filters select it', () => {
        const query = '[?.attestationRequest][?.context.client.userAgent*="yahi"]+={"params":"YAHI"}';
        expect(apply(query, { attestationRequest: {}, context: { client: { userAgent: 'x yahi' } } }))
            .toMatchObject({ params: 'YAHI' });
        expect(apply(query, { context: { client: { userAgent: 'x yahi' } } })).toBeUndefined();
    });

    it('matches a filter by regex, then rewrites a nested string', () => {
        const query = '[?.attestationRequest][?.context.client.userAgent=/adunit|channel|inline/]'
            + '.playbackContext.contentPlaybackContext.referer'
            + '=repl({"regex":"(?:#reloadxhr)?$","replacement":"#reloadxhr"})';
        const request = {
            attestationRequest: {},
            context: { client: { userAgent: 'Mozilla; inline' } },
            playbackContext: { contentPlaybackContext: { referer: 'https://www.youtube.com/watch?v=1' } },
        };
        const edited = apply(query, request) as typeof request;
        expect(edited.playbackContext.contentPlaybackContext.referer)
            .toBe('https://www.youtube.com/watch?v=1#reloadxhr');
        // Applied twice, the marker is not doubled.
        expect((apply(query, edited) as typeof request).playbackContext.contentPlaybackContext.referer)
            .toBe('https://www.youtube.com/watch?v=1#reloadxhr');
    });
});
