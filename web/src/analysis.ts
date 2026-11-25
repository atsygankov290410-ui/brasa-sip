// Turns an AOI series into calendar cells, anomalies, KPIs and uncertainty.
import type { RegionMeta, Series, UncBin } from './data';
import { ymMonth, ymYear } from './data';
import { fireSeason, log2Anomaly, mad, mannKendall, median, percentileRank, senSlope } from './stats';

export type Units = 'modis' | 'viirs';
export type Era = 'terra' | 'aqua' | 'viirs';

export interface MonthCell {
  ym: number;
  year: number;
  month: number; // 0-11
  value: number; // harmonized, in chosen units
  lo: number; // 90 % prediction interval
  hi: number;
  era: Era;
  raw: { terra: number; aqua: number; viirs: number };
  median: number; // baseline median for this calendar month
  anomaly: number; // log2((v+1)/(med+1))
  pctRank: number; // percentile among baseline years
  robustZ: number;
  incomplete: boolean;
  partial: boolean; // current month, data only up to partial_day
  lowSignal: boolean; // both value and median < 3
  source: 'T' | 'A' | 'N' | 'J1'; // platform actually used for this month
}

export interface Analysis {
  cells: MonthCell[];
  years: number[];
  annual: { year: number; value: number; terra: number; aqua: number; viirs: number; complete: boolean }[];
  climatology: number[]; // median per calendar month over baseline years
  q25: number[];
  q75: number[];
  season: ReturnType<typeof fireSeason>;
  trend: { slopePerDecade: number; pctPerDecade: number; p: number; Z: number; years: [number, number] } | null;
  peakYear: { year: number; value: number } | null;
  peakMonth: MonthCell | null;
  total: number;
  current: {
    cell: MonthCell;
    sameSpanMedian: number | null; // for partial months: median of same days in past years
    sameSpanRank: number | null;
    days: number | null;
  } | null;
  baseline: [number, number];
}

function bin(bins: UncBin[], v: number): UncBin | null {
  for (const b of bins) if (v >= b.lo && (b.hi === null || v < b.hi)) return b;
  return bins.length ? bins[bins.length - 1] : null;
}

export function eraOf(meta: RegionMeta, ym: number): Era {
  if (ym < meta.eras.aqua_start) return 'terra';
  if (ym < meta.eras.viirs_start) return 'aqua';
  return 'viirs';
}

