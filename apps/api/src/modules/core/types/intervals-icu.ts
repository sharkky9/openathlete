/**
 * Intervals.icu API types.
 *
 * Only the subset of fields OpenAthlete consumes is declared here. The real
 * payloads are much wider (an activity carries ~183 keys, an athlete ~180) and
 * every field is optional/nullable in practice, so everything below is modelled
 * defensively.
 *
 * Reference: https://intervals.icu/api/v1/docs (OpenAPI 3.0.1)
 */

/**
 * Where an activity originally came from before Intervals.icu aggregated it.
 * Worth surfacing: it is the true provenance the direct integrations used to give us.
 *
 * Documented values: STRAVA, UPLOAD, MANUAL, GARMIN_CONNECT, OAUTH_CLIENT, DROPBOX,
 * POLAR, SUUNTO, COROS, WAHOO, ZWIFT, ZEPP, CONCEPT2, HUAWEI. Typed as a plain
 * string because the enum is not closed and we must not crash on a new value.
 */
export type IntervalsIcuActivitySource = string;

export interface IntervalsIcuAthlete {
  /** Opaque string id, e.g. "i123456". Never parse it as a number. */
  id: string;
  name?: string | null;
  email?: string | null;
  timezone?: string | null;
  locale?: string | null;
}

export interface IntervalsIcuActivity {
  /** Opaque string id, e.g. "i167939639". */
  id: string;
  name?: string | null;
  description?: string | null;
  /** Strava-compatible sport vocabulary, e.g. "Run", "TrailRun", "VirtualRide". */
  type?: string | null;
  sub_type?: string | null;

  start_date?: string | null;
  start_date_local?: string | null;
  timezone?: string | null;

  elapsed_time?: number | null;
  moving_time?: number | null;

  distance?: number | null;
  icu_distance?: number | null;
  total_elevation_gain?: number | null;
  total_elevation_loss?: number | null;

  average_speed?: number | null;
  max_speed?: number | null;
  /** Grade-adjusted pace as a speed in m/s. */
  gap?: number | null;

  average_cadence?: number | null;

  /**
   * Power. The OpenAPI `Activity` schema declares *only* the `icu_`-prefixed
   * names — `average_watts` and `max_watts` are properties of `Interval`, not
   * of `Activity`. So `icu_average_watts` is the primary field, not a fallback.
   *
   * `average_watts` is kept purely as a defensive fallback (it has been seen on
   * the wire, always null, and the spec is a lower bound on what is returned).
   * See `resolveIntervalsIcuAverageWatts`.
   */
  average_watts?: number | null;
  icu_average_watts?: number | null;
  /**
   * Not in the documented `Activity` schema, and null on every activity of a
   * real 1,224-activity account. Intervals.icu simply does not report peak power
   * on the activity summary — `p_max`/`icu_pm_p_max` are power-*model*
   * parameters, not this ride's maximum. Max power is therefore derived from the
   * `watts` stream; see `resolveIntervalsIcuMaxWatts`. Declared only so a
   * payload that does carry it is still honoured.
   */
  max_watts?: number | null;
  icu_weighted_avg_watts?: number | null;

  average_heartrate?: number | null;
  max_heartrate?: number | null;

  /** Joules, not kilojoules. Divide by 1000 before storing. */
  icu_joules?: number | null;
  calories?: number | null;

  // Intervals.icu also reports its own training load (`icu_training_load` and
  // the per-method `power_load` / `pace_load` / `hr_load` / `trimp`). None of it
  // is modelled here: OpenAthlete computes and stores its own training load, so
  // there is no column to put an upstream figure in and no way to reconcile two
  // different models on one activity.

  /** 1-10 scale. The OpenAthlete `rpe` column is 0.0-1.0. */
  icu_rpe?: number | null;
  perceived_exertion?: number | null;

  /**
   * Names of the streams this activity actually has. Present on the summary
   * object, so we never need to guess stream names or probe for them.
   */
  stream_types?: string[] | null;

  source?: IntervalsIcuActivitySource | null;
  device_name?: string | null;
  file_type?: string | null;
  external_id?: string | null;
  strava_id?: string | null;

  trainer?: boolean | null;
  commute?: boolean | null;
}

/**
 * A single stream from `GET /activity/{id}/streams`.
 *
 * Structurally the same envelope Strava uses (`{ type, data }[]`), with one
 * addition: `latlng` splits latitude into `data` and longitude into `data2`.
 * All other stream types leave `data2` null.
 */
export interface IntervalsIcuStream {
  type: string;
  name?: string | null;
  data?: (number | null)[] | null;
  data2?: (number | null)[] | null;
  valueType?: string | null;
  valueTypeIsArray?: boolean | null;
  allNull?: boolean | null;
  custom?: boolean | null;
}
