import './style.css';
import { analyze, type Analysis, type Units } from './analysis';
import { drawCalendar } from './charts/calendar';
import { drawAnnual, drawSeasonal } from './charts/lines';
import { countScale, RAMPS } from './charts/scales';
import {
  aggregate, aggregatePartial, aoiWeights, cellTotals, loadCells, loadMeta, loadPartial, loadPoints, loadRegions,
  ym, ymLabel, ymMonth, ymYear, type Cells, type Partial, type RegionInfo, type RegionMeta, type Series,
} from './data';
import { download, hotspotsCSV, monthlyCSV, standaloneSVG, svgToPNG } from './export';
import { aoiRing, bboxOf, ringAreaKm2, type AOI, type LngLat } from './geo';
import { fmt, getLang, LOCALE, setLang, t, type Lang } from './i18n';
import { fetchLive, getKey, setKey } from './live';
import { FireMap, type Basemap } from './map';
import { summary } from './report';

interface State {
  region: string;
  aoi: AOI;
  from: number;
  to: number;
  baseline: [number, number];
  units: Units;
  view: 'counts' | 'anomaly';
  ramp: string;
  basemap: 'auto' | 'dark' | 'gibs';
  sel: number | null;
  lang: Lang;
  theme: 'light' | 'dark' | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let regions: RegionInfo[] = [];
let meta: RegionMeta;
let cells: Cells;
let partial: Partial | null = null;
let weights = new Map<number, number>();
let series: Series;
let analysis: Analysis;
let fmap: FireMap;
let showTable = false;
let pointsToken = 0;

const state: State = {
  region: 'philippines', aoi: { kind: 'region' }, from: 10, to: 0, baseline: [2003, 2022], units: 'modis',
  view: 'counts', ramp: 'inferno', basemap: 'auto', sel: null, lang: 'en', theme: null,
};

// ------------------------------------------------------------------ URL state
const ymStr = (i: number) => `${ymYear(i)}-${String(ymMonth(i) + 1).padStart(2, '0')}`;
const parseYm = (s: string) => {
  const [y, m] = s.split('-').map(Number);
  return y && m ? ym(y, m) : NaN;
};

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('r')) state.region = p.get('r')!;
  const a = p.get('aoi');
  if (a?.startsWith('c:')) {
    const [lon, lat, r] = a.slice(2).split(',').map(Number);
    if ([lon, lat, r].every(Number.isFinite)) state.aoi = { kind: 'circle', center: [lon, lat], radiusKm: r };
  } else if (a?.startsWith('p:')) {
    const ring = a.slice(2).split(';').map((s) => s.split(',').map(Number) as LngLat);
    if (ring.length >= 4 && ring.every((q) => q.every(Number.isFinite))) state.aoi = { kind: 'polygon', ring };
  }
  if (p.get('from')) state.from = parseYm(p.get('from')!);
  if (p.get('to')) state.to = parseYm(p.get('to')!);
  const b = p.get('b')?.split('-').map(Number);
  if (b?.length === 2 && b.every(Number.isFinite)) state.baseline = [b[0], b[1]];
  if (p.get('u') === 'viirs') state.units = 'viirs';
  if (p.get('v') === 'anomaly') state.view = 'anomaly';
  if (p.get('ramp') && RAMPS[p.get('ramp')!]) state.ramp = p.get('ramp')!;
  if (p.get('sel')) state.sel = parseYm(p.get('sel')!);
  const hl = p.get('lang');
  if (hl === 'fil' || hl === 'en') state.lang = hl as Lang;
}

