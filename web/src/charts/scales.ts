import * as d3 from 'd3';

export const RAMPS: Record<string, { label: string; fn: (t: number) => string }> = {
  // reversed so that more fire = darker, with light colours for low activity
  inferno: { label: 'Inferno (CVD-safe)', fn: (t) => d3.interpolateInferno(0.98 - 0.9 * t) },
  viridis: { label: 'Viridis (CVD-safe)', fn: (t) => d3.interpolateViridis(1 - t) },
  cividis: { label: 'Cividis (CVD-optimised)', fn: (t) => d3.interpolateCividis(1 - t) },
  ylorrd: { label: 'YlOrRd (ColorBrewer)', fn: (t) => d3.interpolateYlOrRd(0.08 + 0.92 * t) },
};

/** Sequential log scale for counts: 0 → empty colour, max → ramp end. */
export function countScale(max: number, ramp: string) {
  const fn = (RAMPS[ramp] ?? RAMPS.inferno).fn;
  const lmax = Math.log10(Math.max(max, 1) + 1);
  return (v: number) => (v <= 0 ? 'var(--cell-empty)' : fn(Math.min(1, Math.log10(v + 1) / lmax)));
}

/** Diverging scale for log2 anomalies, clipped at ±3 (= 8x above / below median).
 *  PuOr is colour-vision-deficiency safe; orange = more fire than usual. */
export function anomalyScale() {
  return (a: number) => d3.interpolatePuOr(0.5 - Math.max(-3, Math.min(3, a)) / 6);
}

export function textColor(bg: string): string {
  const c = d3.color(bg);
  if (!c) return 'currentColor';
  const { r, g, b } = c.rgb();
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? '#111' : '#fff';
}

export function compact(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n >= 10) return String(Math.round(n));
  if (n >= 1) return n.toFixed(0);
  if (n > 0) return '<1';
  return '';
}
