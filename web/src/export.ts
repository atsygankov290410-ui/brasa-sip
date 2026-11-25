// Downloads: hotspot CSV, monthly analytics CSV, calendar PNG/SVG, JSON report.
import type { Analysis } from './analysis';
import { confLabel, dayToISO, loadPoints, PLATFORM, TYPE, ymYear, type RegionMeta } from './data';
import { aoiTest, type AOI } from './geo';

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function hotspotsCSV(meta: RegionMeta, aoi: AOI, ymA: number, ymB: number, onProgress?: (p: string) => void): Promise<string> {
  const test = aoiTest(aoi);
  const header = ['latitude', 'longitude', 'acq_date', 'acq_time', 'satellite', 'instrument', 'confidence', 'frp_mw',
    'brightness_k', 'daynight', 'type', 'type_label', 'processing', 'used_in_harmonized_series'];
  const lines = [header.join(',')];
  const d0 = Date.UTC(2000 + Math.floor(ymA / 12), ymA % 12, 1);
  const d1 = Date.UTC(2000 + Math.floor((ymB + 1) / 12), (ymB + 1) % 12, 1);
  const dayA = Math.round((d0 - Date.UTC(2000, 0, 1)) / 86400000);
  const dayB = Math.round((d1 - Date.UTC(2000, 0, 1)) / 86400000);
  for (let y = ymYear(ymA); y <= ymYear(ymB); y++) {
    for (const fam of ['MODIS', 'VIIRS'] as const) {
      onProgress?.(`${fam} ${y}`);
      const p = await loadPoints(meta, fam, y);
      for (let i = 0; i < p.n; i++) {
        if (p.day[i] < dayA || p.day[i] >= dayB) continue;
        const lat = p.lat[i] / 1e5, lon = p.lon[i] / 1e5;
        if (test && !test(lon, lat)) continue;
        const flags = p.flags[i];
        const used = (flags & 2) && p.type[i] === 0 ? 1 : 0;
        lines.push([
          lat.toFixed(5), lon.toFixed(5), dayToISO(p.day[i]), String(p.time[i]).padStart(4, '0'),
          PLATFORM[p.platform[i]] ?? '', fam, confLabel(fam, p.conf[i]), p.frp[i].toFixed(1), p.bright[i].toFixed(1),
          p.dn[i] ? 'N' : 'D', p.type[i], TYPE[p.type[i]] ?? '', flags & 1 ? 'NRT' : 'SP', used,
        ].map(csvCell).join(','));
      }
    }
  }
  return lines.join('\n');
}

export function monthlyCSV(a: Analysis, units: string): string {
  const header = ['year', 'month', `harmonized_${units}_equivalent`, 'pi90_low', 'pi90_high', 'source_era', 'baseline_median',
    'anomaly_pct_vs_median', 'percentile_rank', 'robust_z', 'raw_terra_afcd', 'raw_aqua_afcd', 'raw_viirs_snpp_afcd', 'incomplete', 'partial_month'];
  const rows = a.cells.map((c) => [
    c.year, c.month + 1, c.value.toFixed(2), c.lo.toFixed(2), c.hi.toFixed(2), c.era, c.median.toFixed(2),
    c.median > 0 ? ((c.value / c.median - 1) * 100).toFixed(1) : '', c.pctRank.toFixed(1), c.robustZ.toFixed(2),
    c.raw.terra.toFixed(1), c.raw.aqua.toFixed(1), c.raw.viirs.toFixed(1), c.incomplete ? 1 : 0, c.partial ? 1 : 0,
  ].join(','));
  return [header.join(','), ...rows].join('\n');
}

/** Clone an SVG with CSS custom properties resolved so it renders standalone. */
export function standaloneSVG(svg: SVGSVGElement, title: string, subtitle: string): string {
  const cs = getComputedStyle(document.documentElement);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const vb = svg.viewBox.baseVal;
  const header = 46;
  clone.setAttribute('viewBox', `0 ${-header} ${vb.width} ${vb.height + header}`);
  clone.setAttribute('width', String(vb.width));
  clone.setAttribute('height', String(vb.height + header));
  const resolve = (v: string) => v.replace(/var\((--[\w-]+)\)/g, (_, name) => cs.getPropertyValue(name).trim() || '#888');
  clone.querySelectorAll<SVGElement>('*').forEach((el) => {
    for (const attr of ['fill', 'stroke']) {
      const v = el.getAttribute(attr);
      if (v && v.includes('var(')) el.setAttribute(attr, resolve(v));
    }
  });
  const bg = cs.getPropertyValue('--bg').trim() || '#fff';
  const fg = cs.getPropertyValue('--fg').trim() || '#111';
  const ns = 'http://www.w3.org/2000/svg';
  const style = document.createElementNS(ns, 'style');
  style.textContent = `text{font-family:Inter,system-ui,sans-serif;fill:${fg}} .axis-label{font-size:11px} .cell-label{font-size:10px;font-weight:600}`;
  clone.prepend(style);
  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x', '0'); rect.setAttribute('y', String(-header));
  rect.setAttribute('width', String(vb.width)); rect.setAttribute('height', String(vb.height + header));
  rect.setAttribute('fill', bg);
  clone.insertBefore(rect, style.nextSibling);
  for (const [txt, y, size, weight] of [[title, -header + 20, 16, 700], [subtitle, -header + 38, 11, 400]] as const) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', '12'); t.setAttribute('y', String(y));
    t.setAttribute('font-size', String(size)); t.setAttribute('font-weight', String(weight));
    t.textContent = txt;
    clone.insertBefore(t, rect.nextSibling);
  }
  // cell labels in the live DOM inherit fill from CSS when not set; keep them
  return new XMLSerializer().serializeToString(clone);
}

export async function svgToPNG(svgText: string, scale = 2): Promise<Blob> {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = rej;
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(url);
  return new Promise((res) => canvas.toBlob((b) => res(b!), 'image/png'));
}
