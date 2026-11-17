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
    const sorted = [...txs].sort((a, b) => (b.date.localeCompare(a.date)) || (b.createdAt || 0) - (a.createdAt || 0));
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

  function percentChange(curr, prev) {
    if (!prev) return null;
    return ((curr - prev) / prev) * 100;
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(txs, categoryName) {
    const rows = [['วันที่', 'ประเภท', 'หมวดหมู่', 'จำนวนเงิน', 'บันทึก']];
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    for (const t of sorted) {
      rows.push([t.date, t.type === 'income' ? 'รายรับ' : 'รายจ่าย', categoryName(t.categoryId), t.amount.toFixed(2), t.note || '']);
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
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AIUtils = api;
})(typeof self !== 'undefined' ? self : this);