function writeHash() {
  const p = new URLSearchParams();
  p.set('r', state.region);
  if (state.aoi.kind === 'circle') p.set('aoi', `c:${state.aoi.center.map((v) => v.toFixed(4)).join(',')},${state.aoi.radiusKm}`);
  if (state.aoi.kind === 'polygon') p.set('aoi', 'p:' + state.aoi.ring.map((q) => q.map((v) => v.toFixed(4)).join(',')).join(';'));
  p.set('from', ymStr(state.from));
  p.set('to', ymStr(state.to));
  p.set('b', state.baseline.join('-'));
  if (state.units !== 'modis') p.set('u', state.units);
  if (state.view !== 'counts') p.set('v', state.view);
  if (state.ramp !== 'inferno') p.set('ramp', state.ramp);
  if (state.sel !== null) p.set('sel', ymStr(state.sel));
  p.set('lang', state.lang);
  history.replaceState(null, '', '#' + p.toString());
}

// ------------------------------------------------------------------ i18n + theme
function applyLang() {
  setLang(state.lang);
  document.documentElement.lang = state.lang;
  const S = t() as unknown as Record<string, string>;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const v = S[el.dataset.i18n!];
    if (typeof v === 'string') el.textContent = v;
  });
  $('lang').textContent = t().language;
  $('theme').setAttribute('aria-label', t().theme);
  const sel = $<HTMLSelectElement>('region');
  sel.innerHTML = regions.map((r) => `<option value="${r.id}">${regionLabel(r)}</option>`).join('');
  sel.value = state.region;
}

function systemDark() {
  return matchMedia('(prefers-color-scheme: dark)').matches;
}
function isDark() {
  return state.theme ? state.theme === 'dark' : systemDark();
}
function applyTheme() {
  if (state.theme) document.documentElement.dataset.theme = state.theme;
  else delete document.documentElement.dataset.theme;
}
function effectiveBasemap(): Basemap {
  if (state.basemap === 'gibs') return 'gibs';
  if (state.basemap === 'dark') return 'dark';
  return isDark() ? 'dark' : 'light';
}

// ------------------------------------------------------------------ loading
const loading = (on: boolean) => ($('loading').hidden = !on);

async function loadRegion(id: string, keepAoi = false) {
  loading(true);
  const info = regions.find((r) => r.id === id) ?? regions[0];
  state.region = info.id;
  meta = await loadMeta(info.id);
  [cells, partial] = await Promise.all([loadCells(meta), loadPartial(meta)]);
  if (!keepAoi) state.aoi = { kind: 'region' };
  if (!Number.isFinite(state.from) || state.from < meta.ym0) state.from = meta.ym0;
  if (!state.to || !Number.isFinite(state.to) || state.to > meta.ym_last) state.to = meta.ym_last;
  if (state.sel !== null && (state.sel < meta.ym0 || state.sel > meta.ym_last)) state.sel = null;
  const minY = ymYear(meta.ym0), maxY = ymYear(meta.ym_last);
  for (const idb of ['from', 'to']) {
    const el = $<HTMLInputElement>(idb);
    el.min = ymStr(meta.ym0);
    el.max = ymStr(meta.ym_last);
  }
  for (const idb of ['b0', 'b1']) {
    const el = $<HTMLInputElement>(idb);
    el.min = String(minY);
    el.max = String(maxY);
  }
  fmap.fit(info.bbox);
  loading(false);
  updateAOI();
}

// ------------------------------------------------------------------ compute + render
/** Display name of a region in the active language, falling back to English. */
function regionLabel(r: RegionInfo): string {
  return r.label?.[state.lang] ?? r.label?.en ?? r.name;
}

function aoiName(): string {
  const S = t();
  const info = regions.find((r) => r.id === state.region);
  const label = info ? regionLabel(info) : meta.name;
  if (state.aoi.kind === 'region') return label;
  if (state.aoi.kind === 'circle')
    return `${state.aoi.radiusKm} km ${state.lang === 'fil' ? 'sa paligid ng' : 'around'} ${state.aoi.center[1].toFixed(3)}, ${state.aoi.center[0].toFixed(3)}`;
  return state.lang === 'fil'
    ? `ang piniling poligono (${S.area.toLowerCase()} ${fmt(ringAreaKm2(state.aoi.ring))} km²)`
    : `the selected polygon (${fmt(ringAreaKm2(state.aoi.ring))} km²)`;
}

