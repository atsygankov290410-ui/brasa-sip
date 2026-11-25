// Data loading and AOI aggregation for the precomputed harmonized grid.
import { aoiTest, cellFraction, cellIdToIJ, type AOI } from './geo';

const BASE = import.meta.env.BASE_URL + 'data/';

export interface UncBin { lo: number; hi: number | null; n: number; q05: number; q95: number }

export interface RegionInfo {
  id: string;
  name: string;
  label: Record<string, string>;
  bbox: [number, number, number, number];
}

export interface RegionMeta extends RegionInfo {
  last_date: string;
  ym0: number;
  ym_last: number;
  partial_day: number | null;
  eras: { aqua_start: number; viirs_start: number };
  viirs_eq_factor: number[];
  unc: { viirs: UncBin[]; terra: UncBin[] };
  incomplete: number[];
  fallback: Record<string, 'J1' | 'A'>;
  n_records: number;
  n_partial: number;
  points: Record<'MODIS' | 'VIIRS', Record<string, number>>;
  report: any;
}

export interface Cells {
  id: Uint32Array;
  H: Float32Array;
  ym: Uint16Array;
  T: Uint16Array;
  A: Uint16Array;
  N: Uint16Array;
  /** unique cell ids and [start, end) record ranges */
  uid: Uint32Array;
  start: Uint32Array;
  end: Uint32Array;
}

export interface Partial { id: Uint32Array; H: Float32Array; year: Uint16Array }

export interface Series {
  H: Float64Array; // harmonized (Aqua-MODIS equivalent)
  T: Float64Array; // Terra MODIS AFCD (raw, deduplicated)
  A: Float64Array; // Aqua MODIS AFCD
  N: Float64Array; // S-NPP VIIRS AFCD
  nCells: number;
  areaCells: number; // sum of fractions
}

export const NM = 12 * 32; // months indexed from 2000-01 up to 2031-12

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  let buf = await r.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    // gzip without Content-Encoding (some static hosts serve .gz as-is)
    const ds = new DecompressionStream('gzip');
    buf = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
  }
  return buf;
}

export async function loadRegions(): Promise<RegionInfo[]> {
  const r = await fetch(BASE + 'regions.json');
  return r.json();
}

export async function loadMeta(id: string): Promise<RegionMeta> {
  const r = await fetch(`${BASE}${id}/meta.json`);
  return r.json();
}

export async function loadCells(meta: RegionMeta): Promise<Cells> {
  const buf = await fetchBuffer(`${BASE}${meta.id}/cells.bin.gz`);
  const n = meta.n_records;
  const id = new Uint32Array(buf, 0, n);
  const H = new Float32Array(buf, 4 * n, n);
  const ym = new Uint16Array(buf, 8 * n, n);
  const T = new Uint16Array(buf, 10 * n, n);
  const A = new Uint16Array(buf, 12 * n, n);
  const N = new Uint16Array(buf, 14 * n, n);
  const uidL: number[] = [], st: number[] = [], en: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0 || id[i] !== id[i - 1]) {
      if (i) en.push(i);
      uidL.push(id[i]);
      st.push(i);
    }
  }
  if (n) en.push(n);
  return { id, H, ym, T, A, N, uid: Uint32Array.from(uidL), start: Uint32Array.from(st), end: Uint32Array.from(en) };
}

export async function loadPartial(meta: RegionMeta): Promise<Partial | null> {
  if (!meta.n_partial) return null;
  const buf = await fetchBuffer(`${BASE}${meta.id}/partial.bin.gz`);
  const n = meta.n_partial;
  return { id: new Uint32Array(buf, 0, n), H: new Float32Array(buf, 4 * n, n), year: new Uint16Array(buf, 8 * n, n) };
}

/** Per-cell AOI weights (fraction of each data cell inside the AOI). */
export function aoiWeights(cells: Cells, aoi: AOI): Map<number, number> {
  const w = new Map<number, number>();
  const test = aoiTest(aoi);
  for (let k = 0; k < cells.uid.length; k++) {
    const id = cells.uid[k];
    if (!test) {
      w.set(id, 1);
      continue;
    }
    const [ci, cj] = cellIdToIJ(id);
    const f = cellFraction(ci, cj, test);
    if (f > 0) w.set(id, f);
  }
  return w;
}

