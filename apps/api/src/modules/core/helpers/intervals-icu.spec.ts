import { SportType } from '@openathlete/database';

import {
  outdoorRideActivity,
  outdoorRideStreams,
  virtualRunActivity,
} from './__fixtures__/intervals-icu.fixtures';
import {
  mapIntervalsIcuSportType,
  mergeIntervalsIcuStreams,
  resolveIntervalsIcuAverageWatts,
  resolveIntervalsIcuKilojoules,
  resolveIntervalsIcuMaxWatts,
  resolveIntervalsIcuRpe,
  selectIntervalsIcuStreamTypes,
  toIntervalsIcuDate,
} from './intervals-icu';

describe('mapIntervalsIcuSportType', () => {
  it('maps the sport types actually seen in the account', () => {
    expect(mapIntervalsIcuSportType('Run')).toBe(SportType.RUNNING);
    expect(mapIntervalsIcuSportType('TrailRun')).toBe(SportType.TRAIL_RUNNING);
    expect(mapIntervalsIcuSportType('VirtualRun')).toBe(SportType.VIRTUAL_RUN);
    expect(mapIntervalsIcuSportType('Ride')).toBe(SportType.CYCLING);
    expect(mapIntervalsIcuSportType('VirtualRide')).toBe(
      SportType.VIRTUAL_RIDE,
    );
  });

  it('maps the types Intervals.icu has that Strava does not', () => {
    expect(mapIntervalsIcuSportType('TrackRide')).toBe(SportType.CYCLING);
    expect(mapIntervalsIcuSportType('Cyclocross')).toBe(SportType.CYCLING);
    expect(mapIntervalsIcuSportType('OpenWaterSwim')).toBe(SportType.SWIMMING);
    expect(mapIntervalsIcuSportType('VirtualSki')).toBe(SportType.ALPINE_SKI);
  });

  it('still delegates the shared Strava vocabulary', () => {
    expect(mapIntervalsIcuSportType('Hike')).toBe(SportType.HIKING);
    expect(mapIntervalsIcuSportType('GravelRide')).toBe(SportType.GRAVEL_RIDE);
    expect(mapIntervalsIcuSportType('AlpineSki')).toBe(SportType.ALPINE_SKI);
    expect(mapIntervalsIcuSportType('WeightTraining')).toBe(
      SportType.WEIGHT_TRAINING,
    );
  });

  it('falls back to OTHER for unknown, null and undefined types', () => {
    expect(mapIntervalsIcuSportType('Padel')).toBe(SportType.OTHER);
    expect(mapIntervalsIcuSportType('Other')).toBe(SportType.OTHER);
    expect(mapIntervalsIcuSportType('SomethingBrandNew')).toBe(SportType.OTHER);
    expect(mapIntervalsIcuSportType(null)).toBe(SportType.OTHER);
    expect(mapIntervalsIcuSportType(undefined)).toBe(SportType.OTHER);
  });
});

describe('selectIntervalsIcuStreamTypes', () => {
  it('only asks for streams the activity has and we can store', () => {
    expect(
      selectIntervalsIcuStreamTypes(outdoorRideActivity.stream_types),
    ).toEqual([
      'time',
      'watts',
      'cadence',
      'heartrate',
      'distance',
      'altitude',
      'latlng',
      'temp',
    ]);
  });

  it('drops streams with no home in ActivityStream', () => {
    const selected = selectIntervalsIcuStreamTypes([
      'time',
      'watts',
      'torque',
      'stance_time',
      'vertical_oscillation',
      'left_right_balance',
    ]);

    expect(selected).toEqual(['time', 'watts']);
  });

  it('always includes time so the other streams stay indexable', () => {
    expect(selectIntervalsIcuStreamTypes(['heartrate', 'cadence'])).toEqual([
      'time',
      'heartrate',
      'cadence',
    ]);
  });

  it('returns nothing when the activity advertises no usable streams', () => {
    expect(selectIntervalsIcuStreamTypes([])).toEqual([]);
    expect(selectIntervalsIcuStreamTypes(null)).toEqual([]);
    expect(selectIntervalsIcuStreamTypes(undefined)).toEqual([]);
    expect(selectIntervalsIcuStreamTypes(['torque'])).toEqual([]);
  });
});

