// Minimal fake of the supabase-js surface AITRACK uses. Talks to the Node "server" through window.__sb.
(function () {
  const listeners = [];
  window.__sbEvent = (ev) => {
    for (const l of listeners) {
      if (l.cfg.table !== ev.table) continue;
      if (l.cfg.event !== '*' && l.cfg.event !== ev.eventType) continue;
      if (l.cfg.filter && ev.eventType !== 'DELETE') { const [col, v] = l.cfg.filter.split('=eq.'); if (String(ev.new[col]) !== v) continue; }
      l.cb(ev);
    }
  };
  const net = async (req) => {
    if (!navigator.onLine) return { data: null, error: { message: 'Failed to fetch' } };
    return window.__sb(req);
  };
  window.supabase = { createClient() {
    const authCbs = [];
    const getSess = () => JSON.parse(localStorage.getItem('mock.session') || 'null');
    const setSess = (s, ev) => { if (s) localStorage.setItem('mock.session', JSON.stringify(s)); else localStorage.removeItem('mock.session'); authCbs.forEach((cb) => cb(ev, s)); };
    function builder(table) {
      const q = { table, action: 'select', filters: [], rows: null, single: false };
      const b = {
        select() { return b; }, order() { return b; }, range(a, z) { q.range = [a, z]; return b; },
        eq(c, v) { q.filters.push(['eq', c, v]); return b; }, in(c, v) { q.filters.push(['in', c, v]); return b; },
        maybeSingle() { q.single = true; return b; },
        upsert(rows) { q.action = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; return b; },
        delete() { q.action = 'delete'; return b; },
        then(res, rej) { const s = getSess(); return net({ ...q, uid: s && s.user.id }).then(res, rej); },
      };
      return b;
    }
    return {
      auth: {
        getSession: async () => ({ data: { session: getSess() } }),
        onAuthStateChange(cb) { authCbs.push(cb); setTimeout(() => cb('INITIAL_SESSION', getSess()), 0); return { data: { subscription: { unsubscribe() {} } } }; },
        async signInWithPassword({ email, password }) { const r = await net({ action: 'signin', email, password }); if (r.error) return r; const s = { user: r.data.user }; setSess(s, 'SIGNED_IN'); return { data: s, error: null }; },
        async signUp({ email, password }) { const r = await net({ action: 'signup', email, password }); if (r.error) return r; const s = { user: r.data.user }; setSess(s, 'SIGNED_IN'); return { data: { user: s.user, session: s }, error: null }; },
        async signOut() { setSess(null, 'SIGNED_OUT'); return { error: null }; },
        async resetPasswordForEmail() { return { error: null }; },
        async updateUser() { return { data: {}, error: null }; },
      },
      from: builder,
      channel() { const ch = { on(type, cfg, cb) { listeners.push({ cfg, cb }); return ch; }, subscribe() { return ch; } }; return ch; },
      removeChannel() { listeners.length = 0; },
    };
  } };
})();
