// Seasonal profile and annual totals charts.
import * as d3 from 'd3';
import type { Analysis } from '../analysis';
import { fmt, t } from '../i18n';

function frame(el: HTMLElement, label: string, height = 260) {
  el.innerHTML = '';
  const width = Math.max(320, el.clientWidth || 600);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('width', '100%')
    .attr('role', 'img').attr('aria-label', label).attr('xmlns', 'http://www.w3.org/2000/svg');
  return { svg, width, height };
}

export function drawSeasonal(el: HTMLElement, a: Analysis, year: number) {
  const S = t();
  const { svg, width, height } = frame(el, S.seasonal);
  const m = { top: 16, right: 16, bottom: 46, left: 52 };
  const x = d3.scaleBand<number>().domain(d3.range(12)).range([m.left, width - m.right]).padding(0.1);
  const yearVals = d3.range(12).map((mo) => a.cells.find((c) => c.year === year && c.month === mo));
  const ymax = d3.max([...a.q75, ...yearVals.map((c) => c?.hi ?? 0)].filter(Number.isFinite)) || 1;
  const y = d3.scaleLinear().domain([0, ymax * 1.08]).nice().range([height - m.bottom, m.top]);
  const cx = (i: number) => (x(i) ?? 0) + x.bandwidth() / 2;

  svg.append('g').attr('transform', `translate(0,${height - m.bottom})`).attr('class', 'axis')
    .call(d3.axisBottom(x).tickFormat((i) => S.months[i]));
  svg.append('g').attr('transform', `translate(${m.left},0)`).attr('class', 'axis')
    .call(d3.axisLeft(y).ticks(5).tickFormat((v) => d3.format('~s')(v as number)));

  // season window shading
  const s = a.season;
  if (s.length && s.length < 12) {
    const months = d3.range(s.length).map((k) => (s.start + k) % 12);
    for (const mo of months)
      svg.append('rect').attr('x', x(mo)!).attr('y', m.top).attr('width', x.bandwidth()).attr('height', height - m.bottom - m.top)
        .attr('fill', 'var(--season-band)');
  }
  const area = d3.area<number>().x((i) => cx(i)).y0((i) => y(a.q25[i] || 0)).y1((i) => y(a.q75[i] || 0)).curve(d3.curveMonotoneX);
  svg.append('path').datum(d3.range(12)).attr('d', area).attr('fill', 'var(--band)');
  const line = d3.line<number>().x((i) => cx(i)).y((i) => y(a.climatology[i] || 0)).curve(d3.curveMonotoneX);
  svg.append('path').datum(d3.range(12)).attr('d', line).attr('fill', 'none').attr('stroke', 'var(--fg-muted)').attr('stroke-width', 2).attr('stroke-dasharray', '5 3');

  const pts = yearVals.map((c, i) => ({ c, i })).filter((d) => d.c);
  svg.selectAll('line.pi').data(pts).join('line').attr('x1', (d) => cx(d.i)).attr('x2', (d) => cx(d.i))
    .attr('y1', (d) => y(d.c!.lo)).attr('y2', (d) => y(d.c!.hi)).attr('stroke', 'var(--accent)').attr('stroke-opacity', 0.45).attr('stroke-width', 5);
  svg.append('path').datum(pts).attr('fill', 'none').attr('stroke', 'var(--accent)').attr('stroke-width', 2.5)
    .attr('d', d3.line<{ c: any; i: number }>().x((d) => cx(d.i)).y((d) => y(d.c.value)));
  svg.selectAll('circle.pt').data(pts).join('circle').attr('cx', (d) => cx(d.i)).attr('cy', (d) => y(d.c!.value)).attr('r', 3.5)
    .attr('fill', 'var(--accent)').append('title').text((d) => `${S.monthsLong[d.i]} ${year}: ${fmt(d.c!.value)} (${S.median} ${fmt(a.climatology[d.i])})`);

  const lg = svg.append('g').attr('transform', `translate(${m.left},${height - 12})`).attr('class', 'axis-label');
  lg.append('line').attr('x1', 0).attr('x2', 18).attr('y1', -4).attr('y2', -4).attr('stroke', 'var(--accent)').attr('stroke-width', 2.5);
  lg.append('text').attr('x', 22).attr('y', 0).text(String(year));
  lg.append('line').attr('x1', 70).attr('x2', 88).attr('y1', -4).attr('y2', -4).attr('stroke', 'var(--fg-muted)').attr('stroke-width', 2).attr('stroke-dasharray', '5 3');
  lg.append('text').attr('x', 92).attr('y', 0).text(`${S.median} ${a.baseline[0]}–${a.baseline[1]} (IQR)`);
}

