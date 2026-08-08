import { SportType } from '@openathlete/database';
import { ActivityStream } from '@openathlete/shared';

import {
  IntervalsIcuActivity,
  IntervalsIcuStream,
} from '../types/intervals-icu';
import { mapStravaSportType } from './strava';

/**
 * Intervals.icu uses Strava's sport vocabulary, so `mapStravaSportType` does
 * nearly all the work. Only the handful of types Strava lacks are handled here;
 * everything else falls through to the shared mapper (which itself defaults to
 * `OTHER` for anything unrecognised).
 */
export const mapIntervalsIcuSportType = (
  type: string | null | undefined,
): SportType => {
  switch (type) {
    case 'TrackRide':
    case 'Cyclocross':
      return SportType.CYCLING;
    case 'OpenWaterSwim':
      return SportType.SWIMMING;
    case 'VirtualSki':
      return SportType.ALPINE_SKI;
    case 'Rugby':
    case 'Hockey':
    case 'Padel':
    case 'WaterSport':
    case 'Transition':
    case 'Other':
      return SportType.OTHER;
    default:
      return mapStravaSportType(type ?? '');
  }
};

/**
 * Stream names OpenAthlete can actually store, mapped from the names
 * Intervals.icu uses. Anything not in this map (torque, stance_time,
 * vertical_oscillation, left_right_balance, ...) has nowhere to go in
 * `ActivityStream` and is dropped.
 *
 * `gap` and `norm` are intentionally absent: they are computed downstream from
 * the imported streams, not ingested.
 */
const INTERVALS_ICU_STREAM_NAME_TO_KEY: Record<
  string,
  Exclude<keyof ActivityStream, 'gap' | 'norm'>
> = {
  time: 'time',
  distance: 'distance',
  latlng: 'latlng',
  altitude: 'altitude',
  fixed_altitude: 'altitude',
  heartrate: 'heartrate',
  cadence: 'cadence',
  watts: 'watts',
  temp: 'temp',
};

/**
 * The Intervals.icu stream names we ask for, in the order we prefer them.
 * `fixed_altitude` (barometric / elevation-corrected) wins over raw `altitude`
 * when an activity has both.
 */
const STREAM_PREFERENCE: Record<string, number> = {
  altitude: 0,
  fixed_altitude: 1,
};

/**
 * Which streams to request for a given activity.
 *
 * Reads `activity.stream_types` — present on every activity summary — instead of
 * hardcoding a guessed list, then intersects it with what we can store. Always
 * returns an explicit list: calling the streams endpoint with no `types` makes
 * Intervals.icu return the *raw* power stream under `raw_watts` rather than its
 * corrected `watts`.
 */
export const selectIntervalsIcuStreamTypes = (
  streamTypes: string[] | null | undefined,
): string[] => {
  const available = streamTypes ?? [];
  const wanted = available.filter(
    (type) => type in INTERVALS_ICU_STREAM_NAME_TO_KEY,
  );

  // `time` anchors every other stream's index; ask for it even if the activity
  // summary did not advertise it.
  if (wanted.length > 0 && !wanted.includes('time')) {
    wanted.unshift('time');
  }

  return wanted;
};

const toNumbers = (data: (number | null)[] | null | undefined): number[] =>
  (data ?? []).map((value) => (typeof value === 'number' ? value : 0));

/**
 * Fold an Intervals.icu `{ type, data }[]` response into OpenAthlete's flat
 * `ActivityStream`.
 *
 * Two things differ from Strava's otherwise identical envelope:
 *  - `latlng` arrives split across two parallel arrays: `data` holds latitude,
 *    `data2` holds longitude. We zip them back into `[lat, lng]` pairs.
 *  - Some streams (`torque`, running dynamics, ...) have no home in
 *    `ActivityStream` and are dropped rather than smuggled through.
 */
