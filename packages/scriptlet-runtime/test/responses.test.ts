import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    jsonEditFetchResponse, jsonPruneFetchResponse, trustedReplaceFetchResponse,
} from '../src/responses.js';

/**
 * These run under Node, which has `fetch`, `Request` and `Response` but no
 * `XMLHttpRequest`: the fetch variants are exercised here, the XHR ones in a
 * real browser by `pnpm scriptlet-check`.
 */

const realFetch = globalThis.fetch;
let calls: string[];

function serve(routes: Record<string, () => Response | Promise<Response>>): void {
    calls = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        for (const [needle, respond] of Object.entries(routes)) {
            if (url.includes(needle)) return Promise.resolve().then(respond);
        }
        return Promise.reject(new TypeError('Failed to fetch'));
    }) as typeof fetch;
}

const json = (body: unknown, init?: ResponseInit): Response => new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'x-test': 'kept' }, ...init,
});

const player = () => ({
    videoDetails: { videoId: 'abc' },
    adPlacements: [{ adPlacementRenderer: { config: {} } }],
    adSlots: [{ adSlotRenderer: {} }],
    streamingData: { formats: [] },
});

beforeEach(() => {
    serve({
        '/youtubei/v1/player': () => json(player()),
        '/youtubei/v1/next': () => json({ adPlacements: ['untouched'] }),
        '/text': () => new Response('not json at all'),
        '/partial': () => json(player(), { status: 206, statusText: 'Partial' }),
    });
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('json-prune-fetch-response', () => {
    const install = () => jsonPruneFetchResponse(
        'adPlacements adSlots playerResponse.adPlacements playerResponse.adSlots',
        '', 'propsToMatch', '/\\/player(\\?|$)/',
    );

    it('removes the ad descriptors from the matching response', async () => {
        install();
        const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false');
        expect(await response.json()).toEqual({ videoDetails: { videoId: 'abc' }, streamingData: { formats: [] } });
    });

    it('keeps the status and headers of the original', async () => {
        jsonPruneFetchResponse('adPlacements adSlots');
        const response = await fetch('https://www.youtube.com/partial');
        expect(response.status).toBe(206);
        expect(response.statusText).toBe('Partial');
        expect(response.ok).toBe(true);
        expect(response.headers.get('x-test')).toBe('kept');
        expect(response.headers.get('content-type')).toContain('application/json');
    });

    it('leaves a request that does not match alone, and hands back the very same response', async () => {
        install();
        const response = await fetch('https://www.youtube.com/youtubei/v1/next');
        expect(await response.json()).toEqual({ adPlacements: ['untouched'] });
    });

    it('matches a Request object as well as a URL string', async () => {
        install();
        const response = await fetch(new Request('https://www.youtube.com/youtubei/v1/player', {
            method: 'POST', body: '{}',
        }));
        expect((await response.json() as Record<string, unknown>).adPlacements).toBeUndefined();
    });

    it('passes a body that is not JSON through, still readable', async () => {
        jsonPruneFetchResponse('adPlacements');
        const response = await fetch('https://example.com/text');
        expect(await response.text()).toBe('not json at all');
    });

    it('lets a failed request fail with its own error', async () => {
        jsonPruneFetchResponse('adPlacements');
        await expect(fetch('https://example.com/unreachable')).rejects.toThrow('Failed to fetch');
    });

    it('makes exactly one network request per call', async () => {
        install();
        await fetch('https://www.youtube.com/youtubei/v1/player');
        expect(calls).toHaveLength(1);
    });
});

describe('trusted-replace-fetch-response', () => {
    it('renames the key so the player no longer finds it', async () => {
        trustedReplaceFetchResponse('"adPlacements"', '"no_ads"', 'player?');
        const response = await fetch('https://www.youtube.com/youtubei/v1/player?key=1');
        const body = await response.json() as Record<string, unknown>;
        expect(body.adPlacements).toBeUndefined();
        expect(body.no_ads).toBeDefined();
        expect(body.adSlots).toBeDefined();
    });

    it('stacks: two rewrites of the same response both apply', async () => {
        trustedReplaceFetchResponse('"adPlacements"', '"no_ads"', 'player?');
        trustedReplaceFetchResponse('"adSlots"', '"no_ads"', 'player?');
        const response = await fetch('https://www.youtube.com/youtubei/v1/player?key=1');
        const text = await response.text();
        expect(text).not.toContain('"adPlacements"');
        expect(text).not.toContain('"adSlots"');
    });

    it('does not touch a URL the needle does not match', async () => {
        trustedReplaceFetchResponse('"adPlacements"', '"no_ads"', 'player?');
        const response = await fetch('https://www.youtube.com/youtubei/v1/next');
        expect(await response.text()).toContain('"adPlacements"');
    });
});

describe('json-edit-fetch-response', () => {
    it('removes what the query selects', async () => {
        serve({
            '/get_watch': () => json([{
                itemSectionRenderer: { contents: [{ adSlotRenderer: {} }, { videoWithContextRenderer: {} }] },
            }]),
        });
        jsonEditFetchResponse('..itemSectionRenderer.contents.*[?.adSlotRenderer]', 'propsToMatch', '/get_watch');
        const response = await fetch('https://m.youtube.com/youtubei/v1/get_watch?x=1');
        expect(await response.json()).toEqual([
            { itemSectionRenderer: { contents: [{ videoWithContextRenderer: {} }] } },
        ]);
    });

    it('refuses a query that assigns a value: that takes the trusted variant', async () => {
        const before = globalThis.fetch;
        jsonEditFetchResponse('.videoDetails.videoId="x"');
        expect(globalThis.fetch).toBe(before);
    });

    it('still reads as the native function to the page', () => {
        const native = Function.prototype.toString.call(globalThis.fetch);
        jsonEditFetchResponse('.adPlacements');
        expect(Function.prototype.toString.call(globalThis.fetch)).toBe(native);
        expect(`${globalThis.fetch}`).toBe(native);
    });
});
