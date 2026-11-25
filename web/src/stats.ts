// Small, dependency-free statistics used by the dashboard.

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Median absolute deviation (unscaled). */
export function mad(xs: number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Percentile rank (0-100) of x among xs, mid-rank for ties. */
export function percentileRank(xs: number[], x: number): number {
  if (!xs.length) return NaN;
  let below = 0, equal = 0;
  for (const v of xs) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return (100 * (below + 0.5 * equal)) / xs.length;
}

/** log2 ratio anomaly with +1 smoothing (robust for zeros). */
export function log2Anomaly(x: number, med: number): number {
  return Math.log2((x + 1) / (med + 1));
}

/** Theil–Sen slope estimator. */
export function senSlope(t: number[], y: number[]): number {
  const s: number[] = [];
  for (let i = 0; i < y.length; i++)
    for (let j = i + 1; j < y.length; j++) if (t[j] !== t[i]) s.push((y[j] - y[i]) / (t[j] - t[i]));
  return median(s);
}

function normCdf(z: number): number {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const erf = 1 - (((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t) * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Mann–Kendall trend test with tie correction. Returns S, Z and two-sided p. */
export function mannKendall(y: number[]): { S: number; Z: number; p: number } {
  const n = y.length;
  let S = 0;
  for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) S += Math.sign(y[j] - y[i]);
  const counts = new Map<number, number>();
  for (const v of y) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tie = 0;
  for (const c of counts.values()) if (c > 1) tie += c * (c - 1) * (2 * c + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tie) / 18;
  const Z = varS > 0 ? (S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0) : 0;
  return { S, Z, p: 2 * (1 - normCdf(Math.abs(Z))) };
}

/**
 * Fire-season metrics from a 12-month climatology (Jan..Dec):
 * peak month, and the shortest circular window holding >= `share` of activity.
 */
export function fireSeason(clim: number[], share = 0.8): { peak: number; start: number; end: number; length: number } {
  const total = clim.reduce((a, b) => a + b, 0);
  const peak = clim.indexOf(Math.max(...clim));
  if (total <= 0) return { peak, start: peak, end: peak, length: 0 };
  for (let len = 1; len <= 12; len++) {
    let bestS = -1, bestSum = -1;
    for (let s = 0; s < 12; s++) {
      let sum = 0;
      for (let k = 0; k < len; k++) sum += clim[(s + k) % 12];
      if (sum >= share * total && sum > bestSum) {
        bestS = s;
        bestSum = sum;
      }
    }
    if (bestS >= 0) return { peak, start: bestS, end: (bestS + len - 1) % 12, length: len };
  }
  return { peak, start: 0, end: 11, length: 12 };
}
