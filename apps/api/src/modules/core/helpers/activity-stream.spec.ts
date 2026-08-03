import { ActivityStream, CompressedActivityStream } from '@openathlete/shared';

import {
  compressActivityStream,
  reductActivityStreamToResolution,
  uncompressActivityStream,
} from './activity-stream';

// Pins the run-length/increment compression used to store activity telemetry.
// Round-trip identity is the correctness contract: uncompress(compress(x)) must
// return the original samples, or stored activities decode to the wrong data.

describe('activity-stream compression', () => {
  describe('round-trip identity', () => {
    it('preserves a mixed stream of runs, increments and one-offs', () => {
      const stream: ActivityStream = {
        // long identical run -> object form
        heartrate: [150, 150, 150, 150, 150, 150],
        // long +1 increment run -> object form
        time: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        // short run + short increment + irregular values (all inline)
        cadence: [88, 88, 10, 11, 12, 42, 7],
        // decreasing / arbitrary values, never a run or increment
        altitude: [500, 480, 512, 300, 950],
        // coordinate pairs (number[]) with a repeated fix
        latlng: [
          [45.1, 6.1],
          [45.1, 6.1],
          [45.1, 6.1],
          [45.1, 6.1],
          [45.2, 6.2],
        ],
      };

      const restored = uncompressActivityStream(compressActivityStream(stream));

      expect(restored).toEqual(stream);
    });

    it('preserves values of zero (guards the `previous || 0` fallback)', () => {
      const stream: ActivityStream = {
        watts: [0, 0, 0, 0, 0, 120, 0, 0],
      };

      const restored = uncompressActivityStream(compressActivityStream(stream));

      expect(restored).toEqual(stream);
    });
  });

  describe('encoding shape', () => {
    it('collapses runs longer than the inline threshold into { r, v }', () => {
      const compressed = compressActivityStream({
        heartrate: [140, 140, 140, 140, 140],
      });

      expect(compressed.heartrate).toEqual([{ r: 5, v: 140 }]);
    });

    it('keeps short runs (<= threshold) inline', () => {
      const compressed = compressActivityStream({
        heartrate: [140, 140, 140],
      });

      expect(compressed.heartrate).toEqual([140, 140, 140]);
    });

    it('collapses +1 increment runs longer than the threshold into { s, i }', () => {
      const compressed = compressActivityStream({
        time: [10, 11, 12, 13, 14, 15],
      });

      expect(compressed.time).toEqual([{ s: 10, i: 6 }]);
    });

    it('collapses repeated coordinate pairs into { r, v } with the array value', () => {
      const compressed = compressActivityStream({
        latlng: [
          [1.5, 2.5],
          [1.5, 2.5],
          [1.5, 2.5],
          [1.5, 2.5],
        ],
      });

      expect(compressed.latlng).toEqual([{ r: 4, v: [1.5, 2.5] }]);
    });

    it('omits empty or absent fields', () => {
      const compressed: CompressedActivityStream = compressActivityStream({
        heartrate: [120, 121, 122],
        watts: [],
      });

      expect(compressed).not.toHaveProperty('watts');
      expect(compressed).not.toHaveProperty('altitude');
      expect(Object.keys(compressed)).toEqual(['heartrate']);
    });
  });
});

describe('reductActivityStreamToResolution', () => {
  it('returns the stream unchanged when the resolution is not smaller than the length', () => {
    const stream = [1, 2, 3, 4];

    expect(reductActivityStreamToResolution(stream, 4)).toBe(stream);
    expect(reductActivityStreamToResolution(stream, 10)).toBe(stream);
  });

  it('downsamples to approximately the requested resolution', () => {
    const stream = Array.from({ length: 100 }, (_, i) => i);

    const reduced = reductActivityStreamToResolution(stream, 10);

    expect(reduced).toHaveLength(10);
    // first sample is always kept; samples are evenly spaced
    expect(reduced[0]).toBe(0);
    expect(reduced[1]).toBe(10);
  });
});