export function drawAnnual(el: HTMLElement, a: Analysis, showRaw: boolean) {
  const S = t();
  const { svg, width, height } = frame(el, S.annual, 280);
  const m = { top: 16, right: 16, bottom: 48, left: 56 };
  const data = a.annual;
  const x = d3.scaleBand<number>().domain(data.map((d) => d.year)).range([m.left, width - m.right]).padding(0.15);
  const ymax = d3.max(data, (d) => Math.max(d.value, showRaw ? Math.max(d.aqua + d.terra, d.viirs) : 0)) || 1;
  const y = d3.scaleLinear().domain([0, ymax * 1.05]).nice().range([height - m.bottom, m.top]);
  const every = Math.ceil(data.length / Math.max(4, Math.floor(width / 48)));
  svg.append('g').attr('transform', `translate(0,${height - m.bottom})`).attr('class', 'axis')
    .call(d3.axisBottom(x).tickValues(data.map((d) => d.year).filter((_, i) => i % every === 0)));
  svg.append('g').attr('transform', `translate(${m.left},0)`).attr('class', 'axis')
    .call(d3.axisLeft(y).ticks(5).tickFormat((v) => d3.format('~s')(v as number)));

  svg.selectAll('rect.bar').data(data).join('rect').attr('x', (d) => x(d.year)!).attr('width', x.bandwidth())
    .attr('y', (d) => y(d.value)).attr('height', (d) => y(0) - y(d.value))
    .attr('fill', 'var(--bar)').attr('opacity', (d) => (d.complete ? 1 : 0.5))
    .append('title').text((d) => `${d.year}: ${fmt(d.value)}${d.complete ? '' : ' *'}`);

  if (a.trend && a.trend.p < 0.1) {
    const full = data.filter((d) => d.complete);
    const medY = d3.median(full, (d) => d.value) ?? 0;
    const medT = d3.median(full, (d) => d.year) ?? 0;
    const slope = a.trend.slopePerDecade / 10;
    const [t0, t1] = a.trend.years;
    svg.append('line').attr('x1', x(t0)! + x.bandwidth() / 2).attr('x2', x(t1)! + x.bandwidth() / 2)
      .attr('y1', y(Math.max(0, medY + slope * (t0 - medT)))).attr('y2', y(Math.max(0, medY + slope * (t1 - medT))))
      .attr('stroke', 'var(--fg)').attr('stroke-width', 1.5).attr('stroke-dasharray', '6 4');
  }

  if (showRaw) {
    const cx = (yr: number) => x(yr)! + x.bandwidth() / 2;
    const modis = data.filter((d) => d.aqua + d.terra > 0);
    const viirs = data.filter((d) => d.viirs > 0);
    svg.append('path').datum(modis).attr('fill', 'none').attr('stroke', 'var(--raw-modis)').attr('stroke-width', 2)
      .attr('d', d3.line<typeof data[0]>().x((d) => cx(d.year)).y((d) => y(d.aqua)));
    svg.append('path').datum(viirs).attr('fill', 'none').attr('stroke', 'var(--raw-viirs)').attr('stroke-width', 2)
      .attr('d', d3.line<typeof data[0]>().x((d) => cx(d.year)).y((d) => y(d.viirs)));
  }
  const lg = svg.append('g').attr('transform', `translate(${m.left},${height - 10})`).attr('class', 'axis-label');
  lg.append('rect').attr('x', 0).attr('y', -9).attr('width', 12).attr('height', 9).attr('fill', 'var(--bar)');
  lg.append('text').attr('x', 16).attr('y', 0).text(S.value);
  if (showRaw) {
    lg.append('line').attr('x1', 100).attr('x2', 118).attr('y1', -4).attr('y2', -4).attr('stroke', 'var(--raw-modis)').attr('stroke-width', 2);
    lg.append('text').attr('x', 122).attr('y', 0).text('Aqua MODIS raw');
    lg.append('line').attr('x1', 230).attr('x2', 248).attr('y1', -4).attr('y2', -4).attr('stroke', 'var(--raw-viirs)').attr('stroke-width', 2);
    lg.append('text').attr('x', 252).attr('y', 0).text('VIIRS S-NPP raw');
  }
}
