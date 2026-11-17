/*
 * Data layer. Keeps everything in memory and caches it in localStorage.
 * Every mutation is also reported to `Store.sink` (set by cloud.js) so it can be synced to Supabase.
 */
(function (root) {
  'use strict';
  const U = root.AIUtils;
  const LOCAL_KEY = 'aitrack.v1';

  const DEFAULT_CATEGORIES = {
    expense: [
      { id: 'food', name: 'ค่ากิน', icon: '🍜' },
      { id: 'transport', name: 'ค่าเดินทาง', icon: '🚗' },
      { id: 'home', name: 'ค่าห้อง/ที่พัก', icon: '🏠' },
      { id: 'bills', name: 'ค่าน้ำ/ไฟ/เน็ต', icon: '💡' },
      { id: 'shopping', name: 'ช้อปปิ้ง', icon: '🛍️' },
      { id: 'health', name: 'สุขภาพ', icon: '💊' },
      { id: 'fun', name: 'ค่าบันเทิง', icon: '🎬' },
      { id: 'other-exp', name: 'อื่นๆ', icon: '📦', other: true },
    ],
    income: [
      { id: 'salary', name: 'เงินเดือน', icon: '💼' },
      { id: 'bonus', name: 'โบนัส', icon: '🎁' },
      { id: 'freelance', name: 'งานเสริม', icon: '💻' },
      { id: 'invest', name: 'ลงทุน/ดอกเบี้ย', icon: '📈' },
      { id: 'other-inc', name: 'อื่นๆ', icon: '💰', other: true },
    ],
  };

  // Earlier default names, renamed to everyday words. Only untouched defaults are renamed.
  const RENAMED_DEFAULTS = { food: ['อาหาร', 'ค่ากิน'], transport: ['เดินทาง', 'ค่าเดินทาง'], home: ['ที่พัก/ค่าเช่า', 'ค่าห้อง/ที่พัก'], fun: ['บันเทิง', 'ค่าบันเทิง'] };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  function fresh() {
    return { version: 1, transactions: [], categories: clone(DEFAULT_CATEGORIES), settings: { budget: 0, plan: { items: [] } } };
  }

  /** Monthly plan: [{id, kind: 'income'|'fixed'|'budget', categoryId, amount, label}] */
  function normPlan(p) {
    const items = p && Array.isArray(p.items) ? p.items : [];
    return {
      items: items
        .filter((i) => i && ['income', 'fixed', 'budget'].includes(i.kind) && i.categoryId && Number(i.amount) > 0)
        .map((i) => ({ id: String(i.id || U.uid()), kind: i.kind, categoryId: String(i.categoryId), amount: U.round2(Number(i.amount)), label: String(i.label || '').slice(0, 40) })),
    };
  }

  function normSettings(st) {
    const out = { budget: Math.max(0, Number(st && st.budget) || 0), plan: normPlan(st && st.plan) };
    return out;
  }

  function normTx(t) {
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || (t.type !== 'income' && t.type !== 'expense') || !(Number(t.amount) > 0)) return null;
    return {
      id: String(t.id || U.uid()), type: t.type, amount: U.round2(Number(t.amount)),
      categoryId: String(t.categoryId || ''), date: t.date, time: TIME_RE.test(t.time || '') ? t.time : '',
      note: String(t.note || ''), createdAt: Number(t.createdAt) || 0,
    };
  }

  function normCategories(c) {
    const base = DEFAULT_CATEGORIES;
    const ok = (list) => Array.isArray(list) && list.length && list.every((x) => x && x.id && x.name);
    const rename = (x) => (RENAMED_DEFAULTS[x.id] && x.name === RENAMED_DEFAULTS[x.id][0] ? { ...x, name: RENAMED_DEFAULTS[x.id][1] } : x);
    return {
      expense: ok(c && c.expense) ? c.expense.map(rename) : clone(base.expense),
      income: ok(c && c.income) ? c.income : clone(base.income),
    };
  }

  function normalize(d) {
    const base = fresh();
    if (!d || typeof d !== 'object') return base;
    return {
      version: 1,
      transactions: Array.isArray(d.transactions) ? d.transactions.map(normTx).filter(Boolean) : [],
      categories: normCategories(d.categories),
      settings: normSettings(d.settings),
    };
  }

  let key = LOCAL_KEY;
  let data = read(key);
  const listeners = new Set();

  function read(k) {
    try {
      const raw = localStorage.getItem(k);
      return raw ? normalize(JSON.parse(raw)) : fresh();
    } catch (e) {
      console.warn('Could not read saved data', e);
      return fresh();
    }
  }

  function save() {
    try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) { console.error('Could not save data', e); }
    listeners.forEach((fn) => fn());
  }

  /** Report a change to the sync layer (no-op in local mode). */
  function emit(op) { if (Store.sink) Store.sink(op); }
  function settingsChanged() { emit({ kind: 'settings' }); }

  const Store = {
    sink: null,
    DEFAULT_CATEGORIES,

    get transactions() { return data.transactions; },
    get categories() { return data.categories; },
    get settings() { return data.settings; },
    /** Monthly plan items (salary, fixed costs, per-category budgets). */
    get plan() { return data.settings.plan.items; },

    /** Switch which localStorage cache is active (local mode vs. a signed-in user's cache). */
    useNamespace(k) { key = k || LOCAL_KEY; data = read(key); listeners.forEach((fn) => fn()); },
    get namespace() { return key; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Data saved in local (not signed-in) mode, used to offer moving it into an account. */
    readLocalOnly() { return read(LOCAL_KEY); },
    clearLocalOnly() { try { localStorage.removeItem(LOCAL_KEY); } catch (e) { /* ignore */ } },

    getCategory(id) {
      return data.categories.expense.find((c) => c.id === id) || data.categories.income.find((c) => c.id === id) || null;
    },

    addTransaction(tx) {
      const t = { id: U.uuid(), createdAt: Date.now(), note: '', ...tx };
      data.transactions.push(t);
      save();
      emit({ kind: 'upsert', tx: t });
      return t;
    },
    updateTransaction(id, patch) {
      const t = data.transactions.find((x) => x.id === id);
      if (t) { Object.assign(t, patch); save(); emit({ kind: 'upsert', tx: t }); }
      return t;
    },
    deleteTransaction(id) {
      const i = data.transactions.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const [t] = data.transactions.splice(i, 1);
      save();
      emit({ kind: 'delete', id });
      return t;
    },
    restoreTransaction(t) { data.transactions.push(t); save(); emit({ kind: 'upsert', tx: t }); },

    addCategory(type, name, icon) {
      const c = { id: U.uuid(), name, icon: icon || (type === 'income' ? '💵' : '🏷️') };
      const list = data.categories[type];
      const otherIdx = list.findIndex((x) => x.other);
      if (otherIdx >= 0) list.splice(otherIdx, 0, c); else list.push(c);
      save(); settingsChanged();
      return c;
    },
    updateCategory(id, patch) {
      const c = Store.getCategory(id);
      if (c) { Object.assign(c, patch); save(); settingsChanged(); }
    },
    deleteCategory(type, id) {
      const list = data.categories[type];
      if (list.length <= 1) return false;
      const i = list.findIndex((c) => c.id === id);
      if (i < 0) return false;
      list.splice(i, 1);
      // Move existing transactions to the "other" bucket so nothing is orphaned.
      const fallback = list.find((c) => c.other) || list[list.length - 1];
      for (const t of data.transactions) {
        if (t.categoryId === id) { t.categoryId = fallback.id; emit({ kind: 'upsert', tx: t }); }
      }
      save(); settingsChanged();
      return true;
    },
    usageCount(id) { return data.transactions.filter((t) => t.categoryId === id).length; },

    setBudget(v) { data.settings.budget = Math.max(0, Number(v) || 0); save(); settingsChanged(); },

    setPlan(items) { data.settings.plan = normPlan({ items }); save(); settingsChanged(); },
    /** Fixed id for "salary / rent of this month", so recording twice (or on two devices) never duplicates. */
    planTxId(itemId, year, month) { return `plan-${itemId}-${year}-${U.pad(month + 1)}`; },
    planTx(itemId, year, month) { const id = Store.planTxId(itemId, year, month); return data.transactions.find((t) => t.id === id) || null; },
    recordPlanItem(item, year, month, date) {
      const existing = Store.planTx(item.id, year, month);
      if (existing) return existing;
      const cat = Store.getCategory(item.categoryId);
      return Store.addTransaction({
        id: Store.planTxId(item.id, year, month), type: item.kind === 'income' ? 'income' : 'expense',
        amount: item.amount, categoryId: item.categoryId, date, time: '', note: item.label || (cat ? cat.name : ''),
      });
    },

    exportJSON() { return JSON.stringify(data, null, 2); },
    importJSON(text) {
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.transactions)) throw new Error('ไฟล์ไม่ถูกต้อง');
      data = normalize(parsed);
      save();
      emit({ kind: 'wipe' });
      data.transactions.forEach((t) => emit({ kind: 'upsert', tx: t }));
      settingsChanged();
      return data.transactions.length;
    },
    reset() {
      data = fresh();
      save();
      emit({ kind: 'wipe' });
      settingsChanged();
    },

    /** Merge transactions/categories from another dataset (e.g. local data moved into an account). */
    merge(other) {
      const have = new Set(data.transactions.map((t) => t.id));
      let added = 0;
      for (const type of ['expense', 'income']) {
        for (const c of other.categories[type]) {
          if (!Store.getCategory(c.id)) {
            const list = data.categories[type];
            const otherIdx = list.findIndex((x) => x.other);
            if (otherIdx >= 0) list.splice(otherIdx, 0, clone(c)); else list.push(clone(c));
          }
        }
      }
      for (const t of other.transactions) {
        if (have.has(t.id)) continue;
        const copy = clone(t);
        data.transactions.push(copy);
        emit({ kind: 'upsert', tx: copy });
        added++;
      }
      if (!data.settings.budget && other.settings.budget) data.settings.budget = other.settings.budget;
      if (!data.settings.plan.items.length && other.settings.plan && other.settings.plan.items.length) data.settings.plan = normPlan(other.settings.plan);
      save(); settingsChanged();
      return added;
    },

    /* ----- applied by the sync layer (never re-emitted) ----- */
    replaceFromRemote(transactions, settingsRow) {
      const old = new Map(data.transactions.map((t) => [t.id, t]));
      data.transactions = transactions.map((t) => normTx(t.time === undefined && old.has(t.id) ? { ...t, time: old.get(t.id).time } : t)).filter(Boolean);
      if (settingsRow) Store.applyRemoteSettings(settingsRow, true);
      save();
    },
    applyRemoteUpsert(tx) {
      const i = data.transactions.findIndex((x) => x.id === tx.id);
      const t = normTx(tx.time === undefined && i >= 0 ? { ...tx, time: data.transactions[i].time } : tx);
      if (!t) return;
      if (i >= 0) data.transactions[i] = t; else data.transactions.push(t);
      save();
    },
    applyRemoteDelete(id) {
      const i = data.transactions.findIndex((x) => x.id === id);
      if (i >= 0) { data.transactions.splice(i, 1); save(); }
    },
    applyRemoteSettings(row, noSave) {
      data.categories = normCategories(row.categories);
      data.settings.budget = Number(row.budget) || 0;
      // Older databases have no plan column yet: keep the plan stored on this device.
      if (row.plan !== undefined && row.plan !== null) data.settings.plan = normPlan(row.plan);
      if (!noSave) save();
    },

    loadSample() {
      const now = new Date();
      const rand = (a, b) => Math.round((a + Math.random() * (b - a)) / 5) * 5;
      const notes = { food: ['มื้อกลางวัน', 'กาแฟ', 'มื้อเย็น', 'มื้อเช้า'], transport: ['BTS', 'เติมน้ำมัน', 'แท็กซี่'], shopping: ['เสื้อผ้า', 'ของใช้ในบ้าน'], fun: ['ดูหนัง', 'Netflix'], health: ['ร้านยา'] };
      const foodTimes = ['12:15', '09:40', '19:05', '07:30'];
      const has = (id) => !!Store.getCategory(id);
      if (!data.settings.plan.items.length) {
        data.settings.plan = normPlan({ items: [
          { id: 'sample-salary', kind: 'income', categoryId: 'salary', amount: 35000, label: 'เงินเดือน' },
          { id: 'sample-rent', kind: 'fixed', categoryId: 'home', amount: 8500, label: 'ค่าห้อง' },
          { id: 'sample-bills', kind: 'fixed', categoryId: 'bills', amount: 1500, label: 'ค่าน้ำ/ไฟ/เน็ต' },
          { id: 'sample-food', kind: 'budget', categoryId: 'food', amount: 6000 },
          { id: 'sample-transport', kind: 'budget', categoryId: 'transport', amount: 2500 },
          { id: 'sample-fun', kind: 'budget', categoryId: 'fun', amount: 1500 },
        ].filter((i) => has(i.categoryId)) });
        settingsChanged();
      }
      const planItem = (id) => data.settings.plan.items.find((i) => i.id === id);
      for (let back = 5; back >= 0; back--) {
        const y = new Date(now.getFullYear(), now.getMonth() - back, 1);
        const yr = y.getFullYear(), mo = y.getMonth();
        const lastDay = back === 0 ? now.getDate() : U.daysInMonth(yr, mo);
        const d = (day) => U.toISODate(new Date(yr, mo, Math.min(day, lastDay)));
        const push = (type, categoryId, amount, day, note, time, id) => {
          if (!has(categoryId)) categoryId = (data.categories[type].find((c) => c.other) || data.categories[type][0]).id;
          if (id && data.transactions.some((x) => x.id === id)) return;
          const t = { id: id || U.uuid(), createdAt: Date.now(), type, categoryId, amount, date: d(day), time: time || '', note: note || '' };
          data.transactions.push(t);
          emit({ kind: 'upsert', tx: t });
        };
        const planId = (id) => (planItem(id) ? Store.planTxId(id, yr, mo) : null);
        push('income', 'salary', 35000, 1, 'เงินเดือน', '', planId('sample-salary'));
        if (Math.random() > 0.5) push('income', 'freelance', rand(2000, 8000), 15, 'งานออกแบบ', '18:20');
        push('expense', 'home', 8500, 1, 'ค่าห้อง', '', planId('sample-rent'));
        if (back > 0 || lastDay >= 5) push('expense', 'bills', rand(900, 1600), 5, 'ค่าน้ำ/ไฟ/เน็ต', '', planId('sample-bills'));
        for (let day = 1; day <= lastDay; day++) {
          push('expense', 'food', rand(40, 220), day, notes.food[day % 4], foodTimes[day % 4]);
          if (day % 3 !== 0) push('expense', 'food', rand(50, 120), day, notes.food[(day + 1) % 4], foodTimes[(day + 1) % 4]);
          if (day % 2 === 0) push('expense', 'transport', rand(40, 300), day, notes.transport[day % 3], '08:10');
          if (day % 9 === 0) push('expense', 'shopping', rand(300, 2500), day, notes.shopping[day % 2], '15:30');
          if (day % 11 === 0) push('expense', 'fun', rand(200, 800), day, notes.fun[day % 2], '20:45');
          if (day % 17 === 0) push('expense', 'health', rand(100, 600), day, notes.health[0], '10:20');
        }
      }
      save();
    },
  };

  root.AIStore = Store;
})(self);