describe('mergeIntervalsIcuStreams', () => {
  it('folds the Strava-shaped envelope into an ActivityStream', () => {
    const merged = mergeIntervalsIcuStreams(outdoorRideStreams);

    expect(merged.time).toEqual([0, 1, 2, 3]);
    expect(merged.watts).toEqual([0, 145, 210, 198]);
    expect(merged.heartrate).toEqual([92, 96, 103, 110]);
    expect(merged.cadence).toEqual([0, 62, 74, 78]);
    expect(merged.distance).toEqual([0, 3.1, 8.4, 14.9]);
    expect(merged.altitude).toEqual([12.2, 12.4, 12.8, 13.1]);
    expect(merged.temp).toEqual([18, 18, 19, 19]);
  });

  it('zips the latlng data/data2 split back into [lat, lng] pairs', () => {
    const merged = mergeIntervalsIcuStreams(outdoorRideStreams);

    expect(merged.latlng).toEqual([
      [10.0, 20.0],
      [10.0001, 20.0002],
      [10.0003, 20.0004],
      [10.0005, 20.0007],
    ]);
  });

  it('truncates latlng to the shorter of data and data2', () => {
    const merged = mergeIntervalsIcuStreams([
      {
        type: 'latlng',
        data: [1, 2, 3],
        data2: [10, 20],
      },
    ]);

    expect(merged.latlng).toEqual([
      [1, 10],
      [2, 20],
    ]);
  });

  it('drops streams that have nowhere to go', () => {
    const merged = mergeIntervalsIcuStreams(outdoorRideStreams);

    expect(Object.keys(merged).sort()).toEqual([
      'altitude',
      'cadence',
      'distance',
      'heartrate',
      'latlng',
      'temp',
      'time',
      'watts',
    ]);
  });

  it('replaces null samples with 0 rather than emitting holes', () => {
    const merged = mergeIntervalsIcuStreams([
      { type: 'heartrate', data: [120, null, 124], data2: null },
      { type: 'latlng', data: [1, null], data2: [null, 2] },
    ]);

    expect(merged.heartrate).toEqual([120, 0, 124]);
    expect(merged.latlng).toEqual([
      [1, 0],
      [0, 2],
    ]);
  });

  it('skips streams flagged allNull', () => {
    const merged = mergeIntervalsIcuStreams([
      { type: 'watts', data: [null, null], data2: null, allNull: true },
    ]);

    expect(merged.watts).toBeUndefined();
  });

  it('prefers the elevation-corrected altitude stream when both are present', () => {
    const rawFirst = mergeIntervalsIcuStreams([
      { type: 'altitude', data: [1, 2], data2: null },
      { type: 'fixed_altitude', data: [10, 20], data2: null },
    ]);
    const fixedFirst = mergeIntervalsIcuStreams([
      { type: 'fixed_altitude', data: [10, 20], data2: null },
      { type: 'altitude', data: [1, 2], data2: null },
    ]);

    expect(rawFirst.altitude).toEqual([10, 20]);
    expect(fixedFirst.altitude).toEqual([10, 20]);
  });
});

