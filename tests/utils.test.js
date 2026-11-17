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
  assert.ok(csv.includes('2026-01-01,,รายจ่าย,อาหาร,10.00,"a, ""b"""'));
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

test('toCSV includes the time column', () => {
  const csv = U.toCSV([{ type: 'expense', amount: 45, categoryId: 'x', date: '2026-01-02', time: '12:30', note: '' }], () => 'ค่ากิน');
  assert.ok(csv.split('\n')[0].includes('เวลา'));
  assert.ok(csv.includes('2026-01-02,12:30,รายจ่าย,ค่ากิน,45.00,'));
});

test('timeBucket maps clock times to meals and ignores blanks', () => {
  assert.equal(U.timeBucket('07:15').key, 'morning');
  assert.equal(U.timeBucket('12:00').key, 'noon');
  assert.equal(U.timeBucket('18:45').key, 'evening');
  assert.equal(U.timeBucket('23:10').key, 'night');
  assert.equal(U.timeBucket('02:00').key, 'night');
  assert.equal(U.timeBucket(''), null);
  assert.equal(U.timeBucket(undefined), null);
});

test('byTimeOfDay totals per bucket with a bucket for missing times', () => {
  const r = U.byTimeOfDay([
    { amount: 50, time: '08:00' }, { amount: 70, time: '12:30' }, { amount: 30.5, time: '12:45' }, { amount: 99 },
  ]);
  const get = (k) => r.find((x) => x.key === k);
  assert.deepEqual([get('morning').total, get('noon').total, get('noon').count, get('none').total], [50, 100.5, 2, 99]);
});

test('groupByDate puts later times first within a day', () => {
  const g = U.groupByDate([
    { id: 'a', type: 'expense', amount: 1, date: '2026-11-01', time: '08:00' },
    { id: 'b', type: 'expense', amount: 1, date: '2026-11-01', time: '19:00' },
  ]);
  assert.deepEqual(g[0].items.map((t) => t.id), ['b', 'a']);
});

test('planTotals and planByCategory', () => {
  const items = [
    { kind: 'income', categoryId: 'salary', amount: 20000 },
    { kind: 'fixed', categoryId: 'home', amount: 5000 },
    { kind: 'budget', categoryId: 'food', amount: 3000 },
    { kind: 'budget', categoryId: 'food', amount: 500 },
  ];
  assert.deepEqual(U.planTotals(items), { income: 20000, fixed: 5000, budget: 3500, expense: 8500, free: 11500 });
  const m = U.planByCategory(items);
  assert.deepEqual(m.get('food'), { fixed: 0, budget: 3500, total: 3500 });
  assert.deepEqual(m.get('home'), { fixed: 5000, budget: 0, total: 5000 });
  assert.equal(m.has('salary'), false);
});

test('nowHHMM pads hours and minutes', () => {
  assert.equal(U.nowHHMM(new Date(2026, 0, 1, 7, 5)), '07:05');
});
