// MapLibre map: basemaps (incl. NASA GIBS), AOI drawing, grid and hotspot layers.
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MLMap, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

maplibregl.setWorkerUrl(workerUrl);
import { cellIdToIJ, GRID, type LngLat } from './geo';

export type Basemap = 'light' | 'dark' | 'gibs';
export type DrawMode = 'none' | 'polygon' | 'rect' | 'point';

function gibsStyle(date: string): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      gibs: {
        type: 'raster',
        tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`],
        tileSize: 256,
        maxzoom: 9,
        attribution: 'Imagery: <a href="https://earthdata.nasa.gov/gibs" target="_blank">NASA GIBS</a> / VIIRS S-NPP',
      },
      labels: {
        type: 'raster',
        tiles: ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Reference_Labels_15m/default/default/GoogleMapsCompatible_Level13/{z}/{y}/{x}.png'],
        tileSize: 256,
        maxzoom: 13,
      },
    },
    layers: [
      { id: 'gibs', type: 'raster', source: 'gibs' },
      { id: 'labels', type: 'raster', source: 'labels' },
    ],
  };
}

export class FireMap {
  map: MLMap;
  private mode: DrawMode = 'none';
  private verts: LngLat[] = [];
  private ready: Promise<void>;
  private cache: Record<string, GeoJSON.FeatureCollection> = {};
  onAOI: (ring: LngLat[] | null, point?: LngLat) => void = () => {};
  onModeChange: (m: DrawMode) => void = () => {};
  gibsDate = '2023-01-15';

  constructor(container: HTMLElement, bbox: [number, number, number, number], basemap: Basemap) {
    this.map = new maplibregl.Map({
      container,
      style: this.styleFor(basemap),
      bounds: [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
      fitBoundsOptions: { padding: 20 },
      attributionControl: { compact: true, customAttribution: 'Fire data: NASA FIRMS' },
      doubleClickZoom: false,
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    this.ready = new Promise((res) => this.map.once('load', () => res()));
    this.map.on('style.load', () => this.installLayers());
    this.bindDrawing();
  }

  private styleFor(b: Basemap): string | StyleSpecification {
    if (b === 'gibs') return gibsStyle(this.gibsDate);
    return b === 'dark' ? 'https://tiles.openfreemap.org/styles/dark' : 'https://tiles.openfreemap.org/styles/positron';
  }

  setBasemap(b: Basemap) {
    this.map.setStyle(this.styleFor(b));
  }

  setGibsDate(date: string, basemap: Basemap) {
    this.gibsDate = date;
    if (basemap === 'gibs') this.setBasemap('gibs');
  }

  private installLayers() {
    const m = this.map;
    if (m.getLayer('grid-fill')) return;
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    for (const id of ['grid', 'aoi', 'draft', 'points', 'live'])
      if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: this.cache[id] ?? empty });
    m.addLayer({
      id: 'grid-fill', type: 'fill', source: 'grid',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.78, 9, 0.35] },
    });
    m.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#2b8cff', 'fill-opacity': 0.06 } });
    m.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#2b8cff', 'line-width': 2.5 } });
    m.addLayer({
      id: 'points', type: 'circle', source: 'points',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 8, 3.5, 12, 6],
        'circle-color': ['match', ['get', 'f'], 'MODIS', '#ffb000', '#ff3d00'],
        'circle-stroke-color': '#2a0a00', 'circle-stroke-width': 0.4, 'circle-opacity': 0.9,
      },
    });
    m.addLayer({
      id: 'live', type: 'circle', source: 'live',
      paint: { 'circle-radius': 5, 'circle-color': '#ff00aa', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2 },
    });
    m.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#2b8cff', 'line-width': 2, 'line-dasharray': [2, 1] } });
    m.addLayer({ id: 'draft-pt', type: 'circle', source: 'draft', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#2b8cff' } });
  }

  private set(id: string, fc: GeoJSON.FeatureCollection) {
    this.cache[id] = fc;
    const src = this.map.getSource(id) as GeoJSONSource | undefined;
    if (src) src.setData(fc);
  }

  async whenReady() {
    await this.ready;
  }

  fit(bbox: [number, number, number, number]) {
    this.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 30, duration: 600 });
  }

  setAOI(ring: LngLat[] | null) {
    this.set('aoi', { type: 'FeatureCollection', features: ring ? [poly(ring)] : [] });
  }

  setGrid(totals: Map<number, number>, color: (v: number) => string) {
    const features: GeoJSON.Feature[] = [];
    for (const [id, v] of totals) {
      const [ci, cj] = cellIdToIJ(id);
      const s = ci * GRID, w = cj * GRID;
      features.push({
        type: 'Feature', properties: { v, color: color(v) },
        geometry: { type: 'Polygon', coordinates: [[[w, s], [w + GRID, s], [w + GRID, s + GRID], [w, s + GRID], [w, s]]] },
      });
    }
    this.set('grid', { type: 'FeatureCollection', features });
  }

  setPoints(fc: GeoJSON.FeatureCollection) {
    this.set('points', fc);
  }

  setLive(fc: GeoJSON.FeatureCollection) {
    this.set('live', fc);
  }

  setMode(mode: DrawMode) {
    this.mode = mode;
    this.verts = [];
    this.set('draft', { type: 'FeatureCollection', features: [] });
    this.map.getCanvas().style.cursor = mode === 'none' ? '' : 'crosshair';
    this.onModeChange(mode);
  }

  private bindDrawing() {
    const m = this.map;
    m.on('click', (e) => {
      if (this.mode === 'none') return;
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (this.mode === 'point') {
        this.onAOI(null, p);
        this.setMode('none');
        return;
      }
      this.verts.push(p);
      if (this.mode === 'rect' && this.verts.length === 2) {
        const [[x1, y1], [x2, y2]] = this.verts;
        const ring: LngLat[] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
        this.setMode('none');
        this.onAOI(ring);
        return;
      }
      this.drawDraft();
    });
    m.on('mousemove', (e) => {
      if (this.mode === 'none' || !this.verts.length) return;
      this.drawDraft([e.lngLat.lng, e.lngLat.lat]);
    });
    m.on('dblclick', (e) => {
      if (this.mode !== 'polygon') return;
      e.preventDefault();
      this.finishPolygon();
    });
    window.addEventListener('keydown', (e) => {
      if (this.mode === 'none') return;
      if (e.key === 'Escape') this.setMode('none');
      if (e.key === 'Enter' && this.mode === 'polygon') this.finishPolygon();
    });
  }

  private finishPolygon() {
    // a dblclick also fires two clicks: drop the duplicated last vertex
    const v = this.verts.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-6);
    if (v.length >= 3) {
      const ring = [...v, v[0]];
      this.setMode('none');
      this.onAOI(ring);
    }
  }

  private drawDraft(cursor?: LngLat) {
    const v = cursor ? [...this.verts, cursor] : this.verts;
    let line: LngLat[] = v;
    if (this.mode === 'rect' && v.length === 2) {
      const [[x1, y1], [x2, y2]] = v;
      line = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
    } else if (this.mode === 'polygon' && v.length > 2) line = [...v, v[0]];
    this.set('draft', {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } },
        ...this.verts.map((p) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: p } })),
      ],
    });
  }
}

function poly(ring: LngLat[]): GeoJSON.Feature {
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}
