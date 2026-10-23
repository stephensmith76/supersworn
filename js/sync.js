// Session-code sync over the Firebase Realtime Database REST API.
// No SDK: writes are PUT requests per path, reads are a server-sent event stream.
// Data lives at <dbUrl>/campaigns/<CODE>.
import { store, applyPath } from './store.js';

const enc = s => encodeURIComponent(s);
let es = null;
let code = null;
let status = 'off';
const statusListeners = new Set();

function setStatus(s, detail = '') {
  status = s;
  for (const fn of statusListeners) fn(s, detail);
}

export const sync = {
  get code() { return code; },
  get status() { return status; },
  onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },

  base() {
    const url = (store.prefs.dbUrl || '').trim().replace(/\/+$/, '');
    return url;
  },
  url(path = []) {
    return `${this.base()}/campaigns/${enc(code)}${path.map(p => '/' + enc(p)).join('')}.json`;
  },

  newCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  },

  // Host: upload the current campaign under a fresh code, then listen.
  async host() {
    if (!this.base()) throw new Error('Add your Firebase database URL first.');
    code = this.newCode();
    const res = await fetch(this.url(), { method: 'PUT', body: JSON.stringify(store.state) });
    if (!res.ok) throw new Error('Could not reach the database (' + res.status + ').');
    this.listen();
    return code;
  },

  // Join: download the campaign under a code, then listen.
  async join(c) {
    if (!this.base()) throw new Error('Add your Firebase database URL first.');
    code = c.trim().toUpperCase();
    const res = await fetch(this.url());
    if (!res.ok) throw new Error('Could not reach the database (' + res.status + ').');
    const data = await res.json();
    if (!data || !data.meta) { code = null; throw new Error('No campaign found for that code.'); }
    store.replace(data, { local: false });
    this.listen();
    return code;
  },

  // Reconnect to a code saved from last time (after a reload).
  resume(c) {
    if (!c || !this.base()) return;
    code = c;
    this.listen();
  },

  leave() {
    if (es) es.close();
    es = null; code = null;
    store.remoteWriter = null;
    try { localStorage.removeItem('ss.syncCode'); } catch { /* ignore */ }
    setStatus('off');
  },

  listen() {
    if (es) es.close();
    try { localStorage.setItem('ss.syncCode', code); } catch { /* ignore */ }
    store.remoteWriter = (path, value) => this.write(path, value);
    setStatus('connecting');
    es = new EventSource(this.url());
    const apply = (ev, isPatch) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg) return;
      const path = msg.path.split('/').filter(Boolean);
      if (path.length === 0 && !isPatch) {
        if (msg.data && msg.data.meta) store.replace(msg.data, { local: false });
        setStatus('live');
        return;
      }
      if (isPatch) {
        for (const [k, v] of Object.entries(msg.data || {})) {
          applyPath(store.state, path.concat(k.split('/').filter(Boolean)), v);
        }
        store.replace(store.state, { local: false });
      } else {
        store.set(path, msg.data, { remote: true });
      }
    };
    es.addEventListener('put', e => apply(e, false));
    es.addEventListener('patch', e => apply(e, true));
    es.addEventListener('cancel', () => setStatus('error', 'The database refused access. Check its rules.'));
    es.addEventListener('auth_revoked', () => setStatus('error', 'Access revoked.'));
    es.onerror = () => { if (status !== 'error') setStatus('connecting'); };
    es.onopen = () => setStatus('live');
  },

  async write(path, value) {
    if (!code) return;
    try {
      await fetch(this.url(path), {
        method: value == null ? 'DELETE' : 'PUT',
        body: value == null ? undefined : JSON.stringify(value),
      });
    } catch {
      setStatus('connecting', 'Offline. Changes are saved here and will not reach your partner until you reconnect.');
    }
  },
};
