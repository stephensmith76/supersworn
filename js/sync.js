// Session-code sync over the Firebase Realtime Database REST API.
// No SDK: writes are PUT/DELETE per path, reads are a server-sent event stream.
// Data lives at <dbUrl>/campaigns/<CODE>.
//
// Local changes go into an outbox (saved on this device) and are sent one at a
// time, in order. Until the server confirms a change, incoming events for that
// path are ignored and the outbox is reapplied on top of anything the server
// sends, so slow echoes and reconnects never undo what you just did. If the
// phone is offline the outbox waits and is replayed when the stream reconnects.
import { store } from './store.js';

const enc = s => encodeURIComponent(s);
const keyOf = p => p.join('/');
const LS_CODE = 'ss.syncCode';
const LS_OUTBOX = 'ss.outbox';

let es = null;
let code = null;
let status = 'off';
let detail = '';
let outbox = new Map();     // key -> { path, value }
const echoes = new Map();   // key -> JSON of a value we sent and the server confirmed
let sending = false;
let retryTimer = null;
const statusListeners = new Set();

function setStatus(s, d = '') {
  status = s; detail = d;
  for (const fn of statusListeners) fn(s, d);
}
function saveOutbox() {
  try { localStorage.setItem(LS_OUTBOX, JSON.stringify([...outbox.values()])); } catch { /* ignore */ }
}
function loadOutbox() {
  try {
    const list = JSON.parse(localStorage.getItem(LS_OUTBOX) || '[]');
    outbox = new Map(list.filter(i => Array.isArray(i.path)).map(i => [keyOf(i.path), i]));
  } catch { outbox = new Map(); }
}
const overlay = () => [...outbox.values()];

