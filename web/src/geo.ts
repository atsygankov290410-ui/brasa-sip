// Geometry helpers: AOI polygons, point-in-polygon, cell coverage.

export type LngLat = [number, number];

export type AOI =
  | { kind: 'region' }
  | { kind: 'polygon'; ring: LngLat[] }
  | { kind: 'circle'; center: LngLat; radiusKm: number };

export const GRID = 0.1;
const R_EARTH = 6371.0088;

/** Ray casting point-in-polygon on a closed or open ring. */
export function pointInRing(x: number, y: number, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Great-circle distance in km. */
export function haversineKm(a: LngLat, b: LngLat): number {
  const toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR;
  const dLon = (b[0] - a[0]) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

/** Polygon approximating a geodesic circle (for display and bbox). */
export function circleRing(center: LngLat, radiusKm: number, steps = 96): LngLat[] {
  const [lon0, lat0] = center.map((v) => (v * Math.PI) / 180);
  const d = radiusKm / R_EARTH;
  const ring: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const brg = (2 * Math.PI * i) / steps;
    const lat = Math.asin(Math.sin(lat0) * Math.cos(d) + Math.cos(lat0) * Math.sin(d) * Math.cos(brg));
    const lon = lon0 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat0), Math.cos(d) - Math.sin(lat0) * Math.sin(lat));
    ring.push([(lon * 180) / Math.PI, (lat * 180) / Math.PI]);
  }
  return ring;
}

export function aoiRing(aoi: AOI, regionBbox: [number, number, number, number]): LngLat[] {
  if (aoi.kind === 'polygon') return aoi.ring;
  if (aoi.kind === 'circle') return circleRing(aoi.center, aoi.radiusKm);
  const [w, s, e, n] = regionBbox;
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

export function bboxOf(ring: LngLat[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** Returns a predicate `(lon, lat) => boolean` for the AOI (null = everything). */
export function aoiTest(aoi: AOI): ((x: number, y: number) => boolean) | null {
  if (aoi.kind === 'region') return null;
  if (aoi.kind === 'circle') return (x, y) => haversineKm(aoi.center, [x, y]) <= aoi.radiusKm;
  const ring = aoi.ring;
  const [w, s, e, n] = bboxOf(ring);
  return (x, y) => x >= w && x <= e && y >= s && y <= n && pointInRing(x, y, ring);
}

export function cellIdToIJ(id: number): [number, number] {
  const ci = Math.floor(id / 3600) - 900;
  const cj = (id % 3600) - 1800;
  return [ci, cj];
}

/**
 * Fraction (0..1) of a GRID cell inside the AOI, estimated with a 4x4 sub-sample.
 * Analysis counts are area-weighted by this fraction, so any AOI shape works,
 * including AOIs smaller than one cell.
 */
export function cellFraction(ci: number, cj: number, test: (x: number, y: number) => boolean, n = 4): number {
  let k = 0;
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) if (test((cj + (b + 0.5) / n) * GRID, (ci + (a + 0.5) / n) * GRID)) k++;
  return k / (n * n);
}

/** Geodesic area of a ring in km² (spherical excess approximation). */
export function ringAreaKm2(ring: LngLat[]): number {
  const toR = Math.PI / 180;
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    area += (x2 - x1) * toR * (2 + Math.sin(y1 * toR) + Math.sin(y2 * toR));
  }
  return Math.abs((area * R_EARTH * R_EARTH) / 2);
}