export const mergeIntervalsIcuStreams = (
  streams: IntervalsIcuStream[],
): ActivityStream => {
  const merged: ActivityStream = {};
  const appliedPreference: Partial<Record<keyof ActivityStream, number>> = {};

  for (const stream of streams) {
    const key = INTERVALS_ICU_STREAM_NAME_TO_KEY[stream.type];
    if (!key) {
      continue;
    }

    if (stream.allNull === true) {
      continue;
    }

    const preference = STREAM_PREFERENCE[stream.type] ?? 0;
    const existingPreference = appliedPreference[key];
    if (existingPreference !== undefined && existingPreference >= preference) {
      continue;
    }

    if (key === 'latlng') {
      const lat = stream.data ?? [];
      const lng = stream.data2 ?? [];
      const length = Math.min(lat.length, lng.length);
      const pairs: number[][] = [];
      for (let i = 0; i < length; i++) {
        pairs.push([
          typeof lat[i] === 'number' ? (lat[i] as number) : 0,
          typeof lng[i] === 'number' ? (lng[i] as number) : 0,
        ]);
      }
      merged.latlng = pairs;
    } else {
      merged[key] = toNumbers(stream.data);
    }

    appliedPreference[key] = preference;
  }

  return merged;
};

/**
 * `average_watts` is null on Intervals.icu even for power-meter rides; the
 * populated field is `icu_average_watts`. The OpenAPI `Activity` schema in fact
 * declares only `icu_average_watts` — the unprefixed name belongs to `Interval`
 * — so the `average_watts` branch is defensive, not the normal path.
 */
export const resolveIntervalsIcuAverageWatts = (
  activity: Pick<IntervalsIcuActivity, 'average_watts' | 'icu_average_watts'>,
): number | null => {
  if (typeof activity.icu_average_watts === 'number') {
    return activity.icu_average_watts;
  }
  if (typeof activity.average_watts === 'number') {
    return activity.average_watts;
  }
  return null;
};

/**
 * Maximum power for an activity.
 *
 * There is no summary field for it. `max_watts` is not a property of the
 * Intervals.icu `Activity` schema at all (it belongs to `Interval`), and there
 * is no `icu_max_watts` anywhere in the API — which is why reading
 * `activity.max_watts` produced a null `maxWatts` on all 1,222 activities of a
 * real account. The near-miss candidates `p_max` / `icu_pm_p_max` /
 * `icu_rolling_p_max` are power-duration *model* parameters fitted across the
 * athlete's history, not this activity's peak, so they must not be used here.
 *
 * The `watts` stream we already fetch is the actual measurement, so the peak is
 * taken from it. An explicit `max_watts` still wins if a payload ever carries
 * one.
 */
export const resolveIntervalsIcuMaxWatts = (
  activity: Pick<IntervalsIcuActivity, 'max_watts'>,
  stream?: Pick<ActivityStream, 'watts'> | null,
): number | null => {
  if (typeof activity.max_watts === 'number') {
    return activity.max_watts;
  }

  const watts = stream?.watts;
  if (!watts || watts.length === 0) {
    return null;
  }

  let max = Number.NEGATIVE_INFINITY;
  for (const sample of watts) {
    if (typeof sample === 'number' && Number.isFinite(sample) && sample > max) {
      max = sample;
    }
  }

  return max === Number.NEGATIVE_INFINITY ? null : max;
};

/**
 * Intervals.icu RPE is a 1-10 scale; the `rpe` column stores 0.0-1.0.
 */
export const resolveIntervalsIcuRpe = (
  activity: Pick<IntervalsIcuActivity, 'icu_rpe' | 'perceived_exertion'>,
): number | null => {
  const raw =
    typeof activity.icu_rpe === 'number'
      ? activity.icu_rpe
      : typeof activity.perceived_exertion === 'number'
        ? activity.perceived_exertion
        : null;

  if (raw === null || raw <= 0) {
    return null;
  }

  return Math.min(1, raw / 10);
};

/** Intervals.icu reports energy in joules; the `kilojoules` column wants kJ. */
export const resolveIntervalsIcuKilojoules = (
  activity: Pick<IntervalsIcuActivity, 'icu_joules'>,
): number | null =>
  typeof activity.icu_joules === 'number' ? activity.icu_joules / 1000 : null;

/** Format a Date as the local ISO date (YYYY-MM-DD) Intervals.icu expects. */
export const toIntervalsIcuDate = (date: Date): string =>
  date.toISOString().slice(0, 10);
