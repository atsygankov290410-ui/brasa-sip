// Auto-generated plain-language situation summary (English / Filipino).
import type { Analysis } from './analysis';
import { fmt, getLang, t } from './i18n';

const pct = (v: number, m: number) => (m > 0 ? Math.round((v / m - 1) * 100) : null);

export function summary(a: Analysis, aoiName: string, units: string): string[] {
  const S = t();
  const fil = getLang() === 'fil';
  const out: string[] = [];
  const u = units === 'viirs' ? (fil ? 'katumbas ng VIIRS' : 'VIIRS-equivalent') : (fil ? 'katumbas ng Aqua-MODIS' : 'Aqua-MODIS-equivalent');
  if (!a.cells.length) return [S.noData];

  const c = a.current;
  if (c) {
    const cell = c.cell;
    const name = `${S.monthsLong[cell.month]} ${cell.year}`;
    const refMed = cell.partial && c.sameSpanMedian !== null ? c.sameSpanMedian : cell.median;
    if (cell.value < 3 && refMed < 3) {
      out.push(fil
        ? `<b>${name}${cell.partial ? ` (mga araw 1–${c.days})` : ''}</b>: mababang aktibidad (${fmt(cell.value)} hotspot; median sa kasaysayan ${fmt(refMed)}), karaniwan para sa panahong ito ng taon sa ${aoiName}.`
        : `<b>${name}${cell.partial ? ` (days 1–${c.days})` : ''}</b>: low activity (${fmt(cell.value)} hotspots; historical median ${fmt(refMed)}), typical for this time of year in ${aoiName}.`);
    } else if (cell.partial && c.sameSpanMedian !== null) {
      const p = pct(cell.value, c.sameSpanMedian);
      const lvl = classify(c.sameSpanRank ?? 50, fil);
      out.push(fil
        ? `<b>${name} (mga araw 1–${c.days})</b>: ${fmt(cell.value)} ${u} hotspot sa ${aoiName}, kumpara sa median na ${fmt(c.sameSpanMedian)} para sa parehong mga araw noong ${a.baseline[0]}–${a.baseline[1]}${p !== null ? ` (${p >= 0 ? '+' : ''}${p} %)` : ''}. Ang aktibidad ay <b>${lvl}</b> (percentile ${fmt(c.sameSpanRank ?? NaN)}).`
        : `<b>${name} (days 1–${c.days})</b>: ${fmt(cell.value)} ${u} hotspots in ${aoiName}, vs a median of ${fmt(c.sameSpanMedian)} for the same days in ${a.baseline[0]}–${a.baseline[1]}${p !== null ? ` (${p >= 0 ? '+' : ''}${p}%)` : ''}. Activity is <b>${lvl}</b> (percentile ${fmt(c.sameSpanRank ?? NaN)}).`);
    } else {
      const p = pct(cell.value, cell.median);
      const lvl = classify(cell.pctRank, fil);
      out.push(fil
        ? `<b>${name}</b>: ${fmt(cell.value)} ${u} hotspot (90 % interval ${fmt(cell.lo)}–${fmt(cell.hi)}) kumpara sa median sa kasaysayan na ${fmt(cell.median)}${p !== null ? ` (${p >= 0 ? '+' : ''}${p} %)` : ''}: ang aktibidad ay <b>${lvl}</b>.`
        : `<b>${name}</b>: ${fmt(cell.value)} ${u} hotspots (90% interval ${fmt(cell.lo)}–${fmt(cell.hi)}) vs a historical median of ${fmt(cell.median)}${p !== null ? ` (${p >= 0 ? '+' : ''}${p}%)` : ''}: activity is <b>${lvl}</b>.`);
    }
  }

  const s = a.season;
  if (s.length && s.length < 12) {
    const span = `${S.monthsLong[s.start]}–${S.monthsLong[s.end]}`;
    out.push(fil
      ? `Ang karaniwang season ng sunog ay <b>${span}</b> (${s.length} buwan ang may 80 % ng aktibidad), pinakamataas sa <b>${S.monthsLong[s.peak]}</b>.`
      : `The typical fire season runs <b>${span}</b> (${s.length} months hold 80% of activity), peaking in <b>${S.monthsLong[s.peak]}</b>.`);
    // upcoming critical period
    if (c) {
      const next = (c.cell.month + 1) % 12;
      const inSeason = (mo: number) => (s.start <= s.end ? mo >= s.start && mo <= s.end : mo >= s.start || mo <= s.end);
      if (inSeason(next) && !inSeason(c.cell.month))
        out.push(fil ? `⚠ Ang <b>${S.monthsLong[next]}</b> ang simula ng kritikal na panahon.` : `⚠ <b>${S.monthsLong[next]}</b> marks the start of the critical period.`);
      else if (inSeason(next))
        out.push(fil ? `Ang ${S.monthsLong[next]} ay nasa loob ng season ng sunog (median ${fmt(a.climatology[next])}).` : `${S.monthsLong[next]} is within the fire season (median ${fmt(a.climatology[next])}).`);
    }
  }

  if (a.peakYear) {
    const top = [...a.annual].filter((d) => d.complete).sort((x, y) => y.value - x.value).slice(0, 3);
    out.push(fil
      ? `Pinakaaktibong mga taon: ${top.map((d) => `<b>${d.year}</b> (${fmt(d.value)})`).join(', ')}.`
      : `Most active years: ${top.map((d) => `<b>${d.year}</b> (${fmt(d.value)})`).join(', ')}.`);
  }
  if (a.trend) {
    const sig = a.trend.p < 0.05;
    const dir = a.trend.slopePerDecade > 0 ? (fil ? 'pagtaas' : 'increase') : (fil ? 'pagbaba' : 'decrease');
    out.push(fil
      ? `Trend ${a.trend.years[0]}–${a.trend.years[1]}: ${dir} na ${fmt(Math.abs(a.trend.pctPerDecade))} % kada dekada (Mann–Kendall p = ${a.trend.p.toFixed(3)}, ${sig ? 'makabuluhan' : 'hindi makabuluhan'}).`
      : `Trend ${a.trend.years[0]}–${a.trend.years[1]}: ${dir} of ${fmt(Math.abs(a.trend.pctPerDecade))}% per decade (Mann–Kendall p = ${a.trend.p.toFixed(3)}, ${sig ? 'significant' : 'not significant'}).`);
  }
  const anomalous = a.cells.filter((x) => !x.lowSignal && x.pctRank >= 95 && x.value > 2 * x.median && x.median >= 3).slice(-3);
  if (anomalous.length)
    out.push((fil ? 'Pinakahuling buwang pambihirang mataas (≥ 2× ang median): ' : 'Latest exceptionally high months (≥ 2× median): ') +
      anomalous.map((x) => `${S.months[x.month]} ${x.year} (${fmt(x.value)}, ${fil ? 'median' : 'median'} ${fmt(x.median)})`).join('; ') + '.');
  return out;
}

function classify(rank: number, fil: boolean): string {
  if (rank >= 90) return fil ? 'lubhang higit sa normal' : 'well above normal';
  if (rank >= 67) return fil ? 'higit sa normal' : 'above normal';
  if (rank > 33) return fil ? 'malapit sa normal' : 'near normal';
  if (rank > 10) return fil ? 'mas mababa sa normal' : 'below normal';
  return fil ? 'lubhang mas mababa sa normal' : 'well below normal';
}
