// Burning activity calendar: years (rows) x months (columns) heatmap.
import * as d3 from 'd3';
import type { Analysis, MonthCell } from '../analysis';
import { fmt, t } from '../i18n';
import { anomalyScale, compact, countScale, textColor } from './scales';

export interface CalendarOpts {
  view: 'counts' | 'anomaly';
  ramp: string;
  selected: number | null;
  onSelect: (ym: number) => void;
  tooltip: HTMLElement;
}

const ERA_COLOR = { terra: 'var(--era-terra)', aqua: 'var(--era-aqua)', viirs: 'var(--era-viirs)' };

export function drawCalendar(el: HTMLElement, a: Analysis, o: CalendarOpts) {
  const S = t();
  el.innerHTML = '';
  if (!a.cells.length) {
    el.textContent = S.noData;
    return;
  }
  const years = a.years;
  const width = Math.max(560, el.clientWidth || 800);
  const m = { top: 26, right: 74, bottom: 40, left: 58 };
  const cw = (width - m.left - m.right) / 12;
  const ch = Math.max(14, Math.min(26, cw * 0.42));
  const height = m.top + m.bottom + ch * (years.length + 1) + 8;

  const svg = d3.select(el).append('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('width', '100%')
    .attr('role', 'grid')
    .attr('aria-label', S.calendar)
    .attr('class', 'calendar-svg')
    .attr('xmlns', 'http://www.w3.org/2000/svg');

  const defs = svg.append('defs');
  defs.append('pattern').attr('id', 'hatch').attr('patternUnits', 'userSpaceOnUse').attr('width', 6).attr('height', 6)
    .attr('patternTransform', 'rotate(45)')
    .append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6).attr('stroke', 'var(--hatch)').attr('stroke-width', 2);

  const max = d3.max(a.cells, (c) => c.value) ?? 1;
  const seq = countScale(max, o.ramp);
  const div = anomalyScale();
  const fill = (c: MonthCell) => (o.view === 'counts' ? seq(c.value) : c.lowSignal ? 'var(--cell-empty)' : div(c.anomaly));

  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const y = (yr: number) => years.indexOf(yr) * ch;

  // month header
  g.selectAll('text.mh').data(S.months).join('text').attr('class', 'axis-label')
    .attr('x', (_, i) => i * cw + cw / 2).attr('y', -9).attr('text-anchor', 'middle').text((d) => d);
  g.append('text').attr('class', 'axis-label').attr('x', 12 * cw + 8).attr('y', -9).text('Σ');

  // era strip + year labels
  const rows = g.selectAll('g.row').data(years).join('g').attr('class', 'row').attr('transform', (d) => `translate(0,${y(d)})`);
  rows.append('text').attr('class', 'axis-label').attr('x', -16).attr('y', ch / 2 + 4).attr('text-anchor', 'end').text((d) => d);
  for (const c of a.cells) {
    g.append('rect').attr('x', -11).attr('y', y(c.year) + (c.month * ch) / 12).attr('width', 6).attr('height', ch / 12 + 0.3)
      .attr('fill', ERA_COLOR[c.era]);
  }

  // cells
  const cellG = g.append('g').attr('class', 'cells');
  const sel = cellG.selectAll<SVGGElement, MonthCell>('g.cell').data(a.cells, (d) => d.ym).join('g')
    .attr('class', 'cell')
    .attr('role', 'gridcell')
    .attr('tabindex', (d) => (d.ym === (o.selected ?? a.cells[a.cells.length - 1].ym) ? 0 : -1))
    .attr('aria-label', (d) => `${S.monthsLong[d.month]} ${d.year}: ${fmt(d.value)} (${S.median} ${fmt(d.median)})`)
    .attr('transform', (d) => `translate(${d.month * cw},${y(d.year)})`);

  sel.append('rect').attr('width', cw - 1.5).attr('height', ch - 1.5).attr('rx', 2).attr('fill', fill);
  sel.filter((d) => d.incomplete).append('rect').attr('width', cw - 1.5).attr('height', ch - 1.5).attr('fill', 'url(#hatch)');
  sel.filter((d) => d.era !== 'aqua' && d.value >= 3 && (d.hi - d.lo) / d.value > 1)
    .append('circle').attr('cx', cw - 6).attr('cy', 5).attr('r', 2).attr('fill', 'var(--uncertain-dot)');
  sel.filter((d) => d.partial).append('rect').attr('width', cw - 1.5).attr('height', ch - 1.5).attr('rx', 2)
    .attr('fill', 'none').attr('stroke', 'var(--fg)').attr('stroke-dasharray', '3 2').attr('stroke-width', 1.5);
  if (cw > 34) {
    sel.append('text').attr('x', (cw - 1.5) / 2).attr('y', ch / 2 + 3.5).attr('text-anchor', 'middle').attr('class', 'cell-label')
      .attr('fill', (d) => textColor(fill(d).startsWith('var') ? '#ffffff' : fill(d)))
      .text((d) => (o.view === 'counts' ? compact(d.value) : d.lowSignal ? '' : `${d.anomaly >= 0 ? '+' : ''}${Math.round((Math.pow(2, d.anomaly) - 1) * 100)}%`));
  }
  sel.filter((d) => d.ym === o.selected).append('rect').attr('x', -1).attr('y', -1).attr('width', cw + 0.5).attr('height', ch + 0.5)
    .attr('rx', 3).attr('fill', 'none').attr('stroke', 'var(--accent)').attr('stroke-width', 2.5);

  // annual totals column
  const amax = d3.max(a.annual, (d) => d.value) ?? 1;
  const aScale = countScale(amax, o.ramp);
  rows.each(function (yr) {
    const an = a.annual.find((d) => d.year === yr);
    if (!an) return;
    const r = d3.select(this);
    r.append('rect').attr('x', 12 * cw + 6).attr('width', m.right - 12).attr('height', ch - 1.5).attr('rx', 2)
      .attr('fill', aScale(an.value)).attr('opacity', an.complete ? 1 : 0.55);
    r.append('text').attr('x', 12 * cw + 6 + (m.right - 12) / 2).attr('y', ch / 2 + 3.5).attr('text-anchor', 'middle')
      .attr('class', 'cell-label').attr('fill', textColor(aScale(an.value))).text(compact(an.value) + (an.complete ? '' : '*'));
  });

  // median row
  const my = years.length * ch + 6;
  g.append('text').attr('class', 'axis-label').attr('x', -16).attr('y', my + ch / 2 + 4).attr('text-anchor', 'end').text(S.median);
  a.climatology.forEach((v, i) => {
    const col = seq(v);
    g.append('rect').attr('x', i * cw).attr('y', my).attr('width', cw - 1.5).attr('height', ch - 1.5).attr('rx', 2)
      .attr('fill', col).attr('stroke', 'var(--fg-muted)').attr('stroke-width', 0.6);
    if (cw > 34) g.append('text').attr('x', i * cw + (cw - 1.5) / 2).attr('y', my + ch / 2 + 3.5).attr('text-anchor', 'middle')
      .attr('class', 'cell-label').attr('fill', textColor(col.startsWith('var') ? '#ffffff' : col)).text(compact(v));
  });

  // legend
  const lg = svg.append('g').attr('transform', `translate(${m.left},${height - 16})`);
  const lw = Math.min(260, width * 0.35);
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const tt = i / (steps - 1);
    const colr = o.view === 'counts' ? seq(Math.pow(10, tt * Math.log10(max + 1)) - 1 || 0.01) : div(3 - 6 * tt);
    lg.append('rect').attr('x', (i * lw) / steps).attr('y', -8).attr('width', lw / steps + 0.5).attr('height', 8).attr('fill', colr);
  }
  if (o.view === 'counts') {
    lg.append('text').attr('class', 'axis-label').attr('x', 0).attr('y', 10).text('0');
    lg.append('text').attr('class', 'axis-label').attr('x', lw).attr('y', 10).attr('text-anchor', 'end').text(compact(max) + ' (log)');
  } else {
    lg.append('text').attr('class', 'axis-label').attr('x', 0).attr('y', 10).text('8× ' + S.higher);
    lg.append('text').attr('class', 'axis-label').attr('x', lw / 2).attr('y', 10).attr('text-anchor', 'middle').text(S.median);
    lg.append('text').attr('class', 'axis-label').attr('x', lw).attr('y', 10).attr('text-anchor', 'end').text('8× ' + S.lower);
  }
  const eras: [string, string][] = [[S.eraTerra, ERA_COLOR.terra], [S.eraAqua, ERA_COLOR.aqua], [S.eraViirs, ERA_COLOR.viirs]];
  let ex = lw + 24;
  for (const [label, col] of eras) {
    lg.append('rect').attr('x', ex).attr('y', -8).attr('width', 8).attr('height', 8).attr('fill', col);
    const tx = lg.append('text').attr('class', 'axis-label').attr('x', ex + 12).attr('y', 0).text(label);
    ex += 18 + (tx.node()?.getComputedTextLength?.() || label.length * 6);
  }

  // interaction
  const tip = o.tooltip;
  sel.on('mouseenter', (ev: MouseEvent, d) => showTip(tip, ev, d, o.view))
    .on('mousemove', (ev: MouseEvent) => moveTip(tip, ev))
    .on('mouseleave', () => (tip.hidden = true))
    .on('click', (_, d) => o.onSelect(d.ym))
    .on('keydown', (ev: KeyboardEvent, d) => {
      const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -12, ArrowDown: 12 };
      if (ev.key in moves) {
        ev.preventDefault();
        const target = a.cells.find((c) => c.ym === d.ym + moves[ev.key]);
        if (target) {
          o.onSelect(target.ym);
          requestAnimationFrame(() => (el.querySelector(`[tabindex="0"]`) as SVGElement | null)?.focus());
        }
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        o.onSelect(d.ym);
      }
    })
    .on('focus', function (_, d) {
      const r = (this as SVGGElement).getBoundingClientRect();
      showTip(tip, { clientX: r.right, clientY: r.top } as MouseEvent, d, o.view);
    })
    .on('blur', () => (tip.hidden = true));
}

