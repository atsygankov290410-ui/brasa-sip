// Live near-real-time detections straight from the NASA FIRMS Area API (CORS-enabled).
import { aoiTest, bboxOf, type AOI, type LngLat } from './geo';

export interface LiveResult {
  fc: GeoJSON.FeatureCollection;
  bySource: Record<string, number>;
  days: number;
  fetched: string;
}

const SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT'];
const KEY_STORE = 'brasa.firmsKey';

export function getKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) || import.meta.env.VITE_FIRMS_MAP_KEY || '';
  } catch {
    return import.meta.env.VITE_FIRMS_MAP_KEY || '';
  }
}

export function setKey(k: string) {
  try {
    if (k) localStorage.setItem(KEY_STORE, k);
    else localStorage.removeItem(KEY_STORE);
  } catch {
    /* storage unavailable */
  }
}

export function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !lines[0].includes('latitude')) return [];
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const v = l.split(',');
    const o: Record<string, string> = {};
    head.forEach((h, i) => (o[h] = v[i]));
    return o;
  });
}

export async function fetchLive(aoi: AOI, ring: LngLat[], key: string, days = 3): Promise<LiveResult> {
  const [w, s, e, n] = bboxOf(ring).map((v, i) => (i < 2 ? Math.floor(v * 100) / 100 : Math.ceil(v * 100) / 100));
  const test = aoiTest(aoi);
  const bySource: Record<string, number> = {};
  const features: GeoJSON.Feature[] = [];
  await Promise.all(SOURCES.map(async (src) => {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${src}/${w},${s},${e},${n}/${days}`;
    const r = await fetch(url);
    const text = await r.text();
    if (!r.ok || text.startsWith('Invalid')) throw new Error(text.slice(0, 120) || `HTTP ${r.status}`);
    const rows = parseCSV(text).filter((o) => !test || test(+o.longitude, +o.latitude));
    bySource[src] = rows.length;
    for (const o of rows)
      features.push({
        type: 'Feature',
        properties: { src, date: o.acq_date, time: o.acq_time, frp: +o.frp, conf: o.confidence, dn: o.daynight },
        geometry: { type: 'Point', coordinates: [+o.longitude, +o.latitude] },
      });
  }));
  return { fc: { type: 'FeatureCollection', features }, bySource, days, fetched: new Date().toISOString() };
}
