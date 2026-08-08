import {
  addDaysAnchor,
  dayRangeInstants,
  localDateTimeToInstant,
  normalizeTimeZone,
  startOfDayInstant,
  startOfMonthAnchor,
  startOfWeekAnchor,
  toDayAnchor,
} from './day-anchor';

const LA = 'America/Los_Angeles';

describe(`day anchors (process TZ=${process.env.TZ ?? 'system default'})`, () => {
  it.each([
    ['2026-01-15T07:59:59.999Z', '2026-01-14T00:00:00.000Z'],
    ['2026-01-15T08:00:00.000Z', '2026-01-15T00:00:00.000Z'],
    ['2026-07-15T06:59:59.999Z', '2026-07-14T00:00:00.000Z'],
    ['2026-07-15T07:00:00.000Z', '2026-07-15T00:00:00.000Z'],
  ])('maps an ordinary PST/PDT instant %s to %s', (instant, expected) => {
    expect(toDayAnchor(new Date(instant), LA).toISOString()).toBe(expected);
  });

  it.each([
    ['2026-03-08T09:30:00.000Z', '2026-03-08T00:00:00.000Z'],
    ['2026-03-08T10:30:00.000Z', '2026-03-08T00:00:00.000Z'],
    ['2026-03-09T06:59:59.999Z', '2026-03-08T00:00:00.000Z'],
    ['2026-11-01T08:30:00.000Z', '2026-11-01T00:00:00.000Z'],
    ['2026-11-01T09:30:00.000Z', '2026-11-01T00:00:00.000Z'],
    ['2026-11-02T07:30:00.000Z', '2026-11-01T00:00:00.000Z'],
  ])('maps transition instant %s to %s', (instant, expected) => {
    expect(toDayAnchor(new Date(instant), LA).toISOString()).toBe(expected);
  });

  it('builds a 23-hour spring-forward day range from consecutive anchors', () => {
    const range = dayRangeInstants(new Date('2026-03-08T00:00:00Z'), LA);
    expect(range.start.toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2026-03-09T07:00:00.000Z');
    expect(range.endExclusive.getTime() - range.start.getTime()).toBe(
      23 * 60 * 60 * 1000,
    );
  });

  it('builds a 25-hour fall-back day range from consecutive anchors', () => {
    const range = dayRangeInstants(new Date('2026-11-01T00:00:00Z'), LA);
    expect(range.start.toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(range.endExclusive.getTime() - range.start.getTime()).toBe(
      25 * 60 * 60 * 1000,
    );
  });

  it('returns the first real instant on a Santiago day with no local midnight', () => {
    // Santiago jumps from 23:59:59 to 01:00:00 on this transition. A start of
    // day at 01:00 local is correct: 00:00 never existed.
    expect(
      startOfDayInstant(
        new Date('2026-09-06T00:00:00Z'),
        'America/Santiago',
      ).toISOString(),
    ).toBe('2026-09-06T04:00:00.000Z');
  });

  it('chooses the earlier instant for an ambiguous repeated local time', () => {
    expect(
      localDateTimeToInstant(new Date('2026-11-01T00:00:00Z'), LA, {
        hour: 1,
        minute: 30,
      }).toISOString(),
    ).toBe('2026-11-01T08:30:00.000Z');
  });

  it('resolves a nonexistent local time forward across the DST gap', () => {
    expect(
      localDateTimeToInstant(new Date('2026-03-08T00:00:00Z'), LA, {
        hour: 2,
        minute: 30,
      }).toISOString(),
    ).toBe('2026-03-08T10:30:00.000Z');
  });

  it('keeps anchor arithmetic pure UTC', () => {
    const sunday = new Date('2026-03-08T00:00:00Z');
    expect(addDaysAnchor(sunday, 1).toISOString()).toBe(
      '2026-03-09T00:00:00.000Z',
    );
    expect(startOfWeekAnchor(sunday).toISOString()).toBe(
      '2026-03-02T00:00:00.000Z',
    );
    expect(startOfMonthAnchor(sunday).toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );
  });

  it('falls back to UTC when an athlete has no valid timezone', () => {
    expect(normalizeTimeZone(null)).toBe('UTC');
    expect(normalizeTimeZone('Not/AZone')).toBe('UTC');
    expect(
      toDayAnchor(new Date('2026-03-08T23:00:00Z'), 'Not/AZone').toISOString(),
    ).toBe('2026-03-08T00:00:00.000Z');
  });
});
