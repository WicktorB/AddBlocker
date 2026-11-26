import { describe, expect, it } from 'vitest';

import { buildStamp, versionFor } from '../version.js';

describe('versionFor', () => {
    it('writes the build time as YYYY.MMDD.HHmm, in UTC', () => {
        expect(versionFor(new Date('2026-11-26T13:37:09Z'))).toBe('2026.1126.1337');
    });

    it('drops leading zeros so each part is a plain integer', () => {
        // Chrome rejects a manifest version with a part like "0105".
        expect(versionFor(new Date('2027-01-05T00:07:00Z'))).toBe('2027.105.7');
        expect(versionFor(new Date('2027-01-05T00:00:00Z'))).toBe('2027.105.0');
        expect(versionFor(new Date('2027-01-05T09:00:00Z'))).toBe('2027.105.900');
    });

    it('fits what a Chrome manifest version allows, at any time of day', () => {
        for (const iso of ['2099-12-31T23:59:00Z', '2027-01-01T00:00:00Z', '2027-01-01T00:05:00Z', '2027-10-10T10:10:00Z']) {
            const parts = versionFor(new Date(iso)).split('.');
            expect(parts.length).toBeLessThanOrEqual(4);
            for (const part of parts) {
                expect(part).toMatch(/^(0|[1-9]\d*)$/);
                expect(Number(part)).toBeLessThanOrEqual(65_535);
            }
        }
    });

    it('grows with time, so a later build always compares as newer', () => {
        const order = ['2026-11-26T00:05:00Z', '2026-11-26T13:37:00Z', '2026-11-26T14:02:00Z', '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z']
            .map((iso) => versionFor(new Date(iso)).split('.').map(Number));
        for (let i = 1; i < order.length; i += 1) {
            const [a, b] = [order[i - 1], order[i]];
            const firstDiff = a.findIndex((part, index) => part !== b[index]);
            expect(b[firstDiff]).toBeGreaterThan(a[firstDiff]);
        }
    });
});

describe('buildStamp', () => {
    it('records the time it was given and never throws outside a git checkout', () => {
        const stamp = buildStamp('/', new Date('2026-11-26T13:37:09Z'));
        expect(stamp.version).toBe('2026.1126.1337');
        expect(stamp.builtAt).toBe('2026-11-26T13:37:09.000Z');
        expect(stamp.commit).toBe('');
        expect(stamp.dirty).toBe(false);
    });
});