export function analyze(
  meta: RegionMeta,
  s: Series,
  opts: { units: Units; baseline: [number, number]; range: [number, number]; partialHistory?: Map<number, number> | null },
): Analysis {
  const { units, baseline, range } = opts;
  const factor = (m: number) => (units === 'viirs' ? meta.viirs_eq_factor[m] : 1);
  const incomplete = new Set(meta.incomplete);
  const first = Math.max(meta.ym0, range[0]);
  const last = Math.min(meta.ym_last, range[1]);

  // baseline values per calendar month (full record, independent of the display range)
  const byMonth: number[][] = Array.from({ length: 12 }, () => []);
  for (let ym = meta.ym0; ym <= meta.ym_last; ym++) {
    const y = ymYear(ym);
    if (y < baseline[0] || y > baseline[1] || incomplete.has(ym)) continue;
    if (ym === meta.ym_last && meta.partial_day) continue;
    byMonth[ymMonth(ym)].push(s.H[ym] * factor(ymMonth(ym)));
  }
  const climatology = byMonth.map((v) => median(v));
  const q25 = byMonth.map((v) => (v.length ? quant(v, 0.25) : NaN));
  const q75 = byMonth.map((v) => (v.length ? quant(v, 0.75) : NaN));

  const cells: MonthCell[] = [];
  for (let ym = first; ym <= last; ym++) {
    const m = ymMonth(ym);
    const year = ymYear(ym);
    const era = eraOf(meta, ym);
    const v = s.H[ym] * factor(m);
    let lo = v, hi = v;
    if (era !== 'aqua') {
      const b = bin(era === 'viirs' ? meta.unc.viirs : meta.unc.terra, s.H[ym]);
      if (b) {
        lo = Math.max(0, (s.H[ym] + 0.5) * b.q05 - 0.5) * factor(m);
        hi = ((s.H[ym] + 0.5) * b.q95 - 0.5) * factor(m);
      }
    }
    // leave-one-out baseline: exclude the target year so a month is not compared with itself
    const base = byMonth[m].length && year >= baseline[0] && year <= baseline[1] ? dropOnce(byMonth[m], v) : byMonth[m];
    const med = median(base);
    const md = mad(base);
    cells.push({
      ym, year, month: m, value: v, lo, hi: Math.max(hi, v), era,
      raw: { terra: s.T[ym], aqua: s.A[ym], viirs: s.N[ym] },
      median: med,
      anomaly: log2Anomaly(v, med),
      pctRank: percentileRank(base, v),
      robustZ: md > 0 ? (v - med) / (1.4826 * md) : 0,
      incomplete: incomplete.has(ym),
      partial: ym === meta.ym_last && !!meta.partial_day,
      lowSignal: v < 3 && med < 3,
      source: era === 'terra' ? 'T' : era === 'aqua' ? 'A' : (meta.fallback?.[String(ym)] ?? 'N'),
    });
  }

  const years = [...new Set(cells.map((c) => c.year))];
  const annual = years.map((year) => {
    const cs = cells.filter((c) => c.year === year);
    return {
      year,
      value: sum(cs.map((c) => c.value)),
      terra: sum(cs.map((c) => c.raw.terra)),
      aqua: sum(cs.map((c) => c.raw.aqua)),
      viirs: sum(cs.map((c) => c.raw.viirs)),
      complete: cs.length === 12 && !cs.some((c) => c.partial),
    };
  });
  const full = annual.filter((a) => a.complete);
  let trend: Analysis['trend'] = null;
  if (full.length >= 8) {
    const t = full.map((a) => a.year);
    const y = full.map((a) => a.value);
    const slope = senSlope(t, y);
    const mk = mannKendall(y);
    const med = median(y);
    trend = { slopePerDecade: slope * 10, pctPerDecade: med > 0 ? (slope * 10 * 100) / med : 0, p: mk.p, Z: mk.Z, years: [t[0], t[t.length - 1]] };
  }
  const peakYear = full.length ? full.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const peakMonth = cells.length ? cells.reduce((a, b) => (b.value > a.value ? b : a)) : null;

  let current: Analysis['current'] = null;
  const lastCell = cells.find((c) => c.ym === meta.ym_last);
  if (lastCell) {
    let sameSpanMedian: number | null = null, sameSpanRank: number | null = null;
    if (lastCell.partial && opts.partialHistory) {
      const hist: number[] = [];
      for (let y = baseline[0]; y <= baseline[1]; y++) {
        if (y === lastCell.year) continue;
        const ymY = (y - 2000) * 12 + lastCell.month;
        if (ymY < meta.ym0 || incomplete.has(ymY)) continue;
        hist.push((opts.partialHistory.get(y) ?? 0) * factor(lastCell.month));
      }
      if (hist.length) {
        sameSpanMedian = median(hist);
        sameSpanRank = percentileRank(hist, lastCell.value);
      }
    }
    current = { cell: lastCell, sameSpanMedian, sameSpanRank, days: lastCell.partial ? meta.partial_day : null };
  }

  return {
    cells, years, annual, climatology, q25, q75,
    season: fireSeason(climatology.map((v) => (Number.isFinite(v) ? v : 0))),
    trend, peakYear: peakYear ? { year: peakYear.year, value: peakYear.value } : null, peakMonth,
    total: sum(cells.map((c) => c.value)),
    current, baseline,
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function quant(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b);
  const p = (s.length - 1) * q;
  const lo = Math.floor(p);
  return s[lo] + (s[Math.ceil(p)] - s[lo]) * (p - lo);
}

function dropOnce(xs: number[], v: number): number[] {
  const i = xs.findIndex((x) => Math.abs(x - v) < 1e-9);
  if (i < 0) return xs;
  return [...xs.slice(0, i), ...xs.slice(i + 1)];
}
