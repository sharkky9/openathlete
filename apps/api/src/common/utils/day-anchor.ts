const UTC_TIME_ZONE = 'UTC';
const DAY_MS = 24 * 60 * 60 * 1000;

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // `hour12: false` selects h24 in some runtimes and renders midnight as 24.
    hourCycle: 'h23',
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(0);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** Unknown athlete zones deliberately preserve the historical UTC behaviour. */
export function normalizeTimeZone(timeZone?: string | null): string {
  const candidate = timeZone?.trim();
  return candidate && isValidTimeZone(candidate) ? candidate : UTC_TIME_ZONE;
}

function localDateTimeAt(instant: Date, timeZone: string): LocalDateTime {
  const values = new Map(
    formatterFor(timeZone)
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    year: values.get('year')!,
    month: values.get('month')!,
    day: values.get('day')!,
    hour: values.get('hour')!,
    minute: values.get('minute')!,
    second: values.get('second')!,
    millisecond: instant.getUTCMilliseconds(),
  };
}

function asUtcTimestamp(value: LocalDateTime): number {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
    value.millisecond,
  );
}

function offsetAt(instant: Date, timeZone: string): number {
  return asUtcTimestamp(localDateTimeAt(instant, timeZone)) - instant.getTime();
}

function sameLocalDateTime(a: LocalDateTime, b: LocalDateTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second &&
    a.millisecond === b.millisecond
  );
}

/**
 * Encode the calendar date containing an instant as midnight UTC.
 *
 * The returned Date is a date label, not the instant at which the local day
 * began. Once an instant crosses this boundary, all date arithmetic can remain
 * in UTC and is therefore independent of both DST and the server process zone.
 */
export function toDayAnchor(instant: Date, timeZone: string): Date {
  const local = localDateTimeAt(instant, normalizeTimeZone(timeZone));
  return new Date(Date.UTC(local.year, local.month - 1, local.day));
}

export function addDaysAnchor(anchor: Date, days: number): Date {
  const result = new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth(),
      anchor.getUTCDate(),
    ),
  );
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/** Monday at the start of the anchor's ISO week. */
export function startOfWeekAnchor(anchor: Date): Date {
  const normalized = addDaysAnchor(anchor, 0);
  const daysSinceMonday = (normalized.getUTCDay() + 6) % 7;
  return addDaysAnchor(normalized, -daysSinceMonday);
}

export function startOfMonthAnchor(anchor: Date): Date {
  return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
}

/**
 * Interpret local calendar components in an IANA timezone.
 *
 * Offset resolution is intentionally performed twice: the offset at the
 * provisional UTC instant can differ from the offset at the resolved instant
 * when a transition is nearby. Offsets on either side are also considered so
 * an ambiguous repeated time deterministically chooses the earlier instant.
 * A nonexistent wall time resolves forward across the gap, matching the
 * conventional "compatible" behaviour used by calendar APIs.
 */
export function localDateTimeToInstant(
  anchor: Date,
  timeZone: string,
  time: {
    hour?: number;
    minute?: number;
    second?: number;
    millisecond?: number;
  } = {},
): Date {
  const zone = normalizeTimeZone(timeZone);
  const desired: LocalDateTime = {
    year: anchor.getUTCFullYear(),
    month: anchor.getUTCMonth() + 1,
    day: anchor.getUTCDate(),
    hour: time.hour ?? 0,
    minute: time.minute ?? 0,
    second: time.second ?? 0,
    millisecond: time.millisecond ?? 0,
  };
  const provisionalTimestamp = asUtcTimestamp(desired);
  const provisional = new Date(provisionalTimestamp);

  const offsets = new Set<number>([
    offsetAt(provisional, zone),
    offsetAt(new Date(provisionalTimestamp - 2 * DAY_MS), zone),
    offsetAt(new Date(provisionalTimestamp + 2 * DAY_MS), zone),
  ]);

  // The second pass catches a candidate that crossed the transition relative
  // to the provisional instant. The neighbouring samples catch both sides of
  // a repeated hour so the earlier occurrence can be chosen deliberately.
  for (const offset of [...offsets]) {
    const candidate = new Date(provisionalTimestamp - offset);
    offsets.add(offsetAt(candidate, zone));
    offsets.add(offsetAt(new Date(candidate.getTime() - DAY_MS), zone));
    offsets.add(offsetAt(new Date(candidate.getTime() + DAY_MS), zone));
  }

  const candidates = [...offsets].map(
    (offset) => new Date(provisionalTimestamp - offset),
  );
  const exact = candidates
    .filter((candidate) =>
      sameLocalDateTime(localDateTimeAt(candidate, zone), desired),
    )
    .sort((a, b) => a.getTime() - b.getTime());

  if (exact.length > 0) return exact[0];

  // The requested local time is in a DST gap. Pick the candidate that lands
  // closest after it in wall-clock time (e.g. 00:00 -> 01:00 in Santiago).
  const afterGap = candidates
    .map((candidate) => ({
      candidate,
      wallDelta:
        asUtcTimestamp(localDateTimeAt(candidate, zone)) - provisionalTimestamp,
    }))
    .filter(({ wallDelta }) => wallDelta >= 0)
    .sort(
      (a, b) =>
        a.wallDelta - b.wallDelta ||
        a.candidate.getTime() - b.candidate.getTime(),
    );

  if (afterGap.length > 0) return afterGap[0].candidate;

  // This is reachable only for pathological historical timezone changes where
  // an entire local date did not exist. Returning the latest candidate keeps
  // the result deterministic while avoiding process-timezone behaviour.
  return candidates.sort((a, b) => b.getTime() - a.getTime())[0];
}

export function startOfDayInstant(anchor: Date, timeZone: string): Date {
  return localDateTimeToInstant(anchor, timeZone);
}

export function dayRangeInstants(
  anchor: Date,
  timeZone: string,
): { start: Date; endExclusive: Date } {
  return {
    start: startOfDayInstant(anchor, timeZone),
    endExclusive: startOfDayInstant(addDaysAnchor(anchor, 1), timeZone),
  };
}