describe('resolveIntervalsIcuAverageWatts', () => {
  it('uses icu_average_watts when average_watts is null (the common case)', () => {
    expect(outdoorRideActivity.average_watts).toBeNull();
    expect(resolveIntervalsIcuAverageWatts(outdoorRideActivity)).toBe(202);
  });

  it('falls back to average_watts when Intervals has no computed value', () => {
    expect(
      resolveIntervalsIcuAverageWatts({
        average_watts: 180,
        icu_average_watts: null,
      }),
    ).toBe(180);
  });

  it('prefers icu_average_watts when both are present', () => {
    expect(
      resolveIntervalsIcuAverageWatts({
        average_watts: 180,
        icu_average_watts: 202,
      }),
    ).toBe(202);
  });

  it('returns null when neither is present', () => {
    expect(resolveIntervalsIcuAverageWatts(virtualRunActivity)).toBeNull();
    expect(resolveIntervalsIcuAverageWatts({})).toBeNull();
  });

  it('keeps a genuine zero rather than treating it as missing', () => {
    expect(resolveIntervalsIcuAverageWatts({ icu_average_watts: 0 })).toBe(0);
  });
});

describe('resolveIntervalsIcuMaxWatts', () => {
  // The bug this replaces: `max_watts` is not a property of the Intervals.icu
  // `Activity` schema, so reading it directly yielded null on all 1,222
  // activities of a real account. Peak power has to come from the watts stream.
  it('derives the peak from the watts stream when the summary has none', () => {
    expect(outdoorRideActivity.max_watts).toBeUndefined();

    const stream = mergeIntervalsIcuStreams(outdoorRideStreams);

    expect(stream.watts).toEqual([0, 145, 210, 198]);
    expect(resolveIntervalsIcuMaxWatts(outdoorRideActivity, stream)).toBe(210);
  });

  it('returns null for an activity with no power stream', () => {
    expect(resolveIntervalsIcuMaxWatts(virtualRunActivity, {})).toBeNull();
    expect(resolveIntervalsIcuMaxWatts({}, undefined)).toBeNull();
    expect(resolveIntervalsIcuMaxWatts({}, { watts: [] })).toBeNull();
  });

  it('still honours an explicit max_watts if a payload ever carries one', () => {
    expect(
      resolveIntervalsIcuMaxWatts({ max_watts: 741 }, { watts: [10] }),
    ).toBe(741);
  });

  it('keeps a genuine zero rather than treating it as missing', () => {
    expect(resolveIntervalsIcuMaxWatts({ max_watts: 0 }, undefined)).toBe(0);
    expect(resolveIntervalsIcuMaxWatts({}, { watts: [0, 0] })).toBe(0);
  });

  it('ignores non-finite samples', () => {
    expect(
      resolveIntervalsIcuMaxWatts({}, { watts: [12, Number.NaN, 34] }),
    ).toBe(34);
  });
});

describe('resolveIntervalsIcuKilojoules', () => {
  it('converts joules to kilojoules', () => {
    expect(resolveIntervalsIcuKilojoules(outdoorRideActivity)).toBeCloseTo(
      1167.762,
      3,
    );
  });

  it('returns null when the activity has no energy', () => {
    expect(resolveIntervalsIcuKilojoules(virtualRunActivity)).toBeNull();
  });
});

describe('resolveIntervalsIcuRpe', () => {
  it('scales the 1-10 provider scale onto the 0.0-1.0 column', () => {
    expect(resolveIntervalsIcuRpe({ icu_rpe: 7 })).toBeCloseTo(0.7, 6);
    expect(resolveIntervalsIcuRpe({ perceived_exertion: 10 })).toBe(1);
  });

  it('clamps and ignores non-values', () => {
    expect(resolveIntervalsIcuRpe({ icu_rpe: 12 })).toBe(1);
    expect(resolveIntervalsIcuRpe({ icu_rpe: 0 })).toBeNull();
    expect(resolveIntervalsIcuRpe(outdoorRideActivity)).toBeNull();
  });
});

describe('toIntervalsIcuDate', () => {
  it('formats a date as the YYYY-MM-DD the API expects', () => {
    expect(toIntervalsIcuDate(new Date('2026-06-28T19:18:28Z'))).toBe(
      '2026-06-28',
    );
  });
});
