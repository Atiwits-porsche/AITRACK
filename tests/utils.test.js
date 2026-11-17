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

test('findSampleIds: marked ids and an old unmarked sample burst, never hand-entered data', () => {
  const t0 = 1_700_000_000_000;
  const notes = ['มื้อกลางวัน', 'กาแฟ', 'BTS', 'เงินเดือน'];
  const burst = Array.from({ length: 40 }, (_, i) => ({ id: 'u' + i, note: notes[i % 4], createdAt: t0 + i }));
  const own = [
    { id: 'mine1', note: 'กาแฟ', createdAt: t0 + 60_000 },
    { id: 'mine2', note: 'ข้าวมันไก่', createdAt: t0 + 120_000 },
    { id: 'plan-x-2026-11', note: 'เงินเดือน', createdAt: t0 + 200_000 },
  ];
  const marked = [{ id: 'sample-abc', note: 'อะไรก็ได้', createdAt: t0 + 300_000 }];
  const ids = U.findSampleIds([...own, ...burst, ...marked]);
  assert.equal(ids.size, 41);
  assert.ok(ids.has('u0') && ids.has('u39') && ids.has('sample-abc'));
  assert.ok(!ids.has('mine1') && !ids.has('mine2') && !ids.has('plan-x-2026-11'));
  // A quick import of real notes (different text) is not mistaken for samples.
  const imported = Array.from({ length: 40 }, (_, i) => ({ id: 'r' + i, note: 'ร้าน ' + i, createdAt: t0 + i }));
  assert.equal(U.findSampleIds(imported).size, 0);
});

const tx = (date, amount, categoryId, extra) => ({ id: U.uid(), type: 'expense', amount, categoryId, date, time: '', note: '', createdAt: 1, ...extra });

test('quarters: filter, totals, labels and shifting across years', () => {
  const txs = [tx('2026-01-05', 100, 'food'), tx('2026-03-31', 50, 'food'), tx('2026-04-01', 70, 'food'),
    { ...tx('2026-02-01', 1000, 'salary'), type: 'income' }, tx('2025-12-31', 9, 'food')];
  assert.equal(U.filterByQuarter(txs, 2026, 0).length, 3);
  const q = U.byQuarter(txs, 2026);
  assert.deepEqual([q[0].income, q[0].expense, q[0].net, q[1].expense, q[2].count], [1000, 150, 850, 70, 0]);
  assert.deepEqual(U.shiftQuarter(2026, 0, -1), { year: 2025, q: 3 });
  assert.deepEqual(U.shiftQuarter(2025, 3, 1), { year: 2026, q: 0 });
  assert.equal(U.quarterOf(11), 3);
  assert.match(U.quarterLabel(2026, 3), /^ไตรมาส 4 /);
});

test('monthSeries crosses the year boundary', () => {
  const s = U.monthSeries([tx('2025-12-10', 10, 'food'), tx('2026-01-10', 20, 'food')], 2026, 1, 3);
  assert.deepEqual(s.map((m) => [m.year, m.month, m.expense]), [[2025, 11, 10], [2026, 0, 20], [2026, 1, 0]]);
});

test('byWeekday averages per weekday that occurs in the range, Monday first', () => {
  // 2026-11-02 is a Monday; range is two full weeks.
  const rows = U.byWeekday([tx('2026-11-02', 100, 'food'), tx('2026-11-09', 300, 'food'), tx('2026-11-08', 50, 'food')], '2026-11-02', '2026-11-15');
  assert.equal(rows[0].label, 'จ.');
  assert.deepEqual([rows[0].total, rows[0].days, rows[0].avg], [400, 2, 200]);
  assert.deepEqual([rows[6].label, rows[6].avg], ['อา.', 25]);
});

test('frequentNotes groups by note, skips plan entries and one-offs', () => {
  const txs = [tx('2026-11-01', 60, 'food', { note: 'กาแฟ' }), tx('2026-11-02', 40, 'food', { note: 'กาแฟ ' }),
    tx('2026-11-03', 500, 'fun', { note: 'ดูหนัง' }), tx('2026-11-01', 5000, 'home', { id: 'plan-x-2026-11', note: 'ค่าห้อง' }),
    tx('2026-11-02', 5000, 'home', { id: 'plan-x-2026-10', note: 'ค่าห้อง' })];
  assert.deepEqual(U.frequentNotes(txs), [{ note: 'กาแฟ', count: 2, total: 100, avg: 50, categoryId: 'food' }]);
});

test('categoryVsAverage compares the same part of each month', () => {
  const txs = [tx('2026-09-05', 100, 'food'), tx('2026-09-25', 900, 'food'), tx('2026-10-05', 300, 'food'), tx('2026-11-04', 400, 'food')];
  const r = U.categoryVsAverage(txs, 2026, 10, 3, 10);
  assert.equal(r.months, 2);
  assert.deepEqual(r.rows[0], { categoryId: 'food', curr: 400, avg: 200, diff: 200, pct: 100 });
});

test('projectMonth counts plan entries once and extends everyday spending', () => {
  const txs = [tx('2026-11-01', 5000, 'home', { id: 'plan-rent-2026-11' }), tx('2026-11-03', 300, 'food'), tx('2026-11-09', 300, 'food')];
  const p = U.projectMonth(txs, 2026, 10, 10);
  assert.deepEqual([p.spent, p.everyday, p.projected, p.days], [5600, 600, 5600 + 60 * 20, 30]);
  assert.equal(U.noSpendDays(txs, 2026, 10, 10), 7);
});

test('cutQuarter keeps the same span of a quarter', () => {
  const txs = [tx('2026-07-31', 1, 'a'), tx('2026-08-17', 2, 'a'), tx('2026-08-18', 4, 'a'), tx('2026-09-01', 8, 'a')];
  assert.deepEqual(U.cutQuarter(txs, 1, 17).map((t) => t.amount), [1, 2]);
});
