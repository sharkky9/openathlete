import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  ConnectorProvider,
  EventActivity,
  EventType,
  Prisma,
  ProviderAccount,
} from '@openathlete/database';
import { ActivityStream, ApiEnvSchemaType } from '@openathlete/shared';

import { isValidTimeZone, toDayAnchor } from 'src/common/utils/day-anchor';
import { AuthUser } from 'src/modules/auth/decorators/user.decorator';

import { compressActivityStream } from '../../core/helpers/activity-stream';
import {
  mapIntervalsIcuSportType,
  mergeIntervalsIcuStreams,
  resolveIntervalsIcuAverageWatts,
  resolveIntervalsIcuKilojoules,
  resolveIntervalsIcuMaxWatts,
  resolveIntervalsIcuRpe,
  selectIntervalsIcuStreamTypes,
  toIntervalsIcuDate,
} from '../../core/helpers/intervals-icu';
import {
  roundCadence,
  roundDistance,
  roundElevation,
  roundEnergy,
  roundHeartrate,
  roundPower,
  roundSpeed,
} from '../../core/helpers/round-activity-values';
import {
  IntervalsIcuActivity,
  IntervalsIcuAthlete,
  IntervalsIcuStream,
} from '../../core/types/intervals-icu';
import { PrismaService } from '../../prisma/services/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { BaseProviderService, FullImportResult } from '../base';
import {
  ImportOptions,
  ImportedActivity,
  ProviderImportCapability,
} from '../base/provider-import.interface';
import {
  IntervalsIcuApiClient,
  IntervalsIcuClientOptions,
  IntervalsIcuHttpError,
} from './intervals-icu.client';

/**
 * `GET /athlete/0` is a documented "me" alias, so the athlete ID can be
 * discovered from the key alone rather than asked for at connect time.
 */
const ME_ATHLETE_ID = '0';

/** `oldest` is a required query parameter — there is no "everything" call. */
const DEFAULT_IMPORT_LOOKBACK_DAYS = 30;

/** How far back a full import reaches. Intervals.icu accounts predate 2010 rarely. */
const FULL_IMPORT_FLOOR = new Date('2000-01-01T00:00:00.000Z');

/**
 * Activity listing has no pagination — only a date range and a `limit` that
 * truncates the *oldest* end. So history is walked in fixed date windows.
 */
const IMPORT_WINDOW_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long the event + activity write is allowed to take.
 *
 * Prisma's default interactive-transaction timeout is 5 seconds. That is ample
 * for the two small statements at either end, but not for the row in the
 * middle: `stream` carries the whole compressed activity stream, and the
 * account this was built against has an 11.6-hour run with 43,617 samples
 * across eight channels — several megabytes of JSON in one INSERT. Those are
 * precisely the activities that must not fail, so the ceiling is sized for them
 * rather than for the median ride.
 *
 * Raising it is cheap. There is no network call inside the transaction, so a
 * quick write still commits in milliseconds; the ceiling only decides how long
 * a genuinely enormous one is given before being rolled back.
 */
const ACTIVITY_WRITE_TIMEOUT_MS = 120_000;

/**
 * How long to wait for a free connection before giving up on the transaction.
 * Import concurrency is 3, so contention is mild, but the default 2 seconds is
 * tight enough that a burst can fail outright while the pool is busy.
 */
const ACTIVITY_WRITE_MAX_WAIT_MS = 20_000;

/**
 * How recent an activity-less `Event` may be and still be treated as wreckage.
 *
 * `Event` has no provider column, so an activity-less ACTIVITY row does not say
 * who created it — and Strava, Garmin, Polar and Suunto all still create their
 * `Event` and their `EventActivity` in two separate statements with a network
 * call in between. For the length of that call their event is indistinguishable
 * from an orphan. Strava alone allows 45 seconds for a stream fetch. Adopting
 * one of those would hang an Intervals.icu activity off another provider's
 * event and then collide with that provider's own insert.
 *
 * An hour is far longer than any of those windows and far shorter than the age
 * of a genuinely abandoned row, so it separates the two without needing to know
 * who wrote which.
 */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * ...and how old is too old. Past this an activity-less event is not the
 * leftovers of a recent failed import, it is something else, and adopting it
 * would be a guess.
 */
const ORPHAN_MAX_AGE_MS = 30 * DAY_MS;

