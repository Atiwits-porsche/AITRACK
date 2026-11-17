/* UI: routing, page rendering and the add/edit dialog. */
(function () {
  'use strict';
  const U = window.AIUtils, S = window.AIStore, C = window.AICharts, Cloud = window.AICloud;
  const esc = U.escapeHTML;
  const $ = (sel, el) => (el || document).querySelector(sel);

  const today = new Date();
  const state = {
    year: today.getFullYear(),
    month: today.getMonth(),
    yearView: today.getFullYear(),
    type: 'all',
    q: '',
  };

  const view = $('#view');
  let pendingRender = false;
  const ROUTES = { home: renderHome, summary: renderSummary, year: renderYear, settings: renderSettings };

  /* ---------- helpers ---------- */

  function currentRoute() {
    const r = location.hash.replace(/^#\/?/, '').split('?')[0];
    return ROUTES[r] ? r : 'home';
  }

  function render() {
    pendingRender = false;
    document.body.classList.toggle('auth-mode', Cloud.needsLogin);
    paintSyncBadge();
    if (Cloud.needsLogin) { renderAuth(); hideTip(); return; }
    const r = currentRoute();
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === r));
    ROUTES[r]();
    hideTip();
  }

  function catType(cat) {
    return S.categories.income.includes(cat) ? 'income' : 'expense';
  }

  /** Color follows the category (its position in its own list), never its rank. */
  function catColor(cat) {
    if (!cat || cat.other) return 'var(--s-other)';
    const idx = S.categories[catType(cat)].filter((c) => !c.other).indexOf(cat);
    return idx >= 0 && idx < 8 ? `var(--s${idx + 1})` : 'var(--s-other)';
  }

  function catName(id) { const c = S.getCategory(id); return c ? c.name : 'ไม่ระบุ'; }
  function catIcon(id) { const c = S.getCategory(id); return c ? c.icon : '❔'; }

  function isCurrentMonth() { return state.year === today.getFullYear() && state.month === today.getMonth(); }

  function shiftMonth(delta) {
    const d = new Date(state.year, state.month + delta, 1);
    state.year = d.getFullYear(); state.month = d.getMonth();
    render();
  }

  function monthSwitcher() {
    return `<div class="switcher">
      <button class="icon-btn" data-act="prev-month" aria-label="เดือนก่อน">‹</button>
      <h1>${esc(U.monthLabel(state.year, state.month))}</h1>
      <button class="icon-btn" data-act="next-month" aria-label="เดือนถัดไป">›</button>
      ${isCurrentMonth() ? '' : '<button class="chip" data-act="this-month">เดือนนี้</button>'}
    </div>`;
  }

  function stat(label, value, cls, sub) {
    return `<div class="stat ${cls || ''}"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${sub ? `<span class="stat-sub">${sub}</span>` : ''}</div>`;
  }

  /** Draw charts at roughly their on-screen width so 11px labels stay legible. */
  function chartWidth() { return Math.round(Math.max(320, Math.min(720, view.clientWidth - 70))); }

  function moneyCls(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; }

  function deltaText(curr, prev, goodWhenUp) {
    const pc = U.percentChange(curr, prev);
    if (pc === null) return '<span class="muted">ไม่มีข้อมูลเดือนก่อน</span>';
    if (Math.abs(pc) < 0.5) return '<span class="muted">→ ใกล้เคียงเดือนก่อน</span>';
    const up = pc > 0;
    const good = up === goodWhenUp;
    return `<span class="${good ? 'pos' : 'neg'}">${up ? '▲' : '▼'} ${Math.abs(pc).toFixed(0)}%</span> <span class="muted">จากเดือนก่อน</span>`;
  }

  /* ---------- Home: transactions of the month ---------- */

  function renderHome() {
    const txs = U.filterByMonth(S.transactions, state.year, state.month);
    const t = U.totals(txs);
    view.innerHTML = `
      ${migrationBanner()}
      ${monthSwitcher()}
      <div class="stats">
        ${stat('รายรับ', U.formatMoney(t.income), 'income')}
        ${stat('รายจ่าย', U.formatMoney(t.expense), 'expense')}
        ${stat('คงเหลือ', `<span class="${moneyCls(t.net)}">${U.formatSigned(t.net)}</span>`, 'net')}
      </div>
      ${budgetBlock(t.expense)}
      <div class="toolbar">
        <div class="seg" role="tablist">
          ${[['all', 'ทั้งหมด'], ['income', 'รายรับ'], ['expense', 'รายจ่าย']].map(([k, l]) =>
            `<button role="tab" data-act="filter-type" data-type="${k}" aria-selected="${state.type === k}">${l}</button>`).join('')}
        </div>
        <input type="search" id="search" class="search" placeholder="ค้นหาบันทึกหรือหมวดหมู่…" value="${esc(state.q)}" aria-label="ค้นหา">
      </div>
      <div id="txList"></div>`;
    $('#search').addEventListener('input', (e) => { state.q = e.target.value; renderList(); });
    renderList();
  }

  function migrationBanner() {
    const d = Cloud.localDataToMigrate();
    if (!d) return '';
    return `<div class="card banner">
      <div><b>พบข้อมูล ${d.transactions.length} รายการที่บันทึกไว้ในเครื่องนี้ก่อนเข้าสู่ระบบ</b>
      <div class="muted small">ย้ายขึ้นบัญชีเพื่อให้ดูได้จากทุกอุปกรณ์</div></div>
      <div class="btn-row"><button class="btn primary" data-act="migrate">ย้ายขึ้นบัญชี</button><button class="btn ghost" data-act="skip-migrate">ไม่ต้อง</button></div>
    </div>`;
  }

  function budgetBlock(spent) {
    const budget = S.settings.budget;
    if (!budget) return '';
    const pct = Math.min(100, (spent / budget) * 100);
    const left = budget - spent;
    let status, icon, msg;
    if (left < 0) { status = 'critical'; icon = '⛔'; msg = `เกินงบ ${U.formatMoney(-left)}`; }
    else if (pct >= 80) { status = 'warning'; icon = '⚠️'; msg = `ใกล้เต็มงบ เหลือ ${U.formatMoney(left)}`; }
    else { status = 'good'; icon = '✅'; msg = `เหลือ ${U.formatMoney(left)}`; }
    return `<div class="card budget">
      <div class="budget-head"><span>งบรายจ่ายเดือนนี้</span><span class="muted">${U.formatMoney(spent)} / ${U.formatMoney(budget)}</span></div>
      <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(0)}"><div class="meter-fill ${status}" style="width:${pct}%"></div></div>
      <div class="budget-msg">${icon} ${msg}</div>
    </div>`;
  }

  function renderList() {
    const box = $('#txList');
    if (!box) return;
    const q = state.q.trim().toLowerCase();
    const all = U.filterByMonth(S.transactions, state.year, state.month);
    const txs = all.filter((t) => (state.type === 'all' || t.type === state.type) &&
      (!q || (t.note || '').toLowerCase().includes(q) || catName(t.categoryId).toLowerCase().includes(q)));

    if (!all.length) {
      box.innerHTML = `<div class="empty"><div class="empty-icon">🧾</div><p>ยังไม่มีรายการในเดือนนี้</p>
        <button class="btn primary" data-act="add">+ บันทึกรายการแรก</button>
        ${S.transactions.length ? '' : '<button class="btn ghost" data-act="sample">ลองใช้ข้อมูลตัวอย่าง</button>'}</div>`;
      return;
    }
    if (!txs.length) { box.innerHTML = '<div class="empty"><p>ไม่พบรายการที่ตรงกับตัวกรอง</p></div>'; return; }

    box.innerHTML = U.groupByDate(txs).map((g) => `
      <section class="day">
        <header class="day-head"><span>${esc(U.dayLabel(g.date))}</span><span class="${moneyCls(g.net)}">${U.formatSigned(g.net)}</span></header>
        <ul class="tx-list">
          ${g.items.map((t) => `
            <li><button class="tx" data-act="edit-tx" data-id="${esc(t.id)}">
              <span class="tx-icon" style="--cat:${catColor(S.getCategory(t.categoryId))}">${esc(catIcon(t.categoryId))}</span>
              <span class="tx-main"><span class="tx-cat">${esc(catName(t.categoryId))}</span>${t.note ? `<span class="tx-note">${esc(t.note)}</span>` : ''}</span>
              <span class="tx-amt ${t.type === 'income' ? 'pos' : 'neg'}">${t.type === 'income' ? '+' : '−'}${U.formatMoney(t.amount)}</span>
            </button></li>`).join('')}
        </ul>
      </section>`).join('');
  }

  /* ---------- Monthly summary ---------- */

  function categoryTable(rows, total, type) {
    if (!rows.length) return '<p class="muted pad">ไม่มีข้อมูล</p>';
    return `<table class="table cat-table">
      <thead><tr><th>หมวดหมู่</th><th class="num">จำนวนเงิน</th><th class="num">สัดส่วน</th></tr></thead>
      <tbody>${rows.map((r) => {
        const cat = S.getCategory(r.categoryId);
        const pct = total ? (r.total / total) * 100 : 0;
        return `<tr>
          <td><span class="swatch" style="background:${catColor(cat)}"></span>${esc(catIcon(r.categoryId))} ${esc(catName(r.categoryId))} <span class="muted small">(${r.count})</span>
            <div class="pct-bar"><span style="width:${pct}%;background:${catColor(cat)}"></span></div></td>
          <td class="num">${U.formatMoney(r.total)}</td>
          <td class="num">${pct.toFixed(1)}%</td></tr>`;
      }).join('')}</tbody>
      <tfoot><tr><td>รวม${type === 'income' ? 'รายรับ' : 'รายจ่าย'}</td><td class="num">${U.formatMoney(total)}</td><td class="num">100%</td></tr></tfoot>
    </table>`;
  }

  /** Donut segments in category order (color = entity); categories past slot 8 fold into "อื่นๆ". */
  function donutSegments(rows, type, total) {
    const byId = new Map(rows.map((r) => [r.categoryId, r.total]));
    const segs = [];
    let other = 0;
    for (const cat of S.categories[type]) {
      const v = byId.get(cat.id) || 0;
      byId.delete(cat.id);
      if (!v) continue;
      if (catColor(cat) === 'var(--s-other)') { other += v; continue; }
      segs.push({ label: cat.name, value: v, color: catColor(cat), tip: `${cat.icon} ${cat.name}\n${U.formatMoney(v)} (${((v / total) * 100).toFixed(1)}%)` });
    }
    for (const v of byId.values()) other += v; // deleted / unknown categories
    if (other) segs.push({ label: 'อื่นๆ', value: other, color: 'var(--s-other)', tip: `อื่นๆ\n${U.formatMoney(other)} (${((other / total) * 100).toFixed(1)}%)` });
    return segs;
  }

  function renderSummary() {
    const { year, month } = state;
    const txs = U.filterByMonth(S.transactions, year, month);
    const t = U.totals(txs);
    const prevD = new Date(year, month - 1, 1);
    const p = U.totals(U.filterByMonth(S.transactions, prevD.getFullYear(), prevD.getMonth()));
    const savingRate = t.income > 0 ? (t.net / t.income) * 100 : null;
    const exp = U.byCategory(txs, 'expense');
    const inc = U.byCategory(txs, 'income');

    const days = U.byDay(S.transactions, year, month);
    const elapsed = isCurrentMonth() ? today.getDate() : days.length;
    const avgDay = elapsed ? t.expense / elapsed : 0;
    const maxDayIdx = days.reduce((best, d, i) => (d.expense > days[best].expense ? i : best), 0);
    const top = txs.filter((x) => x.type === 'expense').sort((a, b) => b.amount - a.amount).slice(0, 5);

    view.innerHTML = `
      <div class="page-head">${monthSwitcher()}<button class="btn ghost no-print" data-act="print">🖨️ พิมพ์/บันทึก PDF</button></div>
      <p class="print-only print-title">สรุปรายรับรายจ่าย ${esc(U.monthLabel(year, month))}</p>
      <div class="stats four">
        ${stat('รายรับ', U.formatMoney(t.income), 'income', deltaText(t.income, p.income, true))}
        ${stat('รายจ่าย', U.formatMoney(t.expense), 'expense', deltaText(t.expense, p.expense, false))}
        ${stat('คงเหลือ', `<span class="${moneyCls(t.net)}">${U.formatSigned(t.net)}</span>`, 'net', `<span class="muted">เดือนก่อน ${U.formatSigned(p.net)}</span>`)}
        ${stat('อัตราการออม', savingRate === null ? '—' : `<span class="${moneyCls(savingRate)}">${savingRate.toFixed(0)}%</span>`, '', '<span class="muted">ของรายรับที่เหลือเก็บ</span>')}
      </div>
      ${!txs.length ? '<div class="empty"><div class="empty-icon">📊</div><p>ยังไม่มีข้อมูลในเดือนนี้</p><button class="btn primary" data-act="add">+ บันทึกรายการ</button></div>' : `
      <div class="grid-2">
        <section class="card">
          <h2>รายจ่ายตามหมวดหมู่</h2>
          ${exp.length ? `<div class="donut-wrap">${C.donut(donutSegments(exp, 'expense', t.expense), { label: 'สัดส่วนรายจ่ายตามหมวดหมู่', centerTop: U.formatMoney(t.expense, { noDecimals: true }), centerBottom: 'รายจ่ายรวม' })}</div>` : ''}
          ${categoryTable(exp, t.expense, 'expense')}
        </section>
        <section class="card">
          <h2>รายรับตามหมวดหมู่</h2>
          ${categoryTable(inc, t.income, 'income')}
          <h2 class="mt">5 รายจ่ายสูงสุด</h2>
          ${top.length ? `<ol class="top-list">${top.map((x) => `<li><button class="tx compact" data-act="edit-tx" data-id="${esc(x.id)}">
            <span>${esc(catIcon(x.categoryId))}</span><span class="tx-main"><span class="tx-cat">${esc(x.note || catName(x.categoryId))}</span><span class="tx-note">${esc(U.dayLabel(x.date))} · ${esc(catName(x.categoryId))}</span></span>
            <span class="tx-amt">${U.formatMoney(x.amount)}</span></button></li>`).join('')}</ol>` : '<p class="muted pad">ไม่มีข้อมูล</p>'}
        </section>
      </div>
      <section class="card">
        <div class="card-head"><h2>รายจ่ายรายวัน</h2>
          <div class="mini-stats"><span>เฉลี่ย <b>${U.formatMoney(avgDay)}</b>/วัน</span>${days[maxDayIdx].expense ? `<span>สูงสุดวันที่ <b>${maxDayIdx + 1}</b> (${U.formatMoney(days[maxDayIdx].expense)})</span>` : ''}</div>
        </div>
        ${C.bars(days.map((d, i) => ({ label: String(i + 1), values: [d.expense], tip: `วันที่ ${i + 1}\nรายจ่าย ${U.formatMoney(d.expense)}${d.income ? `\nรายรับ ${U.formatMoney(d.income)}` : ''}` })),
          [{ label: 'รายจ่าย', color: 'var(--c-expense)' }], { label: 'รายจ่ายรายวัน', labelEvery: 5, height: 200, width: chartWidth() })}
      </section>`}`;
  }

  /* ---------- Yearly summary ---------- */

  function renderYear() {
    const y = state.yearView;
    const months = U.byMonth(S.transactions, y);
    const t = U.totals(U.filterByYear(S.transactions, y));
    const active = months.filter((m) => m.count).length;
    const exp = U.byCategory(U.filterByYear(S.transactions, y), 'expense');
    const best = months.filter((m) => m.count).sort((a, b) => b.net - a.net)[0];

    view.innerHTML = `
      <div class="page-head">
        <div class="switcher">
          <button class="icon-btn" data-act="prev-year" aria-label="ปีก่อน">‹</button>
          <h1>ปี ${esc(U.yearLabel(y))}</h1>
          <button class="icon-btn" data-act="next-year" aria-label="ปีถัดไป">›</button>
        </div>
        <button class="btn ghost no-print" data-act="print">🖨️ พิมพ์/บันทึก PDF</button>
      </div>
      <p class="print-only print-title">สรุปรายรับรายจ่ายประจำปี ${esc(U.yearLabel(y))}</p>
      <div class="stats four">
        ${stat('รายรับทั้งปี', U.formatMoney(t.income), 'income')}
        ${stat('รายจ่ายทั้งปี', U.formatMoney(t.expense), 'expense')}
        ${stat('คงเหลือ', `<span class="${moneyCls(t.net)}">${U.formatSigned(t.net)}</span>`, 'net')}
        ${stat('รายจ่ายเฉลี่ย/เดือน', active ? U.formatMoney(t.expense / active) : '—', '', best ? `<span class="muted">เดือนที่เก็บได้มากสุด: ${esc(U.monthShort(best.month))}</span>` : '')}
      </div>
      <section class="card">
        <div class="card-head"><h2>รายรับ vs รายจ่าย รายเดือน</h2>
          <div class="legend"><span><i style="background:var(--c-income)"></i>รายรับ</span><span><i style="background:var(--c-expense)"></i>รายจ่าย</span></div>
        </div>
        ${C.bars(months.map((m) => ({ label: U.monthShort(m.month), values: [m.income, m.expense], key: String(m.month),
          tip: `${U.monthLabel(y, m.month)}\nรายรับ ${U.formatMoney(m.income)}\nรายจ่าย ${U.formatMoney(m.expense)}\nคงเหลือ ${U.formatSigned(m.net)}\n(แตะเพื่อดูสรุปเดือน)` })),
          [{ label: 'รายรับ', color: 'var(--c-income)' }, { label: 'รายจ่าย', color: 'var(--c-expense)' }], { label: 'รายรับและรายจ่ายรายเดือน', width: chartWidth(), labelEvery: chartWidth() < 480 ? 2 : 1 })}
      </section>
      <div class="grid-2">
        <section class="card">
          <h2>ตารางสรุปรายเดือน</h2>
          <div class="table-wrap"><table class="table month-table">
            <thead><tr><th>เดือน</th><th class="num">รายรับ</th><th class="num">รายจ่าย</th><th class="num">คงเหลือ</th></tr></thead>
            <tbody>${months.map((m) => `<tr class="${m.count ? 'link' : 'dim'}" ${m.count ? `data-act="goto-month" data-key="${m.month}" tabindex="0"` : ''}>
              <td>${esc(U.monthShort(m.month))}</td><td class="num">${m.income ? U.formatMoney(m.income, { noDecimals: true }) : '–'}</td>
              <td class="num">${m.expense ? U.formatMoney(m.expense, { noDecimals: true }) : '–'}</td><td class="num ${moneyCls(m.net)}">${m.count ? U.formatSigned(m.net, { noDecimals: true }) : '–'}</td></tr>`).join('')}</tbody>
            <tfoot><tr><td>รวม</td><td class="num">${U.formatMoney(t.income, { noDecimals: true })}</td><td class="num">${U.formatMoney(t.expense, { noDecimals: true })}</td><td class="num ${moneyCls(t.net)}">${U.formatSigned(t.net, { noDecimals: true })}</td></tr></tfoot>
          </table></div>
        </section>
        <section class="card">
          <h2>รายจ่ายตามหมวดหมู่ทั้งปี</h2>
          ${categoryTable(exp, t.expense, 'expense')}
        </section>
      </div>`;
  }

  /* ---------- Settings ---------- */

  function renderSettings() {
    const catSection = (type, title) => `
      <section class="card">
        <h2>${title}</h2>
        <ul class="cat-list">
          ${S.categories[type].map((c) => `<li>
            <span class="swatch" style="background:${catColor(c)}"></span>
            <input class="cat-icon-input" value="${esc(c.icon)}" maxlength="4" data-cat-icon="${esc(c.id)}" aria-label="ไอคอน">
            <input class="cat-name-input" value="${esc(c.name)}" maxlength="30" data-cat-name="${esc(c.id)}" aria-label="ชื่อหมวดหมู่">
            <span class="muted small">${S.usageCount(c.id)} รายการ</span>
            ${c.other ? '<span class="small muted">ค่าเริ่มต้น</span>' : `<button class="icon-btn danger-text" data-act="del-cat" data-type="${type}" data-id="${esc(c.id)}" aria-label="ลบ ${esc(c.name)}">✕</button>`}
          </li>`).join('')}
        </ul>
        <form class="add-cat" data-type="${type}">
          <input name="icon" placeholder="${type === 'income' ? '💵' : '🏷️'}" maxlength="4" class="cat-icon-input" aria-label="ไอคอน">
          <input name="name" placeholder="ชื่อหมวดหมู่ใหม่" maxlength="30" required aria-label="ชื่อหมวดหมู่ใหม่">
          <button class="btn">เพิ่ม</button>
        </form>
      </section>`;

    view.innerHTML = `
      <h1 class="page-title">ตั้งค่า</h1>
      ${migrationBanner()}
      ${accountSection()}
      <section class="card">
        <h2>งบประมาณรายจ่ายต่อเดือน</h2>
        <form id="budgetForm" class="row">
          <input id="budgetInput" inputmode="decimal" placeholder="เช่น 20000 (เว้นว่าง = ไม่ใช้งบ)" value="${S.settings.budget || ''}" aria-label="งบประมาณ">
          <button class="btn primary">บันทึก</button>
        </form>
        <p class="muted small">แสดงแถบงบประมาณในหน้ารายการ และเตือนเมื่อใช้เกิน 80%</p>
      </section>
      <div class="grid-2">${catSection('expense', 'หมวดหมู่รายจ่าย')}${catSection('income', 'หมวดหมู่รายรับ')}</div>
      <section class="card">
        <h2>ข้อมูล</h2>
        <p class="muted small">${Cloud.user ? `ข้อมูลทั้งหมด ${S.transactions.length} รายการ ซิงก์กับบัญชีของคุณ` : `ข้อมูลทั้งหมดถูกเก็บไว้ในเบราว์เซอร์นี้เท่านั้น (ทั้งหมด ${S.transactions.length} รายการ) แนะนำให้สำรองข้อมูลเป็นระยะ`}</p>
        <div class="btn-row">
          <button class="btn" data-act="export-csv">⬇️ ส่งออก CSV (Excel)</button>
          <button class="btn" data-act="export-json">💾 สำรองข้อมูล (JSON)</button>
          <label class="btn">📂 กู้คืนจากไฟล์สำรอง<input type="file" id="importFile" accept="application/json,.json" hidden></label>
          <button class="btn ghost" data-act="sample">✨ เพิ่มข้อมูลตัวอย่าง</button>
          <button class="btn danger" data-act="reset">🗑️ ลบข้อมูลทั้งหมด</button>
        </div>
      </section>`;

    const cfgForm = $('#cfgForm');
    if (cfgForm) cfgForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = cfgForm.url.value.trim(), key = cfgForm.key.value.trim();
      if (!/^https:\/\/.+/.test(url) || key.length < 20) return toast('กรุณากรอก URL และ key ให้ถูกต้อง');
      Cloud.saveConfig(url, key);
      Cloud.leaveLocalMode();
      location.reload();
    });

    $('#budgetForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = $('#budgetInput').value.trim();
      const v = raw ? U.parseAmount(raw) : 0;
      if (raw && !v) return toast('กรุณากรอกตัวเลขที่ถูกต้อง');
      S.setBudget(v);
      toast(v ? `ตั้งงบ ${U.formatMoney(v)} ต่อเดือนแล้ว` : 'ปิดการใช้งบประมาณแล้ว');
    });
    view.querySelectorAll('.add-cat').forEach((f) => f.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = f.name.value.trim();
      if (!name) return;
      S.addCategory(f.dataset.type, name, f.icon.value.trim());
      toast(`เพิ่มหมวดหมู่ "${name}" แล้ว`);
      render();
    }));
    view.querySelectorAll('[data-cat-name]').forEach((inp) => inp.addEventListener('change', () => {
      const v = inp.value.trim();
      if (v) { S.updateCategory(inp.dataset.catName, { name: v }); toast('บันทึกชื่อแล้ว'); }
    }));
    view.querySelectorAll('[data-cat-icon]').forEach((inp) => inp.addEventListener('change', () => {
      const v = inp.value.trim();
      if (v) S.updateCategory(inp.dataset.catIcon, { icon: v });
    }));
    $('#importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!confirm('การกู้คืนจะแทนที่ข้อมูลปัจจุบันทั้งหมด ต้องการดำเนินการต่อหรือไม่?')) { e.target.value = ''; return; }
      try {
        const n = S.importJSON(await file.text());
        toast(`กู้คืนข้อมูลสำเร็จ ${n} รายการ`);
        render();
      } catch (err) {
        toast('ไม่สามารถอ่านไฟล์ได้: ' + err.message);
      }
    });
  }

  function accountSection() {
    if (Cloud.user) {
      const n = Cloud.pendingCount();
      return `<section class="card">
        <h2>บัญชีและการซิงก์</h2>
        <div class="account-row"><span class="avatar">${esc((Cloud.user.email || '?')[0].toUpperCase())}</span>
          <div><div><b>${esc(Cloud.user.email || '')}</b></div><div class="small">${syncText()}${n ? ` · รอส่ง ${n} รายการ` : ''}</div></div></div>
        <p class="muted small">เข้าสู่ระบบด้วยอีเมลนี้บนอุปกรณ์อื่น ข้อมูลจะตรงกันอัตโนมัติ</p>
        <div class="btn-row">
          ${Cloud.available ? '<button class="btn" data-act="sync-now">🔄 ซิงก์ตอนนี้</button><button class="btn" data-act="change-password">🔑 เปลี่ยนรหัสผ่าน</button>' : ''}
          <button class="btn danger" data-act="sign-out">ออกจากระบบ</button>
        </div>
      </section>`;
    }
    if (Cloud.configured) {
      return `<section class="card">
        <h2>บัญชีและการซิงก์</h2>
        <p class="muted small">ตอนนี้ใช้งานแบบไม่ล็อกอิน ข้อมูลอยู่ในเครื่องนี้เท่านั้น เข้าสู่ระบบเพื่อใช้ข้อมูลเดียวกันได้ทุกอุปกรณ์</p>
        ${Cloud.available ? '<button class="btn primary" data-act="go-login">เข้าสู่ระบบ / สมัครสมาชิก</button>' : '<p class="small">⚠️ เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (ออฟไลน์?) ลองใหม่เมื่อออนไลน์</p>'}
        ${Cloud.configSource === 'browser' ? '<button class="btn ghost" data-act="clear-config">ยกเลิกการเชื่อมต่อ Supabase</button>' : ''}
      </section>`;
    }
    return `<section class="card">
      <h2>ซิงก์ข้ามอุปกรณ์ (Supabase)</h2>
      <p class="muted small">ยังไม่ได้เชื่อมต่อ ข้อมูลอยู่ในเครื่องนี้เท่านั้น ใส่ค่าจากโปรเจกต์ Supabase ของคุณ (Project Settings → API) เพื่อเปิดใช้การล็อกอินและซิงก์
      — หรือใส่ไว้ในไฟล์ <code>js/config.js</code> เพื่อให้ทุกอุปกรณ์ใช้ได้ทันที</p>
      <form id="cfgForm" class="cfg-form">
        <input name="url" placeholder="https://xxxx.supabase.co" autocomplete="off" aria-label="Supabase URL">
        <input name="key" placeholder="anon / publishable key" autocomplete="off" aria-label="Supabase anon key">
        <button class="btn primary">เชื่อมต่อ</button>
      </form>
    </section>`;
  }

  /* ---------- Sign-in screen ---------- */

  let authTab = 'signin';
  function renderAuth() {
    const signup = authTab === 'signup';
    view.innerHTML = `
      <div class="auth">
        <div class="auth-card card">
          <div class="auth-logo"><span class="brand-mark big">฿</span></div>
          <h1>${signup ? 'สร้างบัญชี AITRACK' : 'เข้าสู่ระบบ AITRACK'}</h1>
          <p class="muted">บันทึกรายรับรายจ่าย ดูได้ทุกอุปกรณ์</p>
          <div class="seg auth-tabs">
            <button type="button" data-act="auth-tab" data-tab="signin" aria-selected="${!signup}">เข้าสู่ระบบ</button>
            <button type="button" data-act="auth-tab" data-tab="signup" aria-selected="${signup}">สมัครสมาชิก</button>
          </div>
          <form id="authForm" class="auth-form">
            <label class="field"><span class="field-label">อีเมล</span><input type="email" name="email" autocomplete="email" required></label>
            <label class="field"><span class="field-label">รหัสผ่าน</span><input type="password" name="password" minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}" required></label>
            <p id="authMsg" class="error" role="alert"></p>
            <button class="btn primary block" type="submit">${signup ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ'}</button>
          </form>
          ${signup ? '' : '<button class="link-btn" data-act="forgot">ลืมรหัสผ่าน?</button>'}
          <div class="divider"><span>หรือ</span></div>
          <button class="btn ghost block" data-act="use-local">ใช้งานโดยไม่ล็อกอิน (เก็บในเครื่องนี้เท่านั้น)</button>
        </div>
      </div>`;
    const f = $('#authForm');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#authMsg');
      const btn = f.querySelector('button[type=submit]');
      msg.textContent = ''; msg.classList.remove('ok');
      const email = f.email.value.trim(), password = f.password.value;
      if (!email || password.length < 6) { msg.textContent = 'กรอกอีเมล และรหัสผ่านอย่างน้อย 6 ตัวอักษร'; return; }
      btn.disabled = true; btn.textContent = 'กำลังดำเนินการ…';
      try {
        if (signup) {
          const needConfirm = await Cloud.signUp(email, password);
          if (needConfirm) {
            authTab = 'signin';
            render();
            $('#authMsg').classList.add('ok');
            $('#authMsg').textContent = `ส่งลิงก์ยืนยันไปที่ ${email} แล้ว กดยืนยันในอีเมลแล้วกลับมาเข้าสู่ระบบ`;
            $('#authForm').email.value = email;
            return;
          }
        } else {
          await Cloud.signIn(email, password);
        }
        toast('เข้าสู่ระบบแล้ว');
        if (currentRoute() === 'home') render(); else location.hash = '#/';
      } catch (err) {
        msg.textContent = err.message;
        btn.disabled = false; btn.textContent = signup ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ';
      }
    });
  }

  /* ---------- Sync badge ---------- */

  function syncText() {
    const n = Cloud.pendingCount();
    switch (Cloud.status) {
      case 'synced': return '☁️ ซิงก์แล้ว';
      case 'syncing': return '⏳ กำลังซิงก์…';
      case 'offline': return `📴 ออฟไลน์${n ? ` (รอส่ง ${n})` : ''}`;
      case 'error': return '⚠️ ซิงก์ไม่สำเร็จ จะลองใหม่อัตโนมัติ';
      default: return '';
    }
  }
  function paintSyncBadge() {
    const b = $('#syncBadge');
    if (!b) return;
    const show = !!Cloud.user;
    b.hidden = !show;
    if (!show) return;
    b.dataset.status = Cloud.status;
    b.textContent = syncText();
    b.title = Cloud.lastError ? String(Cloud.lastError.message || Cloud.lastError) : (Cloud.user.email || '');
  }

  /* ---------- Add / edit dialog ---------- */

  const dlg = $('#txDialog');
  const form = $('#txForm');
  let editing = null;
  let formType = 'expense';
  let formCat = null;

  function openDialog(tx) {
    editing = tx || null;
    formType = tx ? tx.type : (state.type === 'income' ? 'income' : 'expense');
    formCat = tx ? tx.categoryId : null;
    $('#txTitle').textContent = tx ? 'แก้ไขรายการ' : 'บันทึกรายการใหม่';
    $('#fAmount').value = tx ? String(tx.amount) : '';
    $('#fDate').value = tx ? tx.date : (isCurrentMonth() ? U.toISODate(today) : U.toISODate(new Date(state.year, state.month, 1)));
    $('#fNote').value = tx ? tx.note : '';
    $('#fDelete').hidden = !tx;
    $('#fErr').textContent = '';
    paintForm();
    dlg.showModal();
    setTimeout(() => $('#fAmount').focus(), 50);
  }

  function paintForm() {
    form.dataset.type = formType;
    form.querySelectorAll('[data-ftype]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ftype === formType)));
    const cats = S.categories[formType];
    if (!cats.some((c) => c.id === formCat)) formCat = cats[0].id;
    $('#fCats').innerHTML = cats.map((c) => `<button type="button" class="cat-chip" data-cat="${esc(c.id)}" aria-pressed="${c.id === formCat}">
      <span class="cat-chip-icon">${esc(c.icon)}</span><span>${esc(c.name)}</span></button>`).join('');
  }

  form.addEventListener('click', (e) => {
    const t = e.target.closest('[data-ftype]');
    if (t) { formType = t.dataset.ftype; paintForm(); return; }
    const c = e.target.closest('[data-cat]');
    if (c) { formCat = c.dataset.cat; form.querySelectorAll('[data-cat]').forEach((b) => b.setAttribute('aria-pressed', String(b === c))); }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = U.parseAmount($('#fAmount').value);
    const date = $('#fDate').value;
    if (!amount) { $('#fErr').textContent = 'กรุณากรอกจำนวนเงินที่มากกว่า 0'; $('#fAmount').focus(); return; }
    if (!date) { $('#fErr').textContent = 'กรุณาเลือกวันที่'; return; }
    const payload = { type: formType, amount, categoryId: formCat, date, note: $('#fNote').value.trim() };
    if (editing) { S.updateTransaction(editing.id, payload); toast('แก้ไขรายการแล้ว'); }
    else { S.addTransaction(payload); toast(`บันทึก${formType === 'income' ? 'รายรับ' : 'รายจ่าย'} ${U.formatMoney(amount)} แล้ว`); }
    // Jump to the month of the saved item so the user sees it.
    const d = U.parseISODate(date);
    state.year = d.getFullYear(); state.month = d.getMonth();
    dlg.close();
    render();
  });

  $('#fCancel').addEventListener('click', () => dlg.close());
  $('#fDelete').addEventListener('click', () => {
    if (!editing) return;
    const removed = S.deleteTransaction(editing.id);
    dlg.close();
    render();
    toast('ลบรายการแล้ว', 'เลิกทำ', () => { S.restoreTransaction(removed); render(); });
  });
  // Close when clicking the backdrop.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  /* ---------- Global actions ---------- */

  function download(name, content, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  const actions = {
    'prev-month': () => shiftMonth(-1),
    'next-month': () => shiftMonth(1),
    'this-month': () => { state.year = today.getFullYear(); state.month = today.getMonth(); render(); },
    'prev-year': () => { state.yearView--; render(); },
    'next-year': () => { state.yearView++; render(); },
    'filter-type': (el) => { state.type = el.dataset.type; view.querySelectorAll('[data-act="filter-type"]').forEach((b) => b.setAttribute('aria-selected', String(b === el))); renderList(); },
    'edit-tx': (el) => { const tx = S.transactions.find((t) => t.id === el.dataset.id); if (tx) openDialog(tx); },
    'add': () => openDialog(),
    'goto-month': (el) => { state.year = state.yearView; state.month = Number(el.dataset.key); location.hash = '#/summary'; },
    'print': () => window.print(),
    'export-csv': () => download(`aitrack-${U.toISODate(new Date())}.csv`, U.toCSV(S.transactions, catName), 'text/csv;charset=utf-8'),
    'export-json': () => download(`aitrack-backup-${U.toISODate(new Date())}.json`, S.exportJSON(), 'application/json'),
    'sample': () => { S.loadSample(); toast('เพิ่มข้อมูลตัวอย่าง 6 เดือนแล้ว'); render(); },
    'reset': () => { if (confirm('ลบข้อมูลทั้งหมดรวมถึงหมวดหมู่ที่ตั้งไว้? การกระทำนี้ย้อนกลับไม่ได้')) { S.reset(); toast('ลบข้อมูลทั้งหมดแล้ว'); render(); } },
    'auth-tab': (el) => { authTab = el.dataset.tab; render(); },
    'use-local': () => { Cloud.useLocalMode(); render(); },
    'go-login': () => { Cloud.leaveLocalMode(); authTab = 'signin'; render(); },
    'forgot': async () => {
      const email = ($('#authForm') && $('#authForm').email.value.trim()) || prompt('อีเมลที่ใช้สมัคร');
      if (!email) return;
      try { await Cloud.resetPassword(email); toast(`ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่ ${email} แล้ว`); }
      catch (err) { toast(err.message); }
    },
    'change-password': async () => {
      const pw = prompt('รหัสผ่านใหม่ (อย่างน้อย 6 ตัวอักษร)');
      if (!pw) return;
      try { await Cloud.updatePassword(pw); toast('เปลี่ยนรหัสผ่านแล้ว'); } catch (err) { toast(err.message); }
    },
    'sign-out': async () => {
      const n = Cloud.pendingCount();
      if (!confirm(n ? `ยังมี ${n} รายการที่ยังไม่ได้ซิงก์ (อาจออฟไลน์อยู่) ออกจากระบบตอนนี้ข้อมูลส่วนนั้นจะหายไป ต้องการออกจากระบบหรือไม่?` : 'ออกจากระบบ? ข้อมูลยังอยู่ในบัญชี เข้าสู่ระบบอีกครั้งเพื่อดูได้')) return;
      await Cloud.signOut();
      location.hash = '#/';
      render();
    },
    'sync-now': async () => { toast('กำลังซิงก์…'); await Cloud.syncNow(); toast(Cloud.status === 'synced' ? 'ซิงก์เรียบร้อย' : syncText()); render(); },
    'clear-config': () => { if (confirm('ยกเลิกการเชื่อมต่อ Supabase ในเบราว์เซอร์นี้?')) { Cloud.clearConfig(); location.reload(); } },
    'migrate': () => { const n = Cloud.migrateLocalData(); toast(`ย้ายข้อมูล ${n} รายการขึ้นบัญชีแล้ว`); render(); },
    'skip-migrate': () => { Cloud.skipMigration(); render(); },
    'del-cat': (el) => {
      const cat = S.getCategory(el.dataset.id);
      const n = S.usageCount(el.dataset.id);
      if (!confirm(`ลบหมวดหมู่ "${cat.name}"?${n ? `\n${n} รายการในหมวดนี้จะถูกย้ายไป "อื่นๆ"` : ''}`)) return;
      S.deleteCategory(el.dataset.type, el.dataset.id);
      render();
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && actions[el.dataset.act]) { e.preventDefault(); actions[el.dataset.act](el); }
  });
  // Bar slots in the yearly chart open that month's summary.
  view.addEventListener('click', (e) => {
    const slot = e.target.closest('.hit-slot[data-key]');
    if (slot && currentRoute() === 'year') actions['goto-month'](slot);
  });
  view.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('tr[data-act]')) actions['goto-month'](e.target);
  });
  document.addEventListener('keydown', (e) => {
    if (dlg.open || e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n' || e.key === '+') { e.preventDefault(); openDialog(); }
    if (currentRoute() === 'home' || currentRoute() === 'summary') {
      if (e.key === 'ArrowLeft') shiftMonth(-1);
      if (e.key === 'ArrowRight') shiftMonth(1);
    }
  });
  $('#addBtn').addEventListener('click', () => openDialog());

  /* ---------- Tooltip ---------- */

  const tip = $('#tip');
  function showTip(text, x, y) {
    tip.textContent = text;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8);
    const top = y - r.height - 14 < 8 ? y + 18 : y - r.height - 14;
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }
  function hideTip() { tip.hidden = true; document.querySelectorAll('.hovered').forEach((n) => n.classList.remove('hovered')); }
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && el.dataset.tip) {
      if (!el.classList.contains('hovered')) { hideTip(); el.classList.add('hovered'); }
      showTip(el.dataset.tip, e.clientX, e.clientY);
    } else if (!tip.hidden) hideTip();
  });
  window.addEventListener('scroll', hideTip, { passive: true });

  /* ---------- Toast ---------- */

  const toastEl = $('#toast');
  let toastTimer;
  function toast(msg, actionLabel, onAction) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button>${esc(actionLabel)}</button>` : ''}`;
    if (actionLabel) toastEl.querySelector('button').onclick = () => { onAction(); toastEl.classList.remove('show'); };
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), actionLabel ? 5000 : 2500);
  }

  /* ---------- Boot ---------- */

  let resizeTimer, lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (Math.abs(window.innerWidth - lastW) > 40 && !dlg.open && ['summary', 'year'].includes(currentRoute())) { lastW = window.innerWidth; render(); } }, 200);
  });
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

  /* ---------- Live updates from other devices ---------- */

  let remoteTimer;
  /** Re-render after a remote change without stealing focus from an input or closing the dialog. */
  function scheduleRender() {
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(() => {
      const typing = document.activeElement && view.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
      if (dlg.open || typing) { pendingRender = true; return; }
      render();
    }, 150);
  }
  dlg.addEventListener('close', () => { if (pendingRender) render(); });
  view.addEventListener('focusout', () => setTimeout(() => {
    if (pendingRender && !(document.activeElement && view.contains(document.activeElement))) render();
  }, 0));
  Cloud.onRemoteChange(scheduleRender);
  Cloud.onStatus(() => {
    paintSyncBadge();
    const n = $('.account-row .small');
    if (n) n.textContent = syncText() + (Cloud.pendingCount() ? ` · รอส่ง ${Cloud.pendingCount()} รายการ` : '');
  });
  Cloud.onAuth(async (event) => {
    if (event === 'password-recovery') {
      const pw = prompt('ตั้งรหัสผ่านใหม่ (อย่างน้อย 6 ตัวอักษร)');
      if (pw) { try { await Cloud.updatePassword(pw); toast('ตั้งรหัสผ่านใหม่แล้ว'); } catch (err) { toast(err.message); } }
    }
    scheduleRender();
  });
  $('#syncBadge').addEventListener('click', () => { location.hash = '#/settings'; });

  Cloud.init().catch((e) => console.error('Cloud init failed', e)).finally(render);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
