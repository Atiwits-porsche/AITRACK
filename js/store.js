/* Data layer: persists transactions, categories and settings in localStorage. */
(function (root) {
  'use strict';
  const U = root.AIUtils;
  const KEY = 'aitrack.v1';

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

  function fresh() {
    return {
      version: 1,
      transactions: [],
      categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)),
      settings: { budget: 0 },
    };
  }

  let data = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return fresh();
      return normalize(JSON.parse(raw));
    } catch (e) {
      console.warn('Could not read saved data', e);
      return fresh();
    }
  }

  function normalize(d) {
    const base = fresh();
    if (!d || typeof d !== 'object') return base;
    return {
      version: 1,
      transactions: Array.isArray(d.transactions)
        ? d.transactions.filter((t) => t && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && (t.type === 'income' || t.type === 'expense') && Number(t.amount) > 0)
            .map((t) => ({ id: String(t.id || U.uid()), type: t.type, amount: U.round2(Number(t.amount)), categoryId: String(t.categoryId || ''), date: t.date, note: String(t.note || ''), createdAt: Number(t.createdAt) || 0 }))
        : [],
      categories: {
        expense: Array.isArray(d.categories && d.categories.expense) && d.categories.expense.length ? d.categories.expense : base.categories.expense,
        income: Array.isArray(d.categories && d.categories.income) && d.categories.income.length ? d.categories.income : base.categories.income,
      },
      settings: Object.assign(base.settings, d.settings || {}),
    };
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('Could not save data', e);
      return false;
    }
  }

  const Store = {
    get transactions() { return data.transactions; },
    get categories() { return data.categories; },
    get settings() { return data.settings; },

    getCategory(id) {
      return data.categories.expense.find((c) => c.id === id) || data.categories.income.find((c) => c.id === id) || null;
    },

    addTransaction(tx) {
      const t = { id: U.uid(), createdAt: Date.now(), note: '', ...tx };
      data.transactions.push(t);
      save();
      return t;
    },
    updateTransaction(id, patch) {
      const t = data.transactions.find((x) => x.id === id);
      if (t) { Object.assign(t, patch); save(); }
      return t;
    },
    deleteTransaction(id) {
      const i = data.transactions.findIndex((x) => x.id === id);
      if (i >= 0) { const [t] = data.transactions.splice(i, 1); save(); return t; }
      return null;
    },
    restoreTransaction(t) { data.transactions.push(t); save(); },

    addCategory(type, name, icon) {
      const c = { id: U.uid(), name, icon: icon || (type === 'income' ? '💵' : '🏷️') };
      const list = data.categories[type];
      const otherIdx = list.findIndex((x) => x.other);
      if (otherIdx >= 0) list.splice(otherIdx, 0, c); else list.push(c);
      save();
      return c;
    },
    updateCategory(id, patch) {
      const c = Store.getCategory(id);
      if (c) { Object.assign(c, patch); save(); }
    },
    deleteCategory(type, id) {
      const list = data.categories[type];
      if (list.length <= 1) return false;
      const i = list.findIndex((c) => c.id === id);
      if (i < 0) return false;
      list.splice(i, 1);
      // Move existing transactions to the "other" bucket so nothing is orphaned.
      const fallback = list.find((c) => c.other) || list[list.length - 1];
      for (const t of data.transactions) if (t.categoryId === id) t.categoryId = fallback.id;
      save();
      return true;
    },
    usageCount(id) { return data.transactions.filter((t) => t.categoryId === id).length; },

    setBudget(v) { data.settings.budget = Math.max(0, Number(v) || 0); save(); },

    exportJSON() { return JSON.stringify(data, null, 2); },
    importJSON(text) {
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.transactions)) throw new Error('ไฟล์ไม่ถูกต้อง');
      data = normalize(parsed);
      save();
      return data.transactions.length;
    },
    reset() { data = fresh(); save(); },

    loadSample() {
      const now = new Date();
      const rand = (a, b) => Math.round((a + Math.random() * (b - a)) / 5) * 5;
      const notes = { food: ['ข้าวกลางวัน', 'กาแฟ', 'มื้อเย็น', 'ซื้อของสด'], transport: ['BTS', 'เติมน้ำมัน', 'แท็กซี่'], shopping: ['เสื้อผ้า', 'ของใช้ในบ้าน'], fun: ['ดูหนัง', 'Netflix'], health: ['ร้านยา'] };
      for (let back = 5; back >= 0; back--) {
        const y = new Date(now.getFullYear(), now.getMonth() - back, 1);
        const yr = y.getFullYear(), mo = y.getMonth();
        const lastDay = back === 0 ? now.getDate() : U.daysInMonth(yr, mo);
        const d = (day) => U.toISODate(new Date(yr, mo, Math.min(day, lastDay)));
        const push = (type, categoryId, amount, day, note) => data.transactions.push({ id: U.uid(), createdAt: Date.now(), type, categoryId, amount, date: d(day), note: note || '' });
        if (lastDay >= 1) push('income', 'salary', 35000, 1, 'เงินเดือน');
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
      if (!data.settings.budget) data.settings.budget = 25000;
      save();
    },
  };

  root.AIStore = Store;
})(self);