function updateAOI() {
  weights = aoiWeights(cells, state.aoi);
  series = aggregate(cells, weights);
  const ring = aoiRing(state.aoi, meta.bbox);
  fmap.setAOI(state.aoi.kind === 'region' ? null : ring);
  if (state.aoi.kind !== 'region') fmap.fit(bboxOf(ring));
  const S = t();
  const area = state.aoi.kind === 'region' ? null : ringAreaKm2(ring);
  $('aoi-info').innerHTML = `${aoiName()}${area ? '' : ''} · ${fmt(series.areaCells, 1)} ${S.cells} (0.1°)`;
  document.querySelectorAll<HTMLButtonElement>('[data-aoi]').forEach((b) =>
    b.classList.toggle('active', (b.dataset.aoi === 'region' && state.aoi.kind === 'region') ||
      (b.dataset.aoi === 'point' && state.aoi.kind === 'circle') || ((b.dataset.aoi === 'polygon' || b.dataset.aoi === 'rect') && state.aoi.kind === 'polygon' && b.dataset.aoi === 'polygon')));
  if (state.aoi.kind === 'circle') {
    $<HTMLInputElement>('lat').value = state.aoi.center[1].toFixed(4);
    $<HTMLInputElement>('lon').value = state.aoi.center[0].toFixed(4);
    $<HTMLInputElement>('rad').value = String(state.aoi.radiusKm);
  }
  recompute();
}

function recompute() {
  const ph = partial ? aggregatePartial(partial, weights) : null;
  analysis = analyze(meta, series, { units: state.units, baseline: state.baseline, range: [state.from, state.to], partialHistory: ph });
  render();
}

function render() {
  if (!analysis) return;
  writeHash();
  syncControls();
  renderBadges();
  renderKPIs();
  drawCalendar($('calendar'), analysis, {
    view: state.view, ramp: state.ramp, selected: state.sel, tooltip: $('tooltip'),
    onSelect: (m) => {
      state.sel = m;
      render();
    },
  });
  if (showTable) renderTable();
  const selYear = state.sel !== null ? ymYear(state.sel) : ymYear(meta.ym_last);
  $('season-year').textContent = `· ${selYear}`;
  drawSeasonal($('seasonal'), analysis, selYear);
  drawAnnual($('annual'), analysis, $<HTMLInputElement>('raw-toggle').checked);
  $('summary').innerHTML = summary(analysis, aoiName(), state.units).map((s) => `<li>${s}</li>`).join('');
  renderMapLayers();
}

function syncControls() {
  $<HTMLInputElement>('from').value = ymStr(state.from);
  $<HTMLInputElement>('to').value = ymStr(state.to);
  $<HTMLInputElement>('b0').value = String(state.baseline[0]);
  $<HTMLInputElement>('b1').value = String(state.baseline[1]);
  $<HTMLSelectElement>('ramp').value = state.ramp;
  $<HTMLSelectElement>('basemap').value = state.basemap;
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
    b.setAttribute('aria-checked', String(b.dataset.view === state.view));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-units]').forEach((b) => {
    b.classList.toggle('active', b.dataset.units === state.units);
    b.setAttribute('aria-checked', String(b.dataset.units === state.units));
  });
}

