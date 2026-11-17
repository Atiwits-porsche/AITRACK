/* Pure helpers: formatting, dates and aggregation. No DOM access, so they can be tested in Node. */
(function (root) {
  'use strict';

  const LOCALE = 'th-TH';
  const moneyFmt = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'THB', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const moneyFmt0 = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'THB', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const numFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });

  const pad = (n) => String(n).padStart(2, '0');

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** RFC 4122 v4 id; crypto.randomUUID needs a secure context, so fall back for file:// */
  function uuid() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function toISODate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseISODate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function formatMoney(n, opts) {
    const v = Number(n) || 0;
    return (opts && opts.noDecimals ? moneyFmt0 : moneyFmt).format(v);
  }

  function formatSigned(n, opts) {
    const v = Number(n) || 0;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + formatMoney(Math.abs(v), opts);
  }

  function formatNumber(n) {
    return numFmt.format(Number(n) || 0);
  }

  /** Short axis label: 1.2K, 35K, 1.5M */
  function formatCompact(n) {
    const v = Math.abs(n);
    if (v >= 1e6) return (n / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return (n / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
  }

  function monthLabel(year, month) {
    return new Date(year, month, 1).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
  }

  function monthShort(month) {
    return new Date(2000, month, 1).toLocaleDateString(LOCALE, { month: 'short' });
  }

  function yearLabel(year) {
    return new Date(year, 0, 1).toLocaleDateString(LOCALE, { year: 'numeric' });
  }

  function dayLabel(iso) {
    return parseISODate(iso).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  /** Parse a user-entered amount ("1,250.50") into a positive number, or NaN. */
  function parseAmount(s) {
    const v = Number(String(s).replace(/[,\s฿]/g, ''));
    return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : NaN;
  }

  function inMonth(tx, year, month) {
    return tx.date.startsWith(year + '-' + pad(month + 1) + '-');
  }

  function filterByMonth(txs, year, month) {
    return txs.filter((t) => inMonth(t, year, month));
  }

  function filterByYear(txs, year) {
    return txs.filter((t) => t.date.startsWith(year + '-'));
  }

  function totals(txs) {
    let income = 0, expense = 0;
    for (const t of txs) {
      if (t.type === 'income') income += t.amount; else expense += t.amount;
    }
    income = round2(income); expense = round2(expense);
    return { income, expense, net: round2(income - expense) };
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  /** [{categoryId, total, count}] sorted by total desc */
  function byCategory(txs, type) {
    const map = new Map();
    for (const t of txs) {
      if (t.type !== type) continue;
      const e = map.get(t.categoryId) || { categoryId: t.categoryId, total: 0, count: 0 };
      e.total += t.amount; e.count += 1;
      map.set(t.categoryId, e);
    }
    return [...map.values()].map((e) => ({ ...e, total: round2(e.total) })).sort((a, b) => b.total - a.total);
  }

  /** Array indexed by day-1 of {income, expense} for a month */
  function byDay(txs, year, month) {
    const days = Array.from({ length: daysInMonth(year, month) }, () => ({ income: 0, expense: 0 }));
    for (const t of filterByMonth(txs, year, month)) {
      const d = Number(t.date.slice(8, 10)) - 1;
      days[d][t.type] += t.amount;
    }
    return days;
  }

  /** 12 entries of {month, income, expense, net, count} */
  function byMonth(txs, year) {
    const out = Array.from({ length: 12 }, (_, m) => ({ month: m, income: 0, expense: 0, net: 0, count: 0 }));
    for (const t of filterByYear(txs, year)) {
      const m = Number(t.date.slice(5, 7)) - 1;
      out[m][t.type] += t.amount;
      out[m].count += 1;
    }
    for (const o of out) { o.income = round2(o.income); o.expense = round2(o.expense); o.net = round2(o.income - o.expense); }
    return out;
  }

  /** Group sorted transactions into [{date, items, net}] newest first */
  function groupByDate(txs) {
    const sorted = [...txs].sort((a, b) => (b.date.localeCompare(a.date)) || (b.time || '').localeCompare(a.time || '') || (b.createdAt || 0) - (a.createdAt || 0));
    const groups = [];
    for (const t of sorted) {
      let g = groups[groups.length - 1];
      if (!g || g.date !== t.date) { g = { date: t.date, items: [], net: 0 }; groups.push(g); }
      g.items.push(t);
      g.net += t.type === 'income' ? t.amount : -t.amount;
    }
    for (const g of groups) g.net = round2(g.net);
    return groups;
  }

  /** Current local time as "HH:MM". */
  function nowHHMM(d) {
    d = d || new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  const TIME_BUCKETS = [
    { key: 'morning', label: 'เช้า', range: '05:00–10:59', meal: 'มื้อเช้า' },
    { key: 'noon', label: 'กลางวัน', range: '11:00–14:59', meal: 'มื้อกลางวัน' },
    { key: 'evening', label: 'เย็น', range: '15:00–20:59', meal: 'มื้อเย็น' },
    { key: 'night', label: 'ดึก', range: '21:00–04:59', meal: 'มื้อดึก' },
  ];

  /** Time-of-day bucket for "HH:MM", or null when no time was recorded. */
  function timeBucket(hhmm) {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return null;
    const h = Number(m[1]);
    if (h >= 5 && h < 11) return TIME_BUCKETS[0];
    if (h >= 11 && h < 15) return TIME_BUCKETS[1];
    if (h >= 15 && h < 21) return TIME_BUCKETS[2];
    return TIME_BUCKETS[3];
  }

  /** [{key, label, range, total, count}] in time-of-day order; entries without a time go to "none". */
  function byTimeOfDay(txs) {
    const rows = TIME_BUCKETS.map((b) => ({ ...b, total: 0, count: 0 }));
    const none = { key: 'none', label: 'ไม่ระบุเวลา', range: '', total: 0, count: 0 };
    for (const t of txs) {
      const b = timeBucket(t.time);
      const row = b ? rows.find((r) => r.key === b.key) : none;
      row.total += t.amount; row.count += 1;
    }
    return [...rows, none].map((r) => ({ ...r, total: round2(r.total) }));
  }

  /** Monthly plan totals. items: [{kind: 'income'|'fixed'|'budget', amount}] */
  function planTotals(items) {
    const sum = (k) => round2((items || []).filter((i) => i.kind === k).reduce((a, i) => a + i.amount, 0));
    const income = sum('income'), fixed = sum('fixed'), budget = sum('budget');
    const expense = round2(fixed + budget);
    return { income, fixed, budget, expense, free: round2(income - expense) };
  }

  /** Map categoryId → {fixed, budget, total} of planned expense. */
  function planByCategory(items) {
    const map = new Map();
    for (const i of items || []) {
      if (i.kind === 'income') continue;
      const e = map.get(i.categoryId) || { fixed: 0, budget: 0, total: 0 };
      e[i.kind] = round2(e[i.kind] + i.amount);
      e.total = round2(e.total + i.amount);
      map.set(i.categoryId, e);
    }
    return map;
  }

  // Notes written by every version of the sample-data generator.
  const SAMPLE_NOTES = new Set(['เงินเดือน', 'งานออกแบบ', 'ค่าห้อง', 'ค่าเช่าห้อง', 'ค่าน้ำ/ไฟ/เน็ต', 'ค่าไฟ + เน็ต',
    'มื้อกลางวัน', 'ข้าวกลางวัน', 'กาแฟ', 'มื้อเย็น', 'มื้อเช้า', 'ซื้อของสด', 'BTS', 'เติมน้ำมัน', 'แท็กซี่',
    'เสื้อผ้า', 'ของใช้ในบ้าน', 'ดูหนัง', 'Netflix', 'ร้านยา']);

  /**
   * Ids of entries made by "try sample data". New sample entries carry a "sample-" id; older ones are
   * recognised as a burst of 30+ entries created within moments of each other, nearly all with sample notes.
   * A person typing entries by hand never creates that many that fast.
   */
  function findSampleIds(txs) {
    const ids = new Set();
    for (const t of txs) if (String(t.id).startsWith('sample-')) ids.add(t.id);
    const sorted = txs.filter((t) => t.createdAt > 0).sort((a, b) => a.createdAt - b.createdAt);
    let start = 0;
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i].createdAt - sorted[i - 1].createdAt <= 2000) continue;
      const run = sorted.slice(start, i);
      if (run.length >= 30 && run.filter((t) => SAMPLE_NOTES.has(t.note)).length >= run.length * 0.9) run.forEach((t) => ids.add(t.id));
      start = i;
    }
    return ids;
  }

  function percentChange(curr, prev) {
    if (!prev) return null;
    return ((curr - prev) / prev) * 100;
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(txs, categoryName) {
    const rows = [['วันที่', 'เวลา', 'ประเภท', 'หมวดหมู่', 'จำนวนเงิน', 'บันทึก']];
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
    for (const t of sorted) {
      rows.push([t.date, t.time || '', t.type === 'income' ? 'รายรับ' : 'รายจ่าย', categoryName(t.categoryId), t.amount.toFixed(2), t.note || '']);
    }
    return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n');
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const api = {
    uid, uuid, pad, toISODate, parseISODate, daysInMonth, formatMoney, formatSigned, formatNumber, formatCompact,
    monthLabel, monthShort, yearLabel, dayLabel, parseAmount, filterByMonth, filterByYear, totals, byCategory,
    byDay, byMonth, groupByDate, percentChange, toCSV, escapeHTML, round2,
    nowHHMM, TIME_BUCKETS, timeBucket, byTimeOfDay, planTotals, planByCategory, findSampleIds,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AIUtils = api;
})(typeof self !== 'undefined' ? self : this);
