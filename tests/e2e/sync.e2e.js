const { chromium } = require('playwright');
const fs = require('fs');
const assert = require('assert');
/*
 * End-to-end sync test: two (or more) browser contexts act as separate devices and share an
 * in-memory fake Supabase (auth + REST + realtime with per-user row isolation).
 * Run: npm run test:e2e   (needs Playwright + Chromium installed)
 */
const http = require('http');
const path = require('path');
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-supabase.js'), 'utf8');
const ROOT = path.join(__dirname, '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});
let BASE;

// ---- fake server ----
const users = {}; const db = { transactions: [], user_settings: [] }; const pages = [];
// legacy = a database created from the first schema version (no time_of_day / plan columns yet)
let legacy = false;
const LEGACY_COLS = { transactions: 'time_of_day', user_settings: 'plan' };
const match = (row, filters) => filters.every(([op, c, v]) => op === 'eq' ? String(row[c]) === String(v) : v.includes(row[c]));
function broadcast(ev) { for (const p of pages) p.evaluate((e) => window.__sbEvent && window.__sbEvent(e), ev).catch(() => {}); }
function handle(req) {
  if (req.action === 'signup') { if (users[req.email]) return { error: { message: 'User already registered' } }; users[req.email] = { pw: req.password, id: 'u-' + Object.keys(users).length }; return { data: { user: { id: users[req.email].id, email: req.email } } }; }
  if (req.action === 'signin') { const u = users[req.email]; if (!u || u.pw !== req.password) return { error: { message: 'Invalid login credentials' } }; return { data: { user: { id: u.id, email: req.email } } }; }
  if (!req.uid) return { error: { message: 'JWT required' } };
  const t = db[req.table]; const pk = req.table === 'transactions' ? (r) => r.user_id + '|' + r.id : (r) => r.user_id;
  const visible = (r) => r.user_id === req.uid; // RLS
  if (legacy && req.action === 'upsert' && req.rows.some((r) => LEGACY_COLS[req.table] in r)) {
    return { error: { code: 'PGRST204', message: `Could not find the '${LEGACY_COLS[req.table]}' column of '${req.table}' in the schema cache` } };
  }
  if (req.action === 'select') {
    let rows = t.filter((r) => visible(r) && match(r, req.filters));
    if (legacy) rows = rows.map((r) => { const o = { ...r }; delete o[LEGACY_COLS[req.table]]; return o; });
    if (req.range) rows = rows.slice(req.range[0], req.range[1] + 1);
    return { data: req.single ? (rows[0] || null) : JSON.parse(JSON.stringify(rows)), error: null };
  }
  if (req.action === 'upsert') {
    for (const r of req.rows) {
      if (r.user_id !== req.uid) return { error: { message: 'new row violates row-level security policy' } };
      const i = t.findIndex((x) => pk(x) === pk(r));
      if (i >= 0) t[i] = r; else t.push(r);
      broadcast({ table: req.table, eventType: i >= 0 ? 'UPDATE' : 'INSERT', new: r, old: {} });
    }
    return { data: null, error: null };
  }
  if (req.action === 'delete') {
    const gone = t.filter((r) => visible(r) && match(r, req.filters));
    db[req.table] = t.filter((r) => !gone.includes(r));
    for (const r of gone) broadcast({ table: req.table, eventType: 'DELETE', new: {}, old: { user_id: r.user_id, id: r.id } });
    return { data: null, error: null };
  }
}

async function device(browser, name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.exposeBinding('__sb', (_src, req) => handle(req));
  await ctx.route(/cdn\.jsdelivr\.net/, (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  await ctx.route(/js\/config\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: opts.noConfig ? 'window.AITRACK_CONFIG={}' : "window.AITRACK_CONFIG={supabaseUrl:'https://fake.supabase.co',supabaseAnonKey:'x'.repeat(40)}" }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { console.log(name, 'PAGEERROR', e.message); process.exitCode = 1; });
  p.on('dialog', (d) => d.accept());
  pages.push(p);
  await p.goto(BASE);
  return { ctx, p };
}
const txCount = (p) => p.evaluate(() => AIStore.transactions.length);
const serverTx = (uid) => db.transactions.filter((r) => r.user_id === uid);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function addTx(p, amount, note, income) {
  await p.click('#addBtn');
  if (income) await p.click('[data-ftype="income"]');
  await p.fill('#fAmount', String(amount)); await p.fill('#fNote', note);
  await p.click('#txForm button[type=submit]');
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch();
  const shot = (p, name) => (process.env.SHOTS ? p.screenshot({ path: path.join(process.env.SHOTS, name) }) : null);
  // 1) Device A: login screen, sign up
  const A = await device(browser, 'A');
  await A.p.waitForSelector('#authForm');
  assert(await A.p.locator('.nav').isHidden(), 'nav hidden on auth screen');
  await shot(A.p, 'auth.png');
  await A.p.click('[data-tab="signup"]');
  await A.p.fill('[name=email]', 'me@example.com'); await A.p.fill('[name=password]', 'secret1');
  await A.p.click('#authForm button[type=submit]');
  await A.p.waitForSelector('.switcher');
  await addTx(A.p, 120, 'ข้าวมันไก่');
  await addTx(A.p, 35000, 'เงินเดือน', true);
  await wait(800);
  assert.equal(serverTx('u-0').length, 2, 'A tx reached server');
  assert(db.user_settings.length === 1, 'settings row created on first sign-in');
  console.log('1 ok: signup + push. badge =', await A.p.textContent('#syncBadge'));

  // 2) Device B: wrong password, then sign in, sees data
  const B = await device(browser, 'B');
  await B.p.waitForSelector('#authForm');
  await B.p.fill('[name=email]', 'me@example.com'); await B.p.fill('[name=password]', 'wrong12');
  await B.p.click('#authForm button[type=submit]');
  await B.p.waitForTimeout(200);
  console.log('   wrong pw msg:', await B.p.textContent('#authMsg'));
  await B.p.fill('[name=password]', 'secret1');
  await B.p.click('#authForm button[type=submit]');
  await B.p.waitForSelector('.switcher'); await wait(500);
  assert.equal(await txCount(B.p), 2, 'B pulled 2');
  console.log('2 ok: B sees', await txCount(B.p));

  // 3) realtime A -> B
  await addTx(A.p, 60, 'กาแฟ'); await wait(800);
  assert.equal(await txCount(B.p), 3, 'B got realtime insert');
  assert((await B.p.textContent('#txList')).includes('กาแฟ'), 'B UI re-rendered');
  console.log('3 ok: realtime insert');

  // 4) B edits + deletes -> A
  await B.p.locator('.tx', { hasText: 'กาแฟ' }).click();
  await B.p.fill('#fAmount', '75'); await B.p.click('#txForm button[type=submit]'); await wait(800);
  const coffeeA = await A.p.evaluate(() => AIStore.transactions.find((t) => t.note === 'กาแฟ').amount);
  assert.equal(coffeeA, 75, 'A got update');
  await B.p.locator('.tx', { hasText: 'กาแฟ' }).click(); await B.p.click('#fDelete'); await wait(800);
  assert.equal(await txCount(A.p), 2, 'A got delete');
  console.log('4 ok: realtime update + delete');

  // 5) settings sync (budget + new category)
  await A.p.goto(BASE + '#/settings');
  await A.p.fill('#budgetInput', '20000'); await A.p.click('#budgetForm button');
  await A.p.fill('.add-cat[data-type=expense] [name=name]', 'สัตว์เลี้ยง'); await A.p.click('.add-cat[data-type=expense] button');
  await wait(800);
  const bs = await B.p.evaluate(() => [AIStore.settings.budget, AIStore.categories.expense.map((c) => c.name).includes('สัตว์เลี้ยง')]);
  assert.deepEqual(bs, [20000, true], 'B got settings');
  console.log('5 ok: settings sync');

  // 5b) monthly plan + time of day sync
  await A.p.evaluate(() => AIStore.setPlan([
    { id: 'p1', kind: 'income', categoryId: 'salary', amount: 20000, label: 'เงินเดือน' },
    { id: 'p2', kind: 'fixed', categoryId: 'home', amount: 5000, label: 'ค่าห้อง' },
    { id: 'p3', kind: 'budget', categoryId: 'food', amount: 3000, label: '' },
  ]));
  await A.p.goto(BASE + '#/categories/food'); await A.p.waitForSelector('.cat-head');
  await A.p.click('.cat-head [data-act="add-in-cat"]');
  await A.p.fill('#fAmount', '65'); await A.p.fill('#fTime', '12:30'); await A.p.click('[data-note="มื้อกลางวัน"]');
  await A.p.click('#txForm button[type=submit]'); await wait(800);
  const bPlan = await B.p.evaluate(() => [AIStore.plan.length, (AIStore.transactions.find((t) => t.note === 'มื้อกลางวัน') || {}).time]);
  assert.deepEqual(bPlan, [3, '12:30'], 'B got plan + time');
  // recording rent on both devices for the same month never duplicates (deterministic id)
  await A.p.goto(BASE + '#/categories'); await B.p.goto(BASE + '#/categories');
  await A.p.waitForSelector('.check-list'); await B.p.waitForSelector('.check-list');
  await Promise.all([A.p.click('[data-act="plan-record"][data-id="p2"]'), B.p.click('[data-act="plan-record"][data-id="p2"]')]);
  await wait(800);
  assert.equal(serverTx('u-0').filter((r) => r.id.startsWith('plan-p2-')).length, 1, 'rent recorded once');
  console.log('5b ok: plan + meal time sync, no duplicate rent');

  // 5c) database still on the first schema version: app keeps working, local time kept, notice shown
  legacy = true;
  await A.p.goto(BASE + '#/');
  await addTx(A.p, 45, 'ก่อนอัปเดตฐานข้อมูล'); await wait(800);
  const row = serverTx('u-0').find((r) => r.note === 'ก่อนอัปเดตฐานข้อมูล');
  assert(row && !('time_of_day' in row), 'saved without the missing column');
  assert.equal(await A.p.textContent('#syncBadge'), '☁️ ซิงก์แล้ว');
  await A.p.evaluate(() => AICloud.syncNow());
  assert((await A.p.evaluate(() => AIStore.transactions.find((t) => t.note === 'ก่อนอัปเดตฐานข้อมูล').time)).match(/^\d\d:\d\d$/), 'time kept locally after pull');
  await A.p.goto(BASE + '#/settings'); await A.p.waitForSelector('.notice');
  legacy = false;
  console.log('5c ok: works on old schema, shows upgrade notice');

  // 6) offline on A: queue, then flush when back online
  const N = serverTx('u-0').length;
  await A.ctx.setOffline(true);
  await A.p.evaluate(() => { location.hash = '#/'; });
  await addTx(A.p, 999, 'ซื้อออฟไลน์'); await wait(500);
  const badgeOff = await A.p.textContent('#syncBadge');
  assert.equal(serverTx('u-0').length, N, 'not on server while offline');
  await A.ctx.setOffline(false); await wait(1200);
  assert.equal(serverTx('u-0').length, N + 1, 'flushed after reconnect');
  assert.equal(await txCount(B.p), N + 1, 'B got offline item after reconnect');
  console.log('6 ok: offline badge =', JSON.stringify(badgeOff), '→', await A.p.textContent('#syncBadge'));

  // 7) reload keeps session + data
  await B.p.reload(); await B.p.waitForSelector('.switcher'); await wait(300);
  assert.equal(await txCount(B.p), N + 1);
  console.log('7 ok: session persisted after reload');

  // 8) sign out clears cache, shows login
  await B.p.goto(BASE + '#/settings'); await B.p.click('[data-act="sign-out"]'); await B.p.waitForSelector('#authForm');
  const leftovers = await B.p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('aitrack.cloud') || k.startsWith('aitrack.queue')));
  assert.equal(leftovers.length, 0, 'cache cleared');
  console.log('8 ok: sign out clears cache');

  // 9) local mode, then sign in and migrate
  await B.p.click('[data-act="use-local"]'); await B.p.waitForSelector('.switcher');
  await addTx(B.p, 450, 'ข้อมูลก่อนล็อกอิน'); await wait(300);
  assert.equal(serverTx('u-0').length, N + 1, 'local mode does not sync');
  await B.p.goto(BASE + '#/settings'); await B.p.click('[data-act="go-login"]');
  await B.p.fill('[name=email]', 'me@example.com'); await B.p.fill('[name=password]', 'secret1');
  await B.p.click('#authForm button[type=submit]'); await B.p.waitForSelector('.banner');
  await shot(B.p, 'banner.png');
  await B.p.click('[data-act="migrate"]'); await wait(800);
  assert.equal(serverTx('u-0').length, N + 2, 'migrated to server');
  assert.equal(await txCount(A.p), N + 2, 'A sees migrated');
  console.log('9 ok: local → account migration');

  // 10) RLS: other user's delete events are ignored
  const C = await device(browser, 'C');
  await C.p.waitForSelector('#authForm'); await C.p.click('[data-tab="signup"]');
  await C.p.fill('[name=email]', 'other@example.com'); await C.p.fill('[name=password]', 'secret2');
  await C.p.click('#authForm button[type=submit]'); await C.p.waitForSelector('.switcher');
  await addTx(C.p, 10, 'ของคนอื่น'); await wait(500);
  assert.equal(await txCount(C.p), 1); assert.equal(await txCount(A.p), N + 2, 'A does not see C');
  await C.p.locator('.tx').first().click(); await C.p.click('#fDelete'); await wait(500);
  assert.equal(await txCount(A.p), N + 2, 'A unaffected by C delete');
  console.log('10 ok: users isolated');

  // 11) no config → pure local mode, no login screen
  const D = await device(browser, 'D', { noConfig: true });
  await D.p.waitForSelector('.switcher');
  assert(await D.p.locator('#syncBadge').isHidden());
  await addTx(D.p, 5, 'local'); assert.equal(await txCount(D.p), 1);
  await D.p.goto(BASE + '#/settings'); await shot(D.p, 'noconfig-settings.png');
  console.log('11 ok: works without Supabase');

  await A.p.goto(BASE + '#/settings'); await wait(200); await shot(A.p, 'account.png');
  await browser.close();
  server.close();
  console.log('ALL SYNC TESTS PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
