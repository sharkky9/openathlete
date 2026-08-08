/**
 * Pins the process timezone for the Jest run.
 *
 * The training-load code derives its day keys with a mix of local-time
 * (`setHours(0, 0, 0, 0)`) and UTC (`toISOString().split('T')[0]`) calls, so the
 * day a load lands on shifts with the machine's timezone. CI runners are UTC;
 * pinning it here means a developer in another timezone gets the same results
 * rather than an off-by-one-day failure that looks like a broken assertion.
 *
 * The local/UTC mix in `TrainingLoadService` is a real latent defect, not
 * something this file fixes — see the note in `training-load.service.spec.ts`.
 */
process.env.TZ = 'UTC';

export {};