export function aggregate(cells: Cells, weights: Map<number, number>): Series {
  const s: Series = {
    H: new Float64Array(NM), T: new Float64Array(NM), A: new Float64Array(NM), N: new Float64Array(NM),
    nCells: 0, areaCells: 0,
  };
  for (let k = 0; k < cells.uid.length; k++) {
    const f = weights.get(cells.uid[k]);
    if (!f) continue;
    s.nCells++;
    s.areaCells += f;
    for (let i = cells.start[k]; i < cells.end[k]; i++) {
      const m = cells.ym[i];
      s.H[m] += f * cells.H[i];
      s.T[m] += f * cells.T[i];
      s.A[m] += f * cells.A[i];
      s.N[m] += f * cells.N[i];
    }
  }
  return s;
}

/** Same-days-of-month history for the latest (partial) month: year -> harmonized count. */
export function aggregatePartial(p: Partial, weights: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < p.id.length; i++) {
    const f = weights.get(p.id[i]);
    if (!f) continue;
    out.set(p.year[i], (out.get(p.year[i]) ?? 0) + f * p.H[i]);
  }
  return out;
}

/** Per-cell totals over a month range (for the map grid layer). */
export function cellTotals(cells: Cells, ymA: number, ymB: number, weights?: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (let k = 0; k < cells.uid.length; k++) {
    if (weights && !weights.has(cells.uid[k])) continue;
    let sum = 0;
    for (let i = cells.start[k]; i < cells.end[k]; i++) {
      const m = cells.ym[i];
      if (m >= ymA && m <= ymB) sum += cells.H[i];
    }
    if (sum > 0) out.set(cells.uid[k], sum);
  }
  return out;
}

// ---------------------------------------------------------------- raw hotspots
export interface Points {
  family: 'MODIS' | 'VIIRS';
  n: number;
  lat: Int32Array; lon: Int32Array; frp: Float32Array; bright: Float32Array;
  day: Uint16Array; time: Uint16Array; platform: Uint8Array; conf: Uint8Array;
  dn: Uint8Array; type: Uint8Array; flags: Uint8Array;
}

const pointCache = new Map<string, Promise<Points>>();

export function loadPoints(meta: RegionMeta, family: 'MODIS' | 'VIIRS', year: number): Promise<Points> {
  const key = `${meta.id}/${family}/${year}`;
  if (!pointCache.has(key)) {
    const n = meta.points[family][String(year)] ?? 0;
    pointCache.set(key, (async () => {
      if (!n) return emptyPoints(family);
      const buf = await fetchBuffer(`${BASE}${meta.id}/points/${family.toLowerCase()}_${year}.bin.gz`);
      return {
        family, n,
        lat: new Int32Array(buf, 0, n), lon: new Int32Array(buf, 4 * n, n),
        frp: new Float32Array(buf, 8 * n, n), bright: new Float32Array(buf, 12 * n, n),
        day: new Uint16Array(buf, 16 * n, n), time: new Uint16Array(buf, 18 * n, n),
        platform: new Uint8Array(buf, 20 * n, n), conf: new Uint8Array(buf, 21 * n, n),
        dn: new Uint8Array(buf, 22 * n, n), type: new Uint8Array(buf, 23 * n, n), flags: new Uint8Array(buf, 24 * n, n),
      };
    })());
  }
  return pointCache.get(key)!;
}

function emptyPoints(family: 'MODIS' | 'VIIRS'): Points {
  const z8 = new Uint8Array(0), z16 = new Uint16Array(0), zi = new Int32Array(0), zf = new Float32Array(0);
  return { family, n: 0, lat: zi, lon: zi, frp: zf, bright: zf, day: z16, time: z16, platform: z8, conf: z8, dn: z8, type: z8, flags: z8 };
}

export const DAY0 = Date.UTC(2000, 0, 1);
export const PLATFORM = ['Terra', 'Aqua', 'Suomi NPP', 'NOAA-20'];
export const TYPE = ['vegetation fire', 'active volcano', 'other static land source', 'offshore'];

export function dayToISO(d: number): string {
  return new Date(DAY0 + d * 86400000).toISOString().slice(0, 10);
}

export function confLabel(fam: 'MODIS' | 'VIIRS', c: number): string {
  if (fam === 'MODIS') return String(c);
  return ({ 1: 'l', 2: 'n', 3: 'h' } as Record<number, string>)[c] ?? '';
}

export function ymLabel(ym: number): string {
  const d = new Date(Date.UTC(2000 + Math.floor(ym / 12), ym % 12, 1));
  return d.toLocaleDateString('en-PH', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export const ym = (y: number, m: number) => (y - 2000) * 12 + (m - 1);
export const ymYear = (i: number) => 2000 + Math.floor(i / 12);
export const ymMonth = (i: number) => i % 12; // 0-based
