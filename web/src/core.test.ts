import { describe, expect, it } from 'vitest';
import { cellFraction, cellIdToIJ, circleRing, haversineKm, pointInRing, ringAreaKm2, type LngLat } from './geo';
import { fireSeason, log2Anomaly, mannKendall, median, percentileRank, quantile, senSlope } from './stats';

describe('stats', () => {
  it('median and quantile', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
  });
  it('percentile rank uses mid-rank for ties', () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(62.5);
    expect(percentileRank([5, 5, 5, 5], 5)).toBe(50);
  });
  it('log2 anomaly is 0 at the median and +1 at double', () => {
    expect(log2Anomaly(9, 9)).toBe(0);
    expect(log2Anomaly(19, 9)).toBeCloseTo(1);
  });
  it('Sen slope recovers a linear trend despite an outlier', () => {
    const t = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const y = t.map((v) => 2 * v + 1);
    y[4] = 100;
    expect(senSlope(t, y)).toBeCloseTo(2);
  });
  it('Mann-Kendall flags a monotonic series and not a flat one', () => {
    expect(mannKendall([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).p).toBeLessThan(0.001);
    expect(mannKendall([5, 5, 5, 5, 5, 5]).p).toBeCloseTo(1);
  });
  it('fire season wraps around the year end', () => {
    const clim = [30, 20, 5, 1, 1, 1, 1, 1, 2, 5, 15, 40];
    const s = fireSeason(clim);
    expect(s.peak).toBe(11);
    expect(s.start).toBe(10);
    expect(s.end).toBe(1);
  });
});

describe('geo', () => {
  const sq: LngLat[] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  it('point in polygon', () => {
    expect(pointInRing(0.5, 0.5, sq)).toBe(true);
    expect(pointInRing(1.5, 0.5, sq)).toBe(false);
  });
  it('haversine: 1 degree of latitude is ~111 km', () => {
    expect(haversineKm([0, 0], [0, 1])).toBeCloseTo(111.2, 0);
  });
  it('circle ring area matches pi r^2', () => {
    expect(ringAreaKm2(circleRing([-64, -31], 50, 256))).toBeCloseTo(Math.PI * 2500, -1);
  });
  it('cell ids round-trip', () => {
    const id = (-312 + 900) * 3600 + (-641 + 1800);
    expect(cellIdToIJ(id)).toEqual([-312, -641]);
  });
  it('cell fraction of a half-covering polygon is 0.5', () => {
    const half: LngLat[] = [[0, 0], [0.05, 0], [0.05, 0.1], [0, 0.1], [0, 0]];
    expect(cellFraction(0, 0, (x, y) => pointInRing(x, y, half))).toBeCloseTo(0.5);
  });
});
