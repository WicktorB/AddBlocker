import { describe, expect, it } from 'vitest';
import { findOwner, objectPrune } from '../src/object-prune.js';

const playerResponse = () => ({
    videoDetails: { videoId: 'abc' },
    adPlacements: [{ adPlacementRenderer: {} }],
    playerAds: [{}],
    adSlots: [{}],
});

describe('objectPrune', () => {
    it('removes the listed properties and reports the object as changed', () => {
        const obj = playerResponse();
        expect(objectPrune(obj, 'adPlacements adSlots playerAds')).toBe(obj);
        expect(obj).toEqual({ videoDetails: { videoId: 'abc' } });
    });

    it('reports nothing when no path was there to remove', () => {
        const obj = { videoDetails: {} };
        expect(objectPrune(obj, 'adPlacements adSlots')).toBeUndefined();
        expect(obj).toEqual({ videoDetails: {} });
    });

    it('follows dotted paths', () => {
        const obj = { playerResponse: playerResponse() };
        objectPrune(obj, 'playerResponse.adPlacements playerResponse.adSlots playerResponse.playerAds');
        expect(obj.playerResponse).toEqual({ videoDetails: { videoId: 'abc' } });
    });

    it('reaches into every element of an array with []', () => {
        const obj = [{ playerResponse: playerResponse() }, { playerResponse: playerResponse() }];
        objectPrune(obj, '[].playerResponse.adPlacements [].playerResponse.adSlots');
        expect(obj[0].playerResponse.adPlacements).toBeUndefined();
        expect(obj[1].playerResponse.adSlots).toBeUndefined();
        expect(obj[1].playerResponse.playerAds).toBeDefined();
    });

    it('removes the array elements matching the rest of the path with [-]', () => {
        const isAd = { command: { reelWatchEndpoint: { adClientParams: { isAd: true } } } };
        const video = { command: { reelWatchEndpoint: { videoId: 'v' } } };
        const obj = { entries: [video, isAd, video, isAd] };
        expect(objectPrune(obj, 'entries.[-].command.reelWatchEndpoint.adClientParams.isAd')).toBe(obj);
        expect(obj.entries).toEqual([video, video]);
    });

    it('removes matching properties with {-} and all of them with a final *', () => {
        const obj = { slots: { a: { ad: 1 }, b: { keep: 1 } }, bag: { x: 1, y: 2 } };
        objectPrune(obj, 'slots.{-}.ad bag.*');
        expect(obj).toEqual({ slots: { b: { keep: 1 } }, bag: {} });
    });

    it('prunes only when every needle path exists', () => {
        const without = playerResponse();
        expect(objectPrune(without, 'adPlacements', 'streamingData')).toBeUndefined();
        expect(without.adPlacements).toBeDefined();

        const withNeedle = { ...playerResponse(), streamingData: {} };
        expect(objectPrune(withNeedle, 'adPlacements', 'streamingData videoDetails.videoId')).toBe(withNeedle);
    });

    it('leaves non-objects alone', () => {
        expect(objectPrune('text', 'a')).toBeUndefined();
        expect(objectPrune(null, 'a')).toBeUndefined();
        expect(findOwner(42, 'a')).toBe(false);
    });

    it('does not follow inherited properties', () => {
        expect(objectPrune({}, 'constructor.name')).toBeUndefined();
        expect(objectPrune({}, 'toString')).toBeUndefined();
    });
});
