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
      { id: 'food', name: 'อาหาร', icon: '🍜' },
      { id: 'transport', name: 'เดินทาง', icon: '🚗' },
      { id: 'home', name: 'ที่พัก/ค่าเช่า', icon: '🏠' },
      { id: 'bills', name: 'ค่าน้ำ/ไฟ/เน็ต', icon: '💡' },
      { id: 'shopping', name: 'ช้อปปิ้ง', icon: '🛍️' },
      { id: 'health', name: 'สุขภาพ', icon: '💊' },
      { id: 'fun', name: 'บันเทิง', icon: '🎬' },
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

  const clone = (o) => JSON.parse(JSON.stringify(o));

  function fresh() {
    return { version: 1, transactions: [], categories: clone(DEFAULT_CATEGORIES), settings: { budget: 0 } };
  }

  function normTx(t) {
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || (t.type !== 'income' && t.type !== 'expense') || !(Number(t.amount) > 0)) return null;
    return {
      id: String(t.id || U.uid()), type: t.type, amount: U.round2(Number(t.amount)),
      categoryId: String(t.categoryId || ''), date: t.date, note: String(t.note || ''), createdAt: Number(t.createdAt) || 0,
    };
  }

  function normCategories(c) {
    const base = DEFAULT_CATEGORIES;
    const ok = (list) => Array.isArray(list) && list.length && list.every((x) => x && x.id && x.name);
    return {
      expense: ok(c && c.expense) ? c.expense : clone(base.expense),
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
      settings: Object.assign(base.settings, d.settings || {}),
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
      save(); settingsChanged();
      return added;
    },

    /* ----- applied by the sync layer (never re-emitted) ----- */
    replaceFromRemote(transactions, settingsRow) {
      data.transactions = transactions.map(normTx).filter(Boolean);
      if (settingsRow) {
        data.categories = normCategories(settingsRow.categories);
        data.settings.budget = Number(settingsRow.budget) || 0;
      }
      save();
    },
    applyRemoteUpsert(tx) {
      const t = normTx(tx);
      if (!t) return;
      const i = data.transactions.findIndex((x) => x.id === t.id);
      if (i >= 0) data.transactions[i] = t; else data.transactions.push(t);
      save();
    },
    applyRemoteDelete(id) {
      const i = data.transactions.findIndex((x) => x.id === id);
      if (i >= 0) { data.transactions.splice(i, 1); save(); }
    },
    applyRemoteSettings(row) {
      data.categories = normCategories(row.categories);
      data.settings.budget = Number(row.budget) || 0;
      save();
    },

    loadSample() {
      const now = new Date();
      const rand = (a, b) => Math.round((a + Math.random() * (b - a)) / 5) * 5;
      const notes = { food: ['ข้าวกลางวัน', 'กาแฟ', 'มื้อเย็น', 'ซื้อของสด'], transport: ['BTS', 'เติมน้ำมัน', 'แท็กซี่'], shopping: ['เสื้อผ้า', 'ของใช้ในบ้าน'], fun: ['ดูหนัง', 'Netflix'], health: ['ร้านยา'] };
      const has = (id) => !!Store.getCategory(id);
      for (let back = 5; back >= 0; back--) {
        const y = new Date(now.getFullYear(), now.getMonth() - back, 1);
        const yr = y.getFullYear(), mo = y.getMonth();
        const lastDay = back === 0 ? now.getDate() : U.daysInMonth(yr, mo);
        const d = (day) => U.toISODate(new Date(yr, mo, Math.min(day, lastDay)));
        const push = (type, categoryId, amount, day, note) => {
          if (!has(categoryId)) categoryId = (data.categories[type].find((c) => c.other) || data.categories[type][0]).id;
          const t = { id: U.uuid(), createdAt: Date.now(), type, categoryId, amount, date: d(day), note: note || '' };
          data.transactions.push(t);
          emit({ kind: 'upsert', tx: t });
        };
        push('income', 'salary', 35000, 1, 'เงินเดือน');
        if (Math.random() > 0.5) push('income', 'freelance', rand(2000, 8000), 15, 'งานออกแบบ');
        push('expense', 'home', 8500, 1, 'ค่าเช่าห้อง');
        push('expense', 'bills', rand(900, 1600), 5, 'ค่าไฟ + เน็ต');
        for (let day = 1; day <= lastDay; day++) {
          push('expense', 'food', rand(80, 350), day, notes.food[day % 4]);
          if (day % 2 === 0) push('expense', 'transport', rand(40, 300), day, notes.transport[day % 3]);
          if (day % 9 === 0) push('expense', 'shopping', rand(300, 2500), day, notes.shopping[day % 2]);
          if (day % 11 === 0) push('expense', 'fun', rand(200, 800), day, notes.fun[day % 2]);
          if (day % 17 === 0) push('expense', 'health', rand(100, 600), day, notes.health[0]);
        }
      }
      if (!data.settings.budget) { data.settings.budget = 25000; settingsChanged(); }
      save();
    },
  };

  root.AIStore = Store;
})(self);