function renderKPIs() {
  const S = t();
  const a = analysis;
  const tiles: string[] = [];
  tiles.push(tile(S.kpiTotal, fmt(a.total), `${ymLabel(Math.max(state.from, meta.ym0))} – ${ymLabel(Math.min(state.to, meta.ym_last))}`));
  if (a.current) {
    const c = a.current.cell;
    const med = c.partial && a.current.sameSpanMedian !== null ? a.current.sameSpanMedian : c.median;
    const low = c.value < 3 && med < 3;
    const p = !low && med > 0 ? Math.round((c.value / med - 1) * 100) : null;
    const cls = p === null ? '' : p > 25 ? 'up' : p < -25 ? 'down' : '';
    tiles.push(tile(S.kpiCurrent, low ? S.lowActivity : p === null ? fmt(c.value) : `${signed(p)}%`,
      `${S.monthsLong[c.month]} ${c.year}${c.partial ? ` (1–${a.current.days}, ${S.partial})` : ''}: ${fmt(c.value)} vs ${fmt(med)}`, cls));
  }
  if (a.peakYear) tiles.push(tile(S.kpiPeakYear, String(a.peakYear.year), fmt(a.peakYear.value)));
  const s = a.season;
  if (s.length) tiles.push(tile(S.kpiSeason, s.length < 12 ? `${S.months[s.start]}–${S.months[s.end]}` : '—', `${S.peak} ${S.monthsLong[s.peak]}`));
  if (a.trend) {
    const sig = a.trend.p < 0.05;
    tiles.push(tile(S.kpiTrend, `${signed(Math.round(a.trend.pctPerDecade))}%`,
      `${S.perDecade} · p=${a.trend.p.toFixed(2)} (${sig ? S.significant : S.notSignificant})`, sig ? (a.trend.pctPerDecade > 0 ? 'up' : 'down') : ''));
  }
  $('kpis').innerHTML = tiles.join('');
}

/** Signed number with a typographic minus, e.g. +12, −30. */
const signed = (v: number, digits = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), digits)}`;

/** Trust badges in the intro strip, read from the region's validation report. */
function renderBadges() {
  const S = t();
  const rep = meta.report ?? {};
  const val = rep.validation_viirs_loyo ?? {};
  const adopted = Object.entries(val).find(([k]) => k.includes('adopted'))?.[1] as { region_month?: { r2_log1p: number; bias_pct: number } } | undefined;
  const rm = adopted?.region_month;
  const info = regions.find((r) => r.id === state.region);
  const label = info ? regionLabel(info) : meta.name;
  const last = new Date(meta.last_date + 'T00:00:00Z').toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const items: string[] = [];
  if (rm) items.push(`<li class="badge ok"><b>R² ${rm.r2_log1p.toFixed(2)} · bias ${signed(rm.bias_pct, 1)} %</b><span>${S.badgeValidated} · ${label}</span></li>`);
  if (rep.n_detections) items.push(`<li class="badge"><b>${fmt(rep.n_detections)}</b><span>${S.badgeDetections} · ${label}</span></li>`);
  items.push(`<li class="badge"><b>${last}</b><span>${S.badgeThrough} · MODIS C6.1 + VIIRS 375 m</span></li>`);
  $('badges').innerHTML = items.join('');
}

const tile = (label: string, value: string, sub: string, cls = '') =>
  `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;

