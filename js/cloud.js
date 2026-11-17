/*
 * Supabase sync: sign-in, an offline-tolerant write queue, initial pull and realtime updates.
 * When Supabase is not configured (or the user picks "use without signing in") the app runs
 * purely on localStorage exactly as before.
 */
(function (root) {
  'use strict';
  const S = root.AIStore;

  const CONFIG_KEY = 'aitrack.supabase';
  const MODE_KEY = 'aitrack.mode';
  const LAST_USER_KEY = 'aitrack.lastUser';
  const CHUNK = 500;

  let client = null;
  let user = null;
  let channel = null;
  let queue = emptyQueue();
  let flushing = false;
  let flushAgain = false;
  let flushTimer = null;
  let retryTimer = null;
  let status = 'local';
  let lastError = null;
  /** Columns added in later schema versions that this database does not have yet (see supabase/schema.sql). */
  const missingColumns = new Set();
  const statusListeners = new Set();
  const remoteListeners = new Set();
  const authListeners = new Set();

  function emptyQueue() { return { upserts: {}, deletes: {}, settings: 0, wipe: null }; }

  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { return null; }
    return null;
  }

  function readConfig() {
    const fromFile = root.AITRACK_CONFIG || {};
    if (fromFile.supabaseUrl && fromFile.supabaseAnonKey) return { url: fromFile.supabaseUrl.trim(), key: fromFile.supabaseAnonKey.trim(), source: 'file' };
    try {
      const c = JSON.parse(ls(CONFIG_KEY) || 'null');
      if (c && c.url && c.key) return { url: c.url, key: c.key, source: 'browser' };
    } catch (e) { /* ignore */ }
    return null;
  }
  const config = readConfig();

  /* ---------- status ---------- */

  function setStatus(s, err) {
    status = s;
    lastError = err || null;
    statusListeners.forEach((fn) => fn(s));
  }
  function notifyRemote() { remoteListeners.forEach((fn) => fn()); }

  /* ---------- row mapping ---------- */

  function toRow(t) {
    return {
      user_id: user.id, id: t.id, type: t.type, amount: t.amount, category_id: t.categoryId || '',
      date: t.date, time_of_day: t.time || '', note: t.note || '', created_at: new Date(t.createdAt || Date.now()).toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
  function fromRow(r) {
    return {
      id: r.id, type: r.type, amount: Number(r.amount), categoryId: r.category_id, date: r.date,
      // undefined (column missing on the server) keeps the time stored on this device
      time: r.time_of_day === undefined ? undefined : (r.time_of_day || ''),
      note: r.note || '', createdAt: Date.parse(r.created_at) || 0,
    };
  }
  function settingsRow() {
    return { user_id: user.id, categories: S.categories, budget: S.settings.budget || 0, plan: S.settings.plan, updated_at: new Date().toISOString() };
  }

  /**
   * Upsert that still works against a database created before a column was added:
   * PostgREST answers PGRST204 "Could not find the 'x' column", so drop that field and retry.
   */
  async function upsertCompat(table, rows, opts) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const strip = (r) => { const o = { ...r }; missingColumns.forEach((c) => delete o[c]); return o; };
      const res = await client.from(table).upsert(Array.isArray(rows) ? rows.map(strip) : strip(rows), opts);
      const m = res && res.error && /could not find the '([^']+)' column/i.exec(res.error.message || '');
      if (m && !missingColumns.has(m[1])) { missingColumns.add(m[1]); continue; }
      return check(res);
    }
    return null;
  }

  /* ---------- write queue (persisted, coalesced) ---------- */

  const queueKey = () => 'aitrack.queue.' + user.id;
  function persistQueue() { if (user) ls(queueKey(), JSON.stringify(queue)); }
  function loadQueue() {
    try { queue = Object.assign(emptyQueue(), JSON.parse(ls(queueKey()) || 'null') || {}); } catch (e) { queue = emptyQueue(); }
  }
  function pendingCount() {
    return Object.keys(queue.upserts).length + Object.keys(queue.deletes).length + (queue.settings ? 1 : 0) + (queue.wipe ? 1 : 0);
  }

  /** Each entry is a fresh object so a flush only clears entries that did not change while it ran. */
  function enqueue(op) {
    if (op.kind === 'upsert') { delete queue.deletes[op.tx.id]; queue.upserts[op.tx.id] = { tx: JSON.parse(JSON.stringify(op.tx)) }; }
    else if (op.kind === 'delete') { delete queue.upserts[op.id]; queue.deletes[op.id] = {}; }
    else if (op.kind === 'settings') queue.settings++;
    else if (op.kind === 'wipe') queue = { upserts: {}, deletes: {}, settings: queue.settings, wipe: {} };
    persistQueue();
    scheduleFlush();
  }

  function scheduleFlush(delay) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, delay == null ? 250 : delay);
  }

  function check(res) { if (res && res.error) throw res.error; return res; }

  async function flush() {
    if (!client || !user) return false;
    if (flushing) { flushAgain = true; return false; }
    if (!pendingCount()) { if (status !== 'synced') setStatus('synced'); return true; }
    if (navigator.onLine === false) { setStatus('offline'); return false; }
    flushing = true;
    setStatus('syncing');
    try {
      if (queue.wipe) {
        const token = queue.wipe;
        check(await client.from('transactions').delete().eq('user_id', user.id));
        if (queue.wipe === token) queue.wipe = null;
        persistQueue();
      }
      const dels = Object.entries(queue.deletes);
      for (let i = 0; i < dels.length; i += CHUNK) {
        const part = dels.slice(i, i + CHUNK);
        check(await client.from('transactions').delete().eq('user_id', user.id).in('id', part.map(([id]) => id)));
        for (const [id, tok] of part) if (queue.deletes[id] === tok) delete queue.deletes[id];
        persistQueue();
      }
      const ups = Object.entries(queue.upserts);
      for (let i = 0; i < ups.length; i += CHUNK) {
        const part = ups.slice(i, i + CHUNK);
        await upsertCompat('transactions', part.map(([, e]) => toRow(e.tx)), { onConflict: 'user_id,id' });
        for (const [id, e] of part) if (queue.upserts[id] === e) delete queue.upserts[id];
        persistQueue();
      }
      if (queue.settings) {
        const v = queue.settings;
        await upsertCompat('user_settings', settingsRow(), { onConflict: 'user_id' });
        if (queue.settings === v) queue.settings = 0;
        persistQueue();
      }
      clearTimeout(retryTimer);
      setStatus(pendingCount() ? 'syncing' : 'synced');
      return true;
    } catch (err) {
      console.warn('Sync failed', err);
      setStatus(navigator.onLine === false ? 'offline' : 'error', err);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(flush, 15000);
      return false;
    } finally {
      flushing = false;
      if (flushAgain) { flushAgain = false; scheduleFlush(0); }
    }
  }

  /* ---------- pull everything from the server ---------- */

  async function pull() {
    if (!client || !user || navigator.onLine === false) return false;
    try {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const res = check(await client.from('transactions').select('*').eq('user_id', user.id).order('date', { ascending: true }).order('id', { ascending: true }).range(from, from + 999));
        rows.push(...res.data);
        if (res.data.length < 1000) break;
      }
      const st = check(await client.from('user_settings').select('*').eq('user_id', user.id).maybeSingle()).data;
      S.replaceFromRemote(rows.map(fromRow), st && st.categories ? st : null);
      // Re-apply local edits that have not reached the server yet.
      for (const e of Object.values(queue.upserts)) S.applyRemoteUpsert(e.tx);
      for (const id of Object.keys(queue.deletes)) S.applyRemoteDelete(id);
      if (!st) enqueue({ kind: 'settings' }); // first sign-in: store default categories
      if (!pendingCount()) setStatus('synced');
      notifyRemote();
      return true;
    } catch (err) {
      console.warn('Pull failed', err);
      setStatus(navigator.onLine === false ? 'offline' : 'error', err);
      return false;
    }
  }

  /* ---------- realtime ---------- */

  function subscribe() {
    unsubscribe();
    if (!client.channel) return;
    const uid = user.id;
    const onUpsert = (p) => {
      const r = p.new;
      if (!r || r.user_id !== uid || queue.upserts[r.id] || queue.deletes[r.id]) return;
      S.applyRemoteUpsert(fromRow(r));
      notifyRemote();
    };
    channel = client.channel('aitrack-' + uid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions', filter: 'user_id=eq.' + uid }, onUpsert)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transactions', filter: 'user_id=eq.' + uid }, onUpsert)
      // DELETE events cannot be filtered server-side; the old record carries the primary key (user_id, id).
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'transactions' }, (p) => {
        const o = p.old;
        if (!o || o.user_id !== uid || queue.upserts[o.id]) return;
        S.applyRemoteDelete(o.id);
        notifyRemote();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_settings', filter: 'user_id=eq.' + uid }, (p) => {
        if (queue.settings || !p.new || !p.new.categories) return;
        S.applyRemoteSettings(p.new);
        notifyRemote();
      })
      .subscribe();
  }
  function unsubscribe() {
    if (channel && client) { try { client.removeChannel(channel); } catch (e) { /* ignore */ } }
    channel = null;
  }

  /* ---------- user session ---------- */

  async function startUser(u) {
    if (user && user.id === u.id) return;
    user = { id: u.id, email: u.email };
    ls(LAST_USER_KEY, JSON.stringify(user));
    ls(MODE_KEY, null);
    S.useNamespace('aitrack.cloud.' + user.id);
    loadQueue();
    S.sink = enqueue;
    setStatus(pendingCount() ? 'syncing' : 'synced');
    authListeners.forEach((fn) => fn('signed-in'));
    await flush();
    await pull();
    subscribe();
  }

  function stopUser(clearCache) {
    unsubscribe();
    if (user && clearCache) { ls('aitrack.cloud.' + user.id, null); ls(queueKey(), null); ls(LAST_USER_KEY, null); }
    user = null;
    S.sink = null;
    queue = emptyQueue();
    S.useNamespace(null);
    setStatus('local');
    authListeners.forEach((fn) => fn('signed-out'));
  }

  const AUTH_ERRORS = [
    [/invalid login credentials/i, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'],
    [/already registered|already exists/i, 'อีเมลนี้สมัครสมาชิกแล้ว ลองเข้าสู่ระบบแทน'],
    [/email not confirmed/i, 'กรุณายืนยันอีเมลก่อน (ตรวจสอบกล่องจดหมาย)'],
    [/password should be at least|weak password/i, 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'],
    [/rate limit|too many/i, 'ลองบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่'],
    [/invalid.*email|unable to validate email/i, 'รูปแบบอีเมลไม่ถูกต้อง'],
    [/failed to fetch|network/i, 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ต'],
  ];
  function authError(err) {
    const msg = (err && err.message) || String(err);
    const hit = AUTH_ERRORS.find(([re]) => re.test(msg));
    return new Error(hit ? hit[1] : msg);
  }
  const redirectTo = () => location.origin + location.pathname;

  const Cloud = {
    get configured() { return !!config; },
    get configSource() { return config && config.source; },
    get available() { return !!client; },
    get user() { return user; },
    get status() { return status; },
    get lastError() { return lastError; },
    pendingCount,
    /** Names of columns the connected database is missing (run supabase/schema.sql again to add them). */
    get missingColumns() { return [...missingColumns]; },
    get localModeChosen() { return ls(MODE_KEY) === 'local'; },
    /** Show the sign-in screen? */
    get needsLogin() { return !!config && !!client && !user && ls(MODE_KEY) !== 'local'; },

    onStatus(fn) { statusListeners.add(fn); },
    onRemoteChange(fn) { remoteListeners.add(fn); },
    onAuth(fn) { authListeners.add(fn); },

    async init() {
      if (!config) { setStatus('local'); return; }
      if (!root.supabase || !root.supabase.createClient) {
        // Library could not load (offline first visit / blocked CDN): keep working on the cached data.
        let last = null;
        try { last = JSON.parse(ls(LAST_USER_KEY) || 'null'); } catch (e) { /* ignore */ }
        if (last && last.id) {
          user = last;
          S.useNamespace('aitrack.cloud.' + user.id);
          loadQueue();
          S.sink = (op) => { enqueue(op); setStatus('offline'); };
          setStatus('offline');
        }
        return;
      }
      client = root.supabase.createClient(config.url, config.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'aitrack.auth' },
      });
      client.auth.onAuthStateChange((event, session) => {
        // Defer: calling Supabase inside this callback can deadlock the auth lock.
        setTimeout(() => {
          if (event === 'PASSWORD_RECOVERY') authListeners.forEach((fn) => fn('password-recovery'));
          if (session && session.user) startUser(session.user);
          else if (event === 'SIGNED_OUT' && user) stopUser(false);
        }, 0);
      });
      const { data } = await client.auth.getSession();
      if (data && data.session && data.session.user) await startUser(data.session.user).catch((e) => console.warn(e));

      window.addEventListener('online', () => { flush().then(pull); });
      window.addEventListener('offline', () => setStatus('offline'));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && user) flush().then(pull);
      });
    },

    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw authError(error);
      await startUser(data.user);
    },
    /** Returns true when the account still needs email confirmation. */
    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo() } });
      if (error) throw authError(error);
      if (data.session) { await startUser(data.user); return false; }
      return true;
    },
    async resetPassword(email) {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
      if (error) throw authError(error);
    },
    async updatePassword(password) {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw authError(error);
    },
    async signOut() {
      await flush();
      try { await client.auth.signOut(); } catch (e) { /* still sign out locally */ }
      stopUser(true);
    },

    useLocalMode() { ls(MODE_KEY, 'local'); },
    leaveLocalMode() { ls(MODE_KEY, null); },

    syncNow() { return flush().then(pull); },

    saveConfig(url, key) { ls(CONFIG_KEY, JSON.stringify({ url: url.trim(), key: key.trim() })); },
    clearConfig() { ls(CONFIG_KEY, null); },

    /** Local (signed-out) data on this device that has not been moved into this account yet. */
    localDataToMigrate() {
      if (!user || ls('aitrack.migrated.' + user.id)) return null;
      const d = S.readLocalOnly();
      return d.transactions.length ? d : null;
    },
    migrateLocalData() {
      const d = S.readLocalOnly();
      const n = S.merge(d);
      ls('aitrack.migrated.' + user.id, '1');
      S.clearLocalOnly();
      return n;
    },
    skipMigration() { ls('aitrack.migrated.' + user.id, '1'); },
  };

  root.AICloud = Cloud;
})(self);