function showTip(tip: HTMLElement, ev: MouseEvent, d: MonthCell, view: string) {
  const S = t();
  const eraLabel = d.source === 'J1' ? S.eraNoaa20 : d.source === 'A' && d.era === 'viirs' ? S.eraAquaFallback
    : d.era === 'terra' ? S.eraTerra : d.era === 'aqua' ? S.eraAqua : S.eraViirs;
  const pct = d.median > 0 ? Math.round((d.value / d.median - 1) * 100) : null;
  tip.innerHTML = `
    <strong>${S.monthsLong[d.month]} ${d.year}</strong>${d.partial ? ` <em>(${S.partial})</em>` : ''}<br>
    ${S.value}: <b>${fmt(d.value)}</b>${d.era !== 'aqua' ? ` <span class="muted">(${S.interval} ${fmt(d.lo)}–${fmt(d.hi)})</span>` : ''}<br>
    ${S.median}: ${fmt(d.median)}${pct !== null && !d.lowSignal ? ` → ${pct >= 0 ? '+' : ''}${pct}%` : ''} · ${S.percentile} ${fmt(d.pctRank)}<br>
    <span class="muted">${eraLabel}</span><br>
    <span class="muted">${S.rawCounts}: Terra ${fmt(d.raw.terra)} · Aqua ${fmt(d.raw.aqua)} · VIIRS ${fmt(d.raw.viirs)}${d.source === 'J1' ? ' (NOAA-20)' : ''}</span>
    ${d.incomplete ? `<br><span class="warn">⚠ ${S.incomplete}</span>` : ''}
    ${view === 'anomaly' && d.lowSignal ? `<br><span class="muted">${S.normal}</span>` : ''}`;
  tip.hidden = false;
  moveTip(tip, ev);
}

function moveTip(tip: HTMLElement, ev: MouseEvent) {
  const pad = 14;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
