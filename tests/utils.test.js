const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../js/utils.js');

const txs = [
  { id: '1', type: 'income', amount: 30000, categoryId: 'salary', date: '2026-11-01' },
  { id: '2', type: 'expense', amount: 120.5, categoryId: 'food', date: '2026-11-01' },
  { id: '3', type: 'expense', amount: 79.5, categoryId: 'food', date: '2026-11-03' },
  { id: '4', type: 'expense', amount: 500, categoryId: 'transport', date: '2026-11-03' },
  { id: '5', type: 'expense', amount: 999, categoryId: 'food', date: '2026-10-31' },
  { id: '6', type: 'income', amount: 1000, categoryId: 'bonus', date: '2025-11-02' },
];

test('parseAmount accepts commas and rejects non-positive values', () => {
  assert.equal(U.parseAmount('1,250.50'), 1250.5);
  assert.equal(U.parseAmount('฿ 99'), 99);
  assert.ok(Number.isNaN(U.parseAmount('0')));
  assert.ok(Number.isNaN(U.parseAmount('-5')));
  assert.ok(Number.isNaN(U.parseAmount('abc')));
});

test('filterByMonth uses 0-based months and ignores other years', () => {
  assert.deepEqual(U.filterByMonth(txs, 2026, 10).map((t) => t.id), ['1', '2', '3', '4']);
  assert.deepEqual(U.filterByMonth(txs, 2026, 9).map((t) => t.id), ['5']);
});

test('totals sums income, expense and net without float drift', () => {
  assert.deepEqual(U.totals(U.filterByMonth(txs, 2026, 10)), { income: 30000, expense: 700, net: 29300 });
});

test('byCategory groups and sorts by total', () => {
  const r = U.byCategory(U.filterByMonth(txs, 2026, 10), 'expense');
  assert.deepEqual(r, [
    { categoryId: 'transport', total: 500, count: 1 },
    { categoryId: 'food', total: 200, count: 2 },
  ]);
});

test('byMonth returns 12 months for the requested year only', () => {
  const r = U.byMonth(txs, 2026);
  assert.equal(r.length, 12);
  assert.deepEqual(r[10], { month: 10, income: 30000, expense: 700, net: 29300, count: 4 });
  assert.deepEqual(r[9], { month: 9, income: 0, expense: 999, net: -999, count: 1 });
  assert.equal(r[0].count, 0);
});

test('byDay has one slot per day of the month', () => {
  const d = U.byDay(txs, 2026, 10);
  assert.equal(d.length, 30);
  assert.equal(d[0].expense, 120.5);
  assert.equal(d[2].expense, 579.5);
});

test('groupByDate orders newest first with a daily net', () => {
  const g = U.groupByDate(U.filterByMonth(txs, 2026, 10));
  assert.deepEqual(g.map((x) => [x.date, x.net]), [['2026-11-03', -579.5], ['2026-11-01', 29879.5]]);
});

test('toCSV escapes commas/quotes and includes BOM for Excel', () => {
  const csv = U.toCSV([{ type: 'expense', amount: 10, categoryId: 'x', date: '2026-01-01', note: 'a, "b"' }], () => 'อาหาร');
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('2026-01-01,รายจ่าย,อาหาร,10.00,"a, ""b"""'));
});

test('escapeHTML neutralises markup', () => {
  assert.equal(U.escapeHTML('<img src=x onerror="1">'), '&lt;img src=x onerror=&quot;1&quot;&gt;');
});

test('formatCompact', () => {
  assert.equal(U.formatCompact(1500), '1.5K');
  assert.equal(U.formatCompact(25000), '25K');
  assert.equal(U.formatCompact(2000000), '2M');
  assert.equal(U.formatCompact(800), '800');
});

test('percentChange handles zero baseline', () => {
  assert.equal(U.percentChange(150, 100), 50);
  assert.equal(U.percentChange(10, 0), null);
});