function renderTable() {
  const S = t();
  const a = analysis;
  const head = `<tr><th scope="col">${state.lang === 'fil' ? 'Taon' : 'Year'}</th>${S.months.map((m) => `<th scope="col">${m}</th>`).join('')}<th scope="col">Σ</th></tr>`;
  const rows = a.years.map((y) => {
    const tds = S.months.map((_, mo) => {
      const c = a.cells.find((x) => x.year === y && x.month === mo);
      if (!c) return '<td></td>';
      return `<td>${state.view === 'counts' ? fmt(c.value) : c.lowSignal ? '·' : `${c.anomaly >= 0 ? '+' : ''}${Math.round((Math.pow(2, c.anomaly) - 1) * 100)}%`}</td>`;
    }).join('');
    const an = a.annual.find((x) => x.year === y);
    return `<tr><th scope="row">${y}</th>${tds}<td><b>${an ? fmt(an.value) : ''}</b></td></tr>`;
  }).join('');
  $('cal-table').innerHTML = `<table><caption class="sr-only">${S.calendar}</caption><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

async function renderMapLayers() {
  const sel = state.sel ?? meta.ym_last;
  // grid: harmonized totals in the selected month (or the full period when nothing selected)
  const [a, b] = state.sel !== null ? [sel, sel] : [state.from, state.to];
  const totals = cellTotals(cells, a, b, state.aoi.kind === 'region' ? undefined : weights);
  let max = 1;
  for (const v of totals.values()) if (v > max) max = v;
  fmap.setGrid(totals, countScale(max, state.ramp));
  const S = t();
  $('map-legend').innerHTML = `<b>${S.mapShows}:</b> ${state.sel !== null ? `${S.monthsLong[ymMonth(sel)]} ${ymYear(sel)}` : `${ymStr(state.from)} – ${ymStr(state.to)}`}` +
    ` · <span class="dot grid"></span> ${S.value} (0.1°)` +
    (state.sel !== null ? ` · <span class="dot modis"></span> MODIS · <span class="dot viirs"></span> VIIRS` : '') +
    ` · <span class="dot live"></span> NRT`;

  const token = ++pointsToken;
  if (state.sel === null) {
    fmap.setPoints({ type: 'FeatureCollection', features: [] });
    return;
  }
  const year = ymYear(sel), mo = ymMonth(sel);
  const d0 = Math.round((Date.UTC(year, mo, 1) - Date.UTC(2000, 0, 1)) / 86400000);
  const d1 = Math.round((Date.UTC(year, mo + 1, 1) - Date.UTC(2000, 0, 1)) / 86400000);
  const ring = aoiRing(state.aoi, meta.bbox);
  const [w, s, e, n] = bboxOf(ring);
  const features: GeoJSON.Feature[] = [];
  // the harmonized series uses only one platform per era; show the platforms actually used
  const fams: ('MODIS' | 'VIIRS')[] = sel >= meta.eras.viirs_start ? ['VIIRS'] : sel >= 12 * 12 ? ['MODIS', 'VIIRS'] : ['MODIS'];
  for (const fam of fams) {
    const p = await loadPoints(meta, fam, year);
    if (token !== pointsToken) return;
    for (let i = 0; i < p.n; i++) {
      if (p.day[i] < d0 || p.day[i] >= d1 || p.type[i] !== 0 || !(p.flags[i] & 2)) continue;
      const lat = p.lat[i] / 1e5, lon = p.lon[i] / 1e5;
      if (lon < w || lon > e || lat < s || lat > n) continue;
      features.push({ type: 'Feature', properties: { f: fam, frp: p.frp[i] }, geometry: { type: 'Point', coordinates: [lon, lat] } });
    }
  }
  if (token === pointsToken) fmap.setPoints({ type: 'FeatureCollection', features });
  if (state.basemap === 'gibs') fmap.setGibsDate(`${year}-${String(mo + 1).padStart(2, '0')}-15`, 'gibs');
}

// ------------------------------------------------------------------ events
function bind() {
  $<HTMLSelectElement>('region').addEventListener('change', (e) => {
    state.sel = null;
    loadRegion((e.target as HTMLSelectElement).value);
  });
  $('lang').addEventListener('click', () => {
    state.lang = getLang() === 'en' ? 'fil' : 'en';
    applyLang();
    updateAOI();
  });
  $('theme').addEventListener('click', () => {
    state.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('brasa.theme', state.theme); } catch { /* ignore */ }
    applyTheme();
    fmap.setBasemap(effectiveBasemap());
    render();
  });
  const dlg = $<HTMLDialogElement>('license-dialog');
  const openLicense = () => {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  };
  $('license-btn').addEventListener('click', openLicense);
  $('license-link').addEventListener('click', openLicense);
  $('license-close').addEventListener('click', () => (typeof dlg.close === 'function' ? dlg.close() : dlg.removeAttribute('open')));
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-aoi]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.aoi!;
      const hint = $('aoi-hint');
      if (k === 'region') {
        state.aoi = { kind: 'region' };
        fmap.setMode('none');
        fmap.fit(meta.bbox);
        updateAOI();
        return;
      }
      fmap.setMode(k as 'polygon' | 'rect' | 'point');
      hint.hidden = false;
      hint.textContent = k === 'polygon' ? t().aoiHint : k === 'rect' ? t().aoiRectHint : t().aoiPointHint;
    }));
  fmap.onModeChange = (m) => {
    if (m === 'none') $('aoi-hint').hidden = true;
  };
  fmap.onAOI = (ring, point) => {
    if (point) {
      const r = Number($<HTMLInputElement>('rad').value) || 50;
      state.aoi = { kind: 'circle', center: point, radiusKm: r };
    } else if (ring) state.aoi = { kind: 'polygon', ring };
    updateAOI();
  };
  $('latlon').addEventListener('submit', (e) => {
    e.preventDefault();
    const lat = Number($<HTMLInputElement>('lat').value), lon = Number($<HTMLInputElement>('lon').value);
    const r = Number($<HTMLInputElement>('rad').value);
    if (![lat, lon, r].every(Number.isFinite)) return;
    state.aoi = { kind: 'circle', center: [lon, lat], radiusKm: Math.max(1, Math.min(1000, r)) };
    updateAOI();
  });
  $<HTMLInputElement>('geojson').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const gj = JSON.parse(await f.text());
      const geom = gj.type === 'FeatureCollection' ? gj.features[0]?.geometry : gj.type === 'Feature' ? gj.geometry : gj;
      const ring: LngLat[] | undefined = geom?.type === 'Polygon' ? geom.coordinates[0] : geom?.type === 'MultiPolygon'
        ? (geom.coordinates as LngLat[][][]).map((p) => p[0]).sort((x, y) => ringAreaKm2(y) - ringAreaKm2(x))[0] : undefined;
      if (!ring) throw new Error('Polygon geometry required');
      state.aoi = { kind: 'polygon', ring };
      updateAOI();
    } catch (err) {
      $('aoi-info').textContent = `GeoJSON: ${(err as Error).message}`;
    }
  });
  const range = () => {
    const a = parseYm($<HTMLInputElement>('from').value), b = parseYm($<HTMLInputElement>('to').value);
    if (Number.isFinite(a) && Number.isFinite(b) && a <= b) {
      state.from = Math.max(meta.ym0, a);
      state.to = Math.min(meta.ym_last, b);
      recompute();
    }
  };
  $('from').addEventListener('change', range);
  $('to').addEventListener('change', range);
  const base = () => {
    const a = Number($<HTMLInputElement>('b0').value), b = Number($<HTMLInputElement>('b1').value);
    if (a && b && a <= b) {
      state.baseline = [a, b];
      recompute();
    }
  };
  $('b0').addEventListener('change', base);
  $('b1').addEventListener('change', base);
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view as State['view'];
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-units]').forEach((b) => b.addEventListener('click', () => {
    state.units = b.dataset.units as Units;
    recompute();
  }));
  const ramp = $<HTMLSelectElement>('ramp');
  ramp.innerHTML = Object.entries(RAMPS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  ramp.addEventListener('change', () => {
    state.ramp = ramp.value;
    render();
  });
  $<HTMLSelectElement>('basemap').addEventListener('change', (e) => {
    state.basemap = (e.target as HTMLSelectElement).value as State['basemap'];
    fmap.setBasemap(effectiveBasemap());
  });
  $('raw-toggle').addEventListener('change', () => drawAnnual($('annual'), analysis, $<HTMLInputElement>('raw-toggle').checked));
  $('table-btn').addEventListener('click', () => {
    showTable = !showTable;
    $('cal-table').hidden = !showTable;
    $('table-btn').textContent = showTable ? t().hideTable : t().table;
    if (showTable) renderTable();
  });

  // downloads
  const stem = () => `brasa_${state.region}_${state.aoi.kind}_${ymStr(state.from)}_${ymStr(state.to)}`;
  const status = (s: string) => ($('dl-status').textContent = s);
  $('dl-hotspots').addEventListener('click', async () => {
    try {
      const csv = await hotspotsCSV(meta, state.aoi, state.from, state.to, (p) => status(`… ${p}`));
      download(`${stem()}_hotspots.csv`, csv, 'text/csv');
      status(`✓ ${fmt(csv.split('\n').length - 1)} hotspots`);
    } catch (e) {
      status(String(e));
    }
  });
  $('dl-monthly').addEventListener('click', () => download(`${stem()}_monthly.csv`, monthlyCSV(analysis, state.units), 'text/csv'));
  const svgText = () => standaloneSVG($('calendar').querySelector('svg')!, `${t().calendar} · ${aoiName()}`,
    `BRASA · NASA FIRMS MODIS C6.1 + VIIRS S-NPP 375 m · ${state.units === 'modis' ? t().unitsModis : t().unitsViirs} · ${t().baseline} ${state.baseline.join('–')}`);
  $('dl-svg').addEventListener('click', () => download(`${stem()}_calendar.svg`, svgText(), 'image/svg+xml'));
  $('dl-png').addEventListener('click', async () => download(`${stem()}_calendar.png`, await svgToPNG(svgText()), 'image/png'));
  $('dl-json').addEventListener('click', () => {
    const rep = {
      generated: new Date().toISOString(), tool: 'BRASA', region: meta.name, aoi: state.aoi, period: [ymStr(state.from), ymStr(state.to)],
      units: state.units === 'modis' ? 'Aqua-MODIS-equivalent active-fire cell-days' : 'VIIRS-S-NPP-equivalent active-fire cell-days',
      baseline: state.baseline, kpis: { total: analysis.total, season: analysis.season, trend: analysis.trend, peakYear: analysis.peakYear, current: analysis.current },
      summary: summary(analysis, aoiName(), state.units).map((s) => s.replace(/<[^>]+>/g, '')),
      monthly: analysis.cells, annual: analysis.annual, data_last_date: meta.last_date,
      project: 'Student Innovation Project (SIP) 2026-2027 · Tsygankov, Andrei · Living Stone International School · Grade 10-J',
    };
    download(`${stem()}_report.json`, JSON.stringify(rep, null, 2), 'application/json');
  });
  $('share').addEventListener('click', async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      status(t().copied);
    } catch {
      status(location.href);
    }
  });

  // live NRT
  const keyEl = $<HTMLInputElement>('mapkey');
  keyEl.value = getKey();
  keyEl.addEventListener('change', () => setKey(keyEl.value.trim()));
  $('live-btn').addEventListener('click', async () => {
    const key = keyEl.value.trim();
    const out = $('live-out');
    if (!key) {
      out.textContent = t().liveKeyHint;
      keyEl.focus();
      return;
    }
    setKey(key);
    out.textContent = '…';
    try {
      const r = await fetchLive(state.aoi, aoiRing(state.aoi, meta.bbox), key, 3);
      fmap.setLive(r.fc);
      const total = Object.values(r.bySource).reduce((x, y) => x + y, 0);
      out.innerHTML = total ? `<b>${fmt(total)}</b> NRT · ` + Object.entries(r.bySource).map(([k, v]) => `${k.replace('_NRT', '')}: ${fmt(v)}`).join(' · ') : t().liveNone;
    } catch (e) {
      out.textContent = `FIRMS: ${(e as Error).message}`;
    }
  });

  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = window.setTimeout(render, 200);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!state.theme) {
      fmap.setBasemap(effectiveBasemap());
      render();
    }
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    state.theme = (localStorage.getItem('brasa.theme') as State['theme']) || null;
  } catch { /* ignore */ }
  applyTheme();
  readHash();
  regions = await loadRegions();
  if (!regions.find((r) => r.id === state.region)) state.region = regions[0].id;
  applyLang();
  const info = regions.find((r) => r.id === state.region)!;
  fmap = new FireMap($('map'), info.bbox, effectiveBasemap());
  fmap.map.once('load', () => $('map-wrap').classList.remove('is-loading'));
  window.setTimeout(() => $('map-wrap').classList.remove('is-loading'), 20000); // never leave the placeholder stuck
  bind();
  // data loading does not wait for basemap tiles: layers are cached and installed on style load
  const keep = state.aoi.kind !== 'region';
  await loadRegion(state.region, keep);
}

boot().catch((e) => {
  console.error(e);
  $('loading').innerHTML = `⚠ ${String(e)}`;
});
