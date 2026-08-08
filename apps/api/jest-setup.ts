/**
 * Jest setup for the API suite.
 *
 * This file used to assign `process.env.TZ = 'UTC'` here, to keep day-boundary
 * maths reproducible. That did two unhelpful things.
 *
 * First, it did not work. Jest replaces `process.env` with a plain object
 * inside the test sandbox, so the libuv hook that re-reads the zone never
 * fires: the assignment changed a string and nothing else. The suite has always
 * run in whatever timezone the process was started with. It looked like it
 * worked only because CI runners are already UTC.
 *
 * Second, had it worked it would have been actively harmful. `TrainingLoadService`
 * built its day grid with local-time `setHours(0, 0, 0, 0)` and then keyed it
 * with UTC `toISOString()`. Those two agree only on UTC, so a suite pinned to
 * UTC could not fail on the mismatch no matter how much load-bucketing it
 * asserted — which is exactly how the defect survived. The service now defines
 * a training day as a UTC calendar day throughout, matching the `@db.Date`
 * column the entries are stored in.
 *
 * So the timezone is deliberately left to the environment: the suite is
 * expected to pass in any zone, and `pnpm api test:timezones` runs it across
 * several to prove it. Set `TZ` yourself to reproduce a specific one:
 *
 *   TZ=America/Los_Angeles pnpm api test
 */

export {};