export const sync = {
  get code() { return code; },
  get status() { return status; },
  get detail() { return detail; },
  get pending() { return outbox.size; },
  onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },

  base() { return (store.prefs.dbUrl || '').trim().replace(/\/+$/, ''); },
  checkBase() {
    const b = this.base();
    if (!b) throw new Error('Add your Firebase database URL first.');
    if (!/^https:\/\/[^/]+$/.test(b) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(b)) {
      throw new Error('The database URL should look like https://your-project-default-rtdb.firebaseio.com');
    }
  },
  url(c, path = []) { return `${this.base()}/campaigns/${enc(c)}${path.map(p => '/' + enc(p)).join('')}.json`; },

  newCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  },

  // Host: upload the current campaign under a fresh code, then listen.
  async host() {
    this.checkBase();
    const c = this.newCode();
    let res;
    try { res = await fetch(this.url(c) + '?print=silent', { method: 'PUT', body: JSON.stringify(store.state) }); }
    catch { throw new Error('Could not reach the database. Check your connection.'); }
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'The database refused access. Check its rules.' : `The database returned an error (${res.status}).`);
    this.start(c, true);
    return c;
  },

  // Join: download the campaign under a code, then listen.
  async join(input) {
    this.checkBase();
    const c = input.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) throw new Error('Codes are six letters and numbers.');
    let res;
    try { res = await fetch(this.url(c)); }
    catch { throw new Error('Could not reach the database. Check your connection.'); }
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'The database refused access. Check its rules.' : `The database returned an error (${res.status}).`);
    const data = await res.json();
    if (!data || !data.meta) throw new Error('No campaign found for that code.');
    outbox = new Map(); saveOutbox();
    store.applyRemote([], data);
    this.start(c, true);
    return c;
  },

  // Reconnect to the code saved from last time (after a reload). Unsent
  // changes from the outbox are kept and replayed.
  resume(c) {
    if (!c) return;
    try { this.checkBase(); } catch { return; }
    loadOutbox();
    this.start(c, false);
  },

  start(c, fresh) {
    code = c;
    if (fresh) { outbox = new Map(); saveOutbox(); }
    try { localStorage.setItem(LS_CODE, c); } catch { /* ignore */ }
    store.remoteWriter = (path, value) => this.write(path, value);
    this.listen();
  },

  leave() {
    if (es) es.close();
    es = null; code = null;
    clearTimeout(retryTimer);
    outbox = new Map(); saveOutbox(); echoes.clear();
    store.remoteWriter = null;
    try { localStorage.removeItem(LS_CODE); } catch { /* ignore */ }
    setStatus('off');
  },

  listen() {
    if (es) es.close();
    setStatus('connecting');
    const myCode = code;
    es = new EventSource(this.url(code));
    const onEvent = (ev, isPatch) => {
      if (code !== myCode) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.path !== 'string') return;
      const path = msg.path.split('/').filter(Boolean);
      if (path.length === 0 && !isPatch) {
        if (!msg.data || !msg.data.meta) {
          setStatus('error', 'That session no longer exists on the database. Stop syncing, then host or join again.');
          return;
        }
        store.applyRemote([], msg.data, overlay());
        setStatus('live');
        this.pump();
        return;
      }
      const entries = isPatch ? Object.entries(msg.data || {}).map(([k, v]) => [path.concat(k.split('/').filter(Boolean)), v]) : [[path, msg.data]];
      for (const [p, v] of entries) {
        const k = keyOf(p);
        if (outbox.has(k)) continue; // our newer value is still on its way
        const json = JSON.stringify(v ?? null);
        if (echoes.get(k) === json) { echoes.delete(k); continue; } // our own write coming back
        store.applyRemote(p, v, overlay());
      }
    };
    es.addEventListener('put', e => onEvent(e, false));
    es.addEventListener('patch', e => onEvent(e, true));
    es.addEventListener('cancel', () => setStatus('error', 'The database refused access. Check its rules.'));
    es.addEventListener('auth_revoked', () => setStatus('error', 'Access revoked.'));
    es.onopen = () => { if (status !== 'error') setStatus('live'); };
    es.onerror = () => {
      if (es && es.readyState === EventSource.CLOSED) {
        setStatus('error', 'Could not connect to the database. Check the URL and its rules, then try again.');
      } else if (status !== 'error') {
        setStatus('connecting', outbox.size ? 'Reconnecting. Your changes are saved here and will be sent when you are back online.' : 'Reconnecting…');
      }
    };
  },

  write(path, value) {
    if (!code) return;
    const k = keyOf(path);
    // A write to a parent replaces anything queued underneath it.
    for (const kk of [...outbox.keys()]) if (kk.startsWith(k + '/')) outbox.delete(kk);
    outbox.delete(k);
    outbox.set(k, { path, value: value ?? null });
    saveOutbox();
    this.pump();
  },

  async pump() {
    if (sending || !code) return;
    sending = true;
    const myCode = code;
    while (outbox.size && code === myCode) {
      const [k, item] = outbox.entries().next().value;
      let res;
      try {
        res = await fetch(this.url(myCode, item.path) + '?print=silent', {
          method: item.value == null ? 'DELETE' : 'PUT',
          body: item.value == null ? undefined : JSON.stringify(item.value),
        });
      } catch {
        setStatus('offline', 'Offline. Your changes are saved here and will be sent when you reconnect.');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => this.pump(), 5000);
        break;
      }
      if (!res.ok && (res.status >= 500 || res.status === 429)) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => this.pump(), 5000);
        break;
      }
      if (outbox.get(k) === item) outbox.delete(k);
      saveOutbox();
      if (res.ok) {
        echoes.set(k, JSON.stringify(item.value ?? null));
        setTimeout(() => { if (echoes.get(k) === JSON.stringify(item.value ?? null)) echoes.delete(k); }, 8000);
        if (status === 'offline' || status === 'connecting') setStatus('live');
      } else {
        setStatus('error', `The database refused a change (${res.status}). Check its rules.`);
      }
    }
    sending = false;
  },
};
