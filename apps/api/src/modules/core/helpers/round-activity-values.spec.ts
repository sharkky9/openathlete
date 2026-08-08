import { roundDistance, roundPower, roundSpeed } from './round-activity-values';

describe('activity value rounding', () => {
  it('rounds finite values at the precision required by each field', () => {
    expect(roundDistance(2347.2000000000003)).toBe(2347.2);
    expect(roundSpeed(3.1415926)).toBe(3.142);
    expect(roundPower(249.96)).toBe(250);
  });

  it('uses zero for invalid required values', () => {
    expect(roundDistance(Number.NaN)).toBe(0);
    expect(roundDistance(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('uses null for invalid optional values, including schema-breaking strings', () => {
    expect(roundSpeed(Number.NaN)).toBeNull();
    expect(roundPower(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(roundSpeed('NaN')).toBeNull();
  });
});
