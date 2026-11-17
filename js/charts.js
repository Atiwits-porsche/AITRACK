/* Tiny dependency-free SVG charts. Colors are CSS custom properties so light/dark themes swap in one place. */
(function (root) {
  'use strict';
  const U = root.AIUtils;
  const esc = U.escapeHTML;

  /** Bar with 4px rounded top corners, square at the baseline. */
  function barPath(x, y, w, h, r) {
    if (h <= 0) return '';
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  /** Axis scale with round steps (1, 2 or 5 × 10^n) so tick labels never need rounding. */
  function niceScale(v, target) {
    if (v <= 0) return { max: 1, step: 0.25, ticks: 4 };
    const raw = v / target;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
    const ticks = Math.ceil(v / step);
    return { max: step * ticks, step, ticks };
  }

  /**
   * Donut chart. segments: [{label, value, color, tip}]
   */
  function donut(segments, opts) {
    opts = opts || {};
    const total = segments.reduce((s, x) => s + x.value, 0);
    const size = 220, cx = size / 2, cy = size / 2, r = 84, sw = 30;
    const C = 2 * Math.PI * r;
    let out = `<svg class="chart donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(opts.label || 'แผนภูมิวงกลม')}">`;
    out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" style="stroke:var(--grid)" stroke-width="${sw}"/>`;
    if (total > 0) {
      let offset = 0;
      const gap = segments.filter((s) => s.value > 0).length > 1 ? 2 : 0;
      for (const s of segments) {
        if (s.value <= 0) continue;
        const len = (s.value / total) * C;
        const dash = Math.max(len - gap, 0.75);
        out += `<circle class="hit" cx="${cx}" cy="${cy}" r="${r}" fill="none" style="stroke:${s.color}" stroke-width="${sw}"
          stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"
          data-tip="${esc(s.tip || s.label)}"/>`;
        offset += len;
      }
    }
    if (opts.centerTop) out += `<text x="${cx}" y="${cy - 6}" text-anchor="middle" class="donut-top">${esc(opts.centerTop)}</text>`;
    if (opts.centerBottom) out += `<text x="${cx}" y="${cy + 18}" text-anchor="middle" class="donut-bottom">${esc(opts.centerBottom)}</text>`;
    return out + '</svg>';
  }

  /**
   * Vertical bars, one or two series per slot.
   * rows: [{label, values: [..], tip, key}]; series: [{label, color}]
   */
  function bars(rows, series, opts) {
    opts = opts || {};
    const W = opts.width || 640, H = opts.height || 220;
    const m = { t: 12, r: 8, b: 26, l: 44 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const { max, step, ticks } = niceScale(Math.max(0, ...rows.flatMap((r) => r.values)), 4);
    const slot = iw / rows.length;
    const groupW = Math.min(slot * 0.72, series.length === 1 ? 22 : 34);
    const barGap = series.length > 1 ? 2 : 0;
    const barW = (groupW - barGap * (series.length - 1)) / series.length;
    const y = (v) => m.t + ih - (v / max) * ih;

    let out = `<svg class="chart bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'แผนภูมิแท่ง')}">`;
    for (let i = 0; i <= ticks; i++) {
      const v = step * i, yy = y(v);
      out += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" class="${i === 0 ? 'axis' : 'grid'}"/>`;
      out += `<text x="${m.l - 6}" y="${yy + 4}" text-anchor="end" class="tick">${U.formatCompact(v)}</text>`;
    }
    const every = opts.labelEvery || 1;
    rows.forEach((row, i) => {
      const gx = m.l + slot * i + (slot - groupW) / 2;
      row.values.forEach((v, k) => {
        const h = (v / max) * ih;
        out += `<path d="${barPath(gx + k * (barW + barGap), m.t + ih - h, barW, h, 4)}" style="fill:${series[k].color}"/>`;
      });
      const isLabel = every === 1 || (i + 1) % every === 0 || (i === 0 && every > 2);
      if (isLabel) out += `<text x="${m.l + slot * i + slot / 2}" y="${H - 8}" text-anchor="middle" class="tick">${esc(row.label)}</text>`;
      // Hit target covers the whole slot so thin bars are easy to hover/tap.
      out += `<rect class="hit-slot" x="${m.l + slot * i}" y="${m.t}" width="${slot}" height="${ih}" data-tip="${esc(row.tip || '')}"${row.key ? ` data-key="${esc(row.key)}"` : ''}/>`;
    });
    return out + '</svg>';
  }

  root.AICharts = { donut, bars };
})(self);