/**
 * Intervals.icu provider.
 *
 * Unlike every other provider here, Intervals.icu authenticates with a static,
 * user-supplied API key over HTTP Basic — there is no authorization redirect,
 * no client id/secret, no refresh token and no expiry. Consequently this service
 * defines no `oauthConfig` (the base class now treats it as optional) and
 * overrides `getValidAccessToken` to hand back the stored key verbatim.
 *
 * It is also poll-only: webhooks exist but are gated behind a registered OAuth
 * application, which is not available to personal API-key users.
 */
@Injectable()
export class IntervalsIcuProviderService
  extends BaseProviderService
  implements ProviderImportCapability
{
  protected readonly provider = ConnectorProvider.INTERVALS_ICU;

  /**
   * Intentionally absent: this provider does not use OAuth. The base class
   * declares `oauthConfig` optional and throws from the OAuth helpers if they
   * are ever called on a static-credential provider.
   */
  protected readonly oauthConfig = undefined;

  constructor(
    prisma: PrismaService,
    configService: ConfigService<ApiEnvSchemaType, true>,
    @Inject(forwardRef(() => QueueService))
    private readonly queueService: QueueService,
  ) {
    super(prisma, configService);
  }

  /**
   * The stored "access token" is the personal API key. It never expires and
   * cannot be refreshed, so the base implementation (which falls through to a
   * refresh when `expiresAt` is null) must not run.
   */
  override async getValidAccessToken(
    account: ProviderAccount,
  ): Promise<string> {
    if (account.status !== 'active') {
      throw new Error(
        `Intervals.icu account ${account.providerAccountId} is ${account.status}`,
      );
    }

    if (!account.accessToken) {
      throw new Error(
        `No Intervals.icu API key stored for account ${account.providerAccountId}`,
      );
    }

    return account.accessToken;
  }

  /** Static API keys cannot be refreshed. */
  override refreshAccessToken(): Promise<never> {
    return Promise.reject(
      new Error('Intervals.icu uses a static API key and cannot refresh it'),
    );
  }

  protected createClient(
    apiKey: string,
    options?: IntervalsIcuClientOptions,
  ): IntervalsIcuApiClient {
    return new IntervalsIcuApiClient(apiKey, {
      onRetry: ({ attempt, status, delayMs, path }) => {
        this.logger.warn(
          `Intervals.icu ${path} returned ${status ?? 'a network error'} (attempt ${attempt}); retrying in ${delayMs}ms`,
        );
      },
      ...options,
    });
  }

  /**
   * One live client per provider account.
   *
   * The client self-throttles by remembering when it last called out, which only
   * works if the same instance survives between calls. Building a fresh one per
   * activity reset that clock to zero every time, so the 200ms spacing applied
   * *within* an activity and never *between* activities — a 1,224-activity
   * import then fired as fast as the worker pool could go and drew an auth
   * block. The map is keyed by account and holds the key it was built with, so a
   * reconnected account with a new key gets a new client rather than a stale one.
   */
  private readonly clients = new Map<
    number,
    { apiKey: string; client: IntervalsIcuApiClient }
  >();

  private async clientForAccount(
    account: ProviderAccount,
  ): Promise<IntervalsIcuApiClient> {
    const apiKey = await this.getValidAccessToken(account);
    const cached = this.clients.get(account.providerAccountId);

    if (cached && cached.apiKey === apiKey) {
      return cached.client;
    }

    const client = this.createClient(apiKey);
    this.clients.set(account.providerAccountId, { apiKey, client });

    return client;
  }

  private athleteIdFor(account: ProviderAccount): string {
    return account.externalUserId ?? ME_ATHLETE_ID;
  }

  /**
   * Persist the provider's current IANA zone and repair every stored day label.
   *
   * CTL and ATL are derived on reads; neither value is persisted or memoized.
   * The only historical state that needs repair is therefore each entry's
   * `date`, re-derived independently from its activity event's immutable start
   * instant. Updating only changed rows makes this safe to rerun after an
   * interrupted import and whenever Intervals.icu reports a changed home zone.
   */
  private async synchronizeAthleteTimezone(
    athleteId: number,
    candidateTimeZone?: string | null,
  ): Promise<void> {
    const timeZone = candidateTimeZone?.trim();
    if (!timeZone) return;

    if (!isValidTimeZone(timeZone)) {
      this.logger.warn(
        `Ignoring invalid Intervals.icu timezone "${timeZone}" for athlete ${athleteId}`,
      );
      return;
    }

    await this.prisma.athlete.update({
      where: { athleteId },
      data: { timezone: timeZone },
    });

    const entries = await this.prisma.trainingLoadEntry.findMany({
      where: {
        calculation: { athleteId },
      },
      select: {
        trainingLoadEntryId: true,
        date: true,
        activity: {
          select: {
            event: { select: { startDate: true } },
          },
        },
      },
    });

    let updated = 0;
    for (const entry of entries) {
      const date = toDayAnchor(entry.activity.event.startDate, timeZone);
      if (date.getTime() === entry.date.getTime()) continue;

      await this.prisma.trainingLoadEntry.update({
        where: { trainingLoadEntryId: entry.trainingLoadEntryId },
        data: { date },
      });
      updated++;
    }

    if (updated > 0) {
      this.logger.log(
        `Re-anchored ${updated} training-load entries to ${timeZone} for athlete ${athleteId}`,
      );
    }
  }

  private async refreshAthleteTimezone(
    account: ProviderAccount,
    client: IntervalsIcuApiClient,
  ): Promise<void> {
    const profile = await client.get<IntervalsIcuAthlete>(
      `/athlete/${encodeURIComponent(this.athleteIdFor(account))}`,
    );
    await this.synchronizeAthleteTimezone(account.athleteId, profile.timezone);
  }

  /**
   * Resolve the credential to connect with.
   *
   * A key supplied in the request always wins. Only when none is supplied do we
   * fall back to `INTERVALS_ICU_API_KEY`, which lets a single-user deployment
   * configure the credential on the server instead of pasting it into a form.
   *
   * `INTERVALS_ICU_ATHLETE_ID` is deliberately tied to the fallback key: it
   * identifies *that* key's athlete, so pairing it with someone else's key
   * would point the connection at the wrong account.
   */
  private resolveConnectCredentials(
    apiKey?: string,
    athleteId?: string,
  ): { apiKey: string; athleteId?: string; usedEnvFallback: boolean } {
    const requestKey = apiKey?.trim();
    const requestAthleteId = athleteId?.trim();

    if (requestKey) {
      return {
        apiKey: requestKey,
        athleteId: requestAthleteId,
        usedEnvFallback: false,
      };
    }

    const envKey = this.configService.get('INTERVALS_ICU_API_KEY')?.trim();

    if (!envKey) {
      throw new Error(
        'An Intervals.icu API key is required: supply one when connecting, or set INTERVALS_ICU_API_KEY on the server',
      );
    }

    return {
      apiKey: envKey,
      athleteId:
        requestAthleteId ||
        this.configService.get('INTERVALS_ICU_ATHLETE_ID')?.trim() ||
        undefined,
      usedEnvFallback: true,
    };
  }

  /**
   * Validate an API key and link the account.
   *
   * There is no OAuth round-trip: the user pastes their key from
   * https://intervals.icu/settings — or the deployment sets
   * `INTERVALS_ICU_API_KEY` and supplies none — and we verify it by reading the
   * athlete profile. The athlete ID is discovered from the response, so it
   * never has to be found by hand.
   *
   * Both routes are validated identically, so a mistyped environment variable
   * fails here at connect time rather than silently at the first sync.
   */
  async connect(
    user: AuthUser,
    apiKey?: string,
    athleteId?: string,
  ): Promise<ProviderAccount> {
    const credentials = this.resolveConnectCredentials(apiKey, athleteId);

    const athlete = await this.prisma.athlete.findUnique({
      where: { userId: user.userId },
      select: { athleteId: true },
    });

    if (!athlete) {
      throw new Error('Athlete not found');
    }

    const client = this.createClient(credentials.apiKey);
    const requestedAthleteId = credentials.athleteId || ME_ATHLETE_ID;

    const profile = await client.get<IntervalsIcuAthlete>(
      `/athlete/${encodeURIComponent(requestedAthleteId)}`,
    );

    // IDs are opaque strings ("i123456"); never coerce them to numbers.
    const externalUserId =
      typeof profile?.id === 'string' && profile.id.length > 0
        ? profile.id
        : requestedAthleteId;

    await this.synchronizeAthleteTimezone(athlete.athleteId, profile.timezone);

    // The key itself is never logged — only where it came from.
    this.logger.log(
      `Connected Intervals.icu athlete ${externalUserId} for OpenAthlete athlete ${athlete.athleteId} (API key from ${credentials.usedEnvFallback ? 'INTERVALS_ICU_API_KEY' : 'request'})`,
    );

    return this.saveProviderAccount({
      athleteId: athlete.athleteId,
      accessToken: credentials.apiKey,
      // No refresh token and no expiry: the key is static.
      refreshToken: '',
      scopes: 'api_key',
      externalUserId,
    });
  }

  /**
   * List activities between two dates.
   *
   * The endpoint returns newest-first with no pagination, so history is walked
   * one date window at a time rather than page by page.
   */
  async importActivities(
    account: ProviderAccount,
    options?: ImportOptions,
  ): Promise<ImportedActivity[]> {
    const client = await this.clientForAccount(account);
    const athleteId = this.athleteIdFor(account);

    // Imports are explicit rather than scheduled, so this is the refresh point
    // for a changed Intervals.icu profile timezone.
    await this.refreshAthleteTimezone(account, client);

    const endDate = options?.endDate ?? new Date();
    const startDate =
      options?.startDate ??
      new Date(endDate.getTime() - DEFAULT_IMPORT_LOOKBACK_DAYS * DAY_MS);
    const limit = options?.limit ?? Number.POSITIVE_INFINITY;

    const seen = new Set<string>();
    const imported: ImportedActivity[] = [];

    let windowEnd = endDate;

    while (windowEnd > startDate && imported.length < limit) {
      const windowStart = new Date(
        Math.max(
          startDate.getTime(),
          windowEnd.getTime() - IMPORT_WINDOW_DAYS * DAY_MS,
        ),
      );

      const activities = await client.get<IntervalsIcuActivity[]>(
        `/athlete/${encodeURIComponent(athleteId)}/activities`,
        {
          oldest: toIntervalsIcuDate(windowStart),
          newest: toIntervalsIcuDate(windowEnd),
        },
      );

      for (const activity of activities ?? []) {
        if (imported.length >= limit) break;
        if (!activity?.id || seen.has(activity.id)) continue;
        seen.add(activity.id);

        const mapped = this.toImportedActivity(activity);
        if (!mapped) continue;

        if (mapped.startDate < startDate || mapped.startDate > endDate) {
          continue;
        }

        imported.push(mapped);
      }

      // Windows are inclusive on both ends; step back a day to avoid re-reading
      // the boundary date (duplicates are filtered anyway, but this saves calls).
      windowEnd = new Date(windowStart.getTime() - DAY_MS);
    }

    return imported;
  }

  private toImportedActivity(
    activity: IntervalsIcuActivity,
  ): ImportedActivity | null {
    const rawStart = activity.start_date ?? activity.start_date_local;
    if (!rawStart) {
      this.logger.warn(
        `Skipping Intervals.icu activity ${activity.id} with no start date`,
      );
      return null;
    }

    const startDate = new Date(rawStart);
    if (Number.isNaN(startDate.getTime())) {
      this.logger.warn(
        `Skipping Intervals.icu activity ${activity.id} with unparsable start date "${rawStart}"`,
      );
      return null;
    }

    const duration = activity.elapsed_time ?? activity.moving_time ?? 0;
    const endDate = new Date(startDate.getTime() + duration * 1000);

    return {
      externalId: activity.id,
      name: activity.name ?? 'Activity',
      startDate,
      endDate,
      sport: mapIntervalsIcuSportType(activity.type),
      distance: activity.distance ?? activity.icu_distance ?? undefined,
      duration,
      // Upstream provenance (GARMIN_CONNECT / ZWIFT / UPLOAD / ...). Intervals.icu
      // is an aggregator, so this is the platform the activity really came from.
      source: activity.source ?? null,
      deviceName: activity.device_name ?? null,
      raw: activity,
    };
  }

  /**
   * Import and persist a single activity, including its streams.
   *
   * Ordering here is load-bearing. Everything that can fail — fetching the
   * streams, above all — happens *before* the first write, and the two rows that
   * make up an activity are then written in one transaction. The previous order
   * created the `Event` first and only then went to the network, so a stream
   * fetch that threw left an `Event` with no `EventActivity` behind it. Because
   * the dedup guard below looks for an `EventActivity`, those orphans were
   * invisible to it: each of the three BullMQ attempts leaked another one, the
   * activity was still lost at the end, and a fourth attempt would have leaked a
   * fourth. On a real account that cost 2 activities and left 6 orphan events.
   */
  async importActivity(
    account: ProviderAccount,
    activity: ImportedActivity,
  ): Promise<EventActivity> {
    const existing = await this.prisma.eventActivity.findFirst({
      where: { externalId: activity.externalId },
    });

    if (existing) {
      return existing;
    }

    const athlete = await this.prisma.athlete.findUnique({
      where: { athleteId: account.athleteId },
      select: { athleteId: true },
    });

    if (!athlete) {
      throw new Error('Athlete not found');
    }

    const raw = activity.raw as IntervalsIcuActivity | undefined;
    if (!raw?.id) {
      throw new Error(
        `Intervals.icu activity ${activity.externalId} is missing its raw payload`,
      );
    }

    const stream = await this.fetchStreams(account, raw);

    return this.persistActivity(athlete.athleteId, activity, raw, stream);
  }

  private async persistActivity(
    athleteId: number,
    imported: ImportedActivity,
    activity: IntervalsIcuActivity,
    stream: ActivityStream,
  ): Promise<EventActivity> {
    const compressionStart = Date.now();
    const compressedActivityStream = compressActivityStream(stream);
    const compressionTime = Date.now() - compressionStart;
    if (compressionTime > 1000) {
      this.logger.debug(
        `Stream compression took ${compressionTime}ms for Intervals.icu activity ${activity.id}`,
      );
    }

    this.logger.debug(
      `Importing Intervals.icu activity ${activity.id} (source: ${activity.source ?? 'unknown'}, device: ${activity.device_name ?? 'unknown'})`,
    );

    return this.prisma.$transaction(
      async (tx) => {
        const event = await this.resolveEvent(tx, athleteId, imported);

        return tx.eventActivity.create({
          data: {
            provider: ConnectorProvider.INTERVALS_ICU,
            distance: roundDistance(activity.distance ?? activity.icu_distance),
            elevationGain: roundElevation(activity.total_elevation_gain),
            movingTime: activity.moving_time ?? activity.elapsed_time ?? 0,
            averageSpeed: roundSpeed(activity.average_speed) ?? 0,
            maxSpeed: roundSpeed(activity.max_speed) ?? 0,
            averageCadence: roundCadence(activity.average_cadence),
            averageWatts: roundPower(resolveIntervalsIcuAverageWatts(activity)),
            maxWatts: roundPower(resolveIntervalsIcuMaxWatts(activity, stream)),
            weightedAverageWatts: roundPower(activity.icu_weighted_avg_watts),
            averageHeartrate: roundHeartrate(activity.average_heartrate),
            maxHeartrate: roundHeartrate(activity.max_heartrate),
            kilojoules: roundEnergy(resolveIntervalsIcuKilojoules(activity)),
            rpe: resolveIntervalsIcuRpe(activity),
            averageGapSpeed: roundSpeed(activity.gap),
            sport: mapIntervalsIcuSportType(activity.type),
            stream: compressedActivityStream as object,
            description: activity.description ?? '',
            externalId: activity.id,
            event: {
              connect: {
                eventId: event.eventId,
              },
            },
          },
        });
      },
      {
        timeout: ACTIVITY_WRITE_TIMEOUT_MS,
        maxWait: ACTIVITY_WRITE_MAX_WAIT_MS,
      },
    );
  }

  /**
   * The `Event` row to hang this activity off.
   *
   * Normally that is a new one. But an account that ran the old code already has
   * orphan events on it, and a retry there would create a *second* event rather
   * than reuse the one it abandoned. So an event that this importer can show it
   * wrote for this very activity, and then failed to finish, is adopted instead,
   * which makes a retry converge on one row per activity rather than accumulate
   * one per attempt.
   *
   * The match is deliberately narrow, because "activity-less ACTIVITY event" on
   * its own is not a safe thing to claim. `Event` carries no provider column, so
   * a row cannot say who made it, and every other provider — Strava, Garmin,
   * Polar, Suunto — still writes its `Event` and its `EventActivity` as two
   * statements with a network call in between. Any of their imports, mid-flight,
   * looks exactly like wreckage. Two things keep us off them:
   *
   *   - The row must be an exact copy of what *this* importer writes for *this*
   *     activity: same athlete, same start, same end, same name. The old code
   *     built its event from the same `toImportedActivity` mapping this one
   *     does, so its leftovers still match field for field; another provider's
   *     event for the same ride would have to agree on all four by coincidence.
   *   - The row must be old enough that nothing can still be working on it, and
   *     young enough to be the leftovers of a recent run rather than an
   *     unrelated row that happens to line up. See `ORPHAN_MIN_AGE_MS`.
   *
   * When no such row exists we simply create one. Failing to adopt costs an
   * unused row that was already there; adopting the wrong one corrupts two
   * accounts' data, so the asymmetry decides the strictness.
   */
  private async resolveEvent(
    tx: Prisma.TransactionClient,
    athleteId: number,
    imported: ImportedActivity,
  ): Promise<{ eventId: number }> {
    const now = Date.now();

    const orphan = await tx.event.findFirst({
      where: {
        athleteId,
        type: EventType.ACTIVITY,
        startDate: imported.startDate,
        endDate: imported.endDate,
        name: imported.name,
        activity: { is: null },
        createdAt: {
          gte: new Date(now - ORPHAN_MAX_AGE_MS),
          lte: new Date(now - ORPHAN_MIN_AGE_MS),
        },
      },
      orderBy: { eventId: 'asc' },
      select: { eventId: true },
    });

    if (orphan) {
      // Nothing to update: matching on name and end date is what made it safe
      // to adopt, so the row already says what we would have written.
      this.logger.warn(
        `Reusing orphaned event ${orphan.eventId} for Intervals.icu activity ${imported.externalId}`,
      );

      return orphan;
    }

    return tx.event.create({
      data: {
        athleteId,
        name: imported.name,
        type: EventType.ACTIVITY,
        startDate: imported.startDate,
        endDate: imported.endDate,
      },
      select: { eventId: true },
    });
  }

  /**
   * Fetch the streams an activity actually has.
   *
   * `stream_types` on the activity summary tells us exactly which streams exist,
   * so nothing is guessed and no request is wasted on an activity without them.
   * The `types` list is always explicit: omitting it makes Intervals.icu return
   * the raw power stream instead of its corrected one.
   *
   * Only a 404 is swallowed — that means the activity genuinely has no stream
   * data, and an empty stream is the truthful result. Any other failure is
   * re-thrown so the job fails and BullMQ retries it. Swallowing those instead
   * stored the activity with an empty stream and reported the import as a
   * success, which is how an activity that *does* have power and heart rate can
   * end up permanently blank with nothing flagged.
   */
  private async fetchStreams(
    account: ProviderAccount,
    activity: IntervalsIcuActivity,
  ): Promise<ActivityStream> {
    const types = selectIntervalsIcuStreamTypes(activity.stream_types);

    if (types.length === 0) {
      return {};
    }

    try {
      const client = await this.clientForAccount(account);
      const streams = await client.get<IntervalsIcuStream[]>(
        `/activity/${encodeURIComponent(activity.id)}/streams`,
        { types: types.join(',') },
      );

      return mergeIntervalsIcuStreams(streams ?? []);
    } catch (error) {
      if (error instanceof IntervalsIcuHttpError && error.status === 404) {
        this.logger.warn(
          `Intervals.icu reports no streams for activity ${activity.id}; importing without them`,
        );
        return {};
      }

      this.logger.error(
        `Error fetching Intervals.icu streams for activity ${activity.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Queue every historical activity for import.
   */
  async queueFullImport(account: ProviderAccount): Promise<FullImportResult> {
    this.logger.log(
      `Queueing Intervals.icu historical import for account ${account.providerAccountId}`,
    );

    const activities = await this.importActivities(account, {
      startDate: FULL_IMPORT_FLOOR,
      endDate: new Date(),
    });

    this.logger.log(
      `Fetched ${activities.length} activities from Intervals.icu for account ${account.providerAccountId}`,
    );

    if (activities.length === 0) {
      return { queuedActivities: 0 };
    }

    const queued = await this.enqueueActivities(account, activities);

    this.logger.log(
      `Queued ${queued} Intervals.icu activities for import (out of ${activities.length} total)`,
    );

    return { queuedActivities: queued };
  }

  private async enqueueActivities(
    account: ProviderAccount,
    activities: ImportedActivity[],
  ): Promise<number> {
    if (activities.length === 0) {
      return 0;
    }

    const existing = await this.prisma.eventActivity.findMany({
      where: {
        externalId: { in: activities.map((a) => a.externalId) },
      },
      select: { externalId: true },
    });

    const existingIds = new Set(existing.map((a) => a.externalId));
    const newActivities = activities.filter(
      (a) => !existingIds.has(a.externalId),
    );

    if (newActivities.length === 0) {
      this.logger.log('All Intervals.icu activities already imported');
      return 0;
    }

    await this.queueService.addActivityImportJobs(account, newActivities, true);
    return newActivities.length;
  }
}
