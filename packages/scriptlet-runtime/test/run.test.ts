import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const realParse = JSON.parse;
const realLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

function at(hostname: string): void {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname } });
}

afterEach(() => {
    JSON.parse = realParse;
    if (realLocation) Object.defineProperty(globalThis, 'location', realLocation);
    else delete (globalThis as Record<string, unknown>).location;
});

describe('run', () => {
    it('skips an invocation on the hosts it is excluded from, subdomains included', () => {
        at('shop.example.com');
        run([['~shop.example.com|other.example.com', 'json-prune', 'excludedHere']]);
        expect(JSON.parse).toBe(realParse);

        at('eu.shop.example.com');
        run([['~shop.example.com', 'json-prune', 'excludedHereToo']]);
        expect(JSON.parse).toBe(realParse);

        // `notshop.example.com` merely ends with the same letters.
        at('notshop.example.com');
        run([['~shop.example.com', 'json-prune', 'appliedThere']]);
        expect(JSON.parse('{"appliedThere":1,"kept":2}')).toEqual({ kept: 2 });
    });

    it('runs an invocation once, however many buckets carry it', () => {
        at('www.example.com');
        run([['json-prune', 'onceOnly']]);
        const wrapped = JSON.parse;
        expect(wrapped).not.toBe(realParse);
        run([['json-prune', 'onceOnly'], ['json-prune', 'onceOnly']]);
        expect(JSON.parse).toBe(wrapped);
    });

    it('carries on after an unknown or failing scriptlet', () => {
        at('www.example.com');
        run([['no-such-scriptlet'], ['json-prune', 'afterUnknown']]);
        expect(JSON.parse('{"afterUnknown":1}')).toEqual({});
    });
});
