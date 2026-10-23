// Campaign state. Collections are maps keyed by id so two players can edit
// different things at once and sync merges cleanly path by path.
//
// Everything that comes from outside this device (sync, imports, old saves)
// goes through sanitize(), which rebuilds the state with known fields and
// coerced types. Views can then trust ids are plain tokens and numbers are numbers.
const LS_INDEX = 'ss.campaigns';
const LS_ACTIVE = 'ss.active';
const LS_PREFS = 'ss.prefs';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let storageOk = true;
function lsGet(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); storageOk = true; } catch { storageOk = false; }
}

// ---------- sanitizing ----------
export const RANKS = ['troublesome', 'dangerous', 'formidable', 'extreme', 'epic'];
const TRACK_TYPES = ['vow', 'case', 'patrol', 'combat', 'connection', 'scene challenge', 'expedition', 'other'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const LABEL_KEY = /^[A-Za-z0-9 _-]{1,40}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const num = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d;
};
const str = (v, max = 4000) => (v == null ? '' : String(v).slice(0, max));
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
// Pictures are small JPEG/PNG data URLs made on the device. Anything else is dropped.
const IMG = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const img = v => (typeof v === 'string' && v.length <= 400000 && IMG.test(v) ? v : '');

function map(m, fn, keyRe = ID) {
  const out = {};
  if (!isObj(m)) return out;
  for (const [k, v] of Object.entries(m)) {
    if (BAD_KEYS.has(k) || !keyRe.test(k)) continue;
    const r = fn(v, k);
    if (r !== undefined) out[k] = r;
  }
  return out;
}
// An entity without a creation time is a fragment (for example a field edit that
// landed after its parent was deleted). Drop it instead of rendering a ghost.
const entity = fn => (v, k) => (isObj(v) && Number(v.created) > 0 ? fn(v, k) : undefined);
const created = v => num(v.created, 1, 1, 1e15);

const cleanAsset = entity((a, k) => ({
  id: k, created: created(a),
  ref: /^[A-Za-z0-9_/-]{1,80}$/.test(a.ref) ? a.ref : '',
  enabled: map(a.enabled, v => !!v, /^a\d$/),
  fields: map(a.fields, v => str(v, 200), LABEL_KEY),
  meters: map(a.meters, v => num(v, 0, 0, 10)),
}));

const cleanHero = entity((h, k) => ({
  id: k, created: created(h),
  name: str(h.name, 80), look: str(h.look, 400), identity: str(h.identity, 200), notes: str(h.notes, 8000), portrait: img(h.portrait),
  stats: Object.fromEntries(['edge', 'heart', 'iron', 'shadow', 'wits'].map(s => [s, num((h.stats || {})[s], 0, -2, 6)])),
  health: num(h.health, 5, 0, 6), spirit: num(h.spirit, 5, 0, 5), momentum: num(h.momentum, 2, -6, 10), heat: num(h.heat, 0, 0, 5),
  impacts: map(h.impacts, v => !!v, LABEL_KEY),
  legacies: Object.fromEntries(['quests', 'bonds', 'heroics'].map(l => [l, num((h.legacies || {})[l], 0, 0, 40)])),
  xp: { earned: num((h.xp || {}).earned, 0, 0, 9999), spent: num((h.xp || {}).spent, 0, 0, 9999) },
  assets: map(h.assets, cleanAsset),
}));

const cleanTrack = entity((t, k) => ({
  id: k, created: created(t), name: str(t.name, 120),
  type: oneOf(t.type, TRACK_TYPES, 'other'), rank: oneOf(t.rank, RANKS, 'dangerous'),
  ticks: num(t.ticks, 0, 0, 40), done: !!t.done, position: oneOf(t.position, ['control', 'bad'], 'control'),
}));

const cleanClock = entity((c, k) => ({
  id: k, created: created(c), name: str(c.name, 120),
  segments: oneOf(Number(c.segments), [4, 6, 8, 10], 6), filled: num(c.filled, 0, 0, 10),
}));

const cleanNemesis = entity((n, k) => ({
  id: k, created: created(n), name: str(n.name, 80), gimmick: str(n.gimmick, 400), scheme: str(n.scheme, 300), sheet: str(n.sheet, 4000), portrait: img(n.portrait),
  rank: oneOf(n.rank, RANKS, 'extreme'), status: oneOf(n.status, ['large', 'locked', 'retired'], 'large'),
  segments: oneOf(Number(n.segments), [4, 6, 8, 10], 8), filled: num(n.filled, 0, 0, 10),
}));

const cleanEntry = entity((e, k) => ({
  id: k, created: created(e), author: str(e.author, 60), kind: oneOf(e.kind, ['note', 'roll', 'oracle', 'session', 'recap'], 'note'), text: str(e.text, 8000),
}));

export function sanitize(s) {
  const src = isObj(s) ? s : {};
  const m = isObj(src.meta) ? src.meta : {};
  return {
    meta: {
      id: ID.test(m.id) ? m.id : uid(), name: str(m.name, 80) || 'Campaign', created: num(m.created, Date.now(), 1, 1e15), city: str(m.city, 80),
      game: /^[a-z0-9-]{1,30}$/.test(m.game) ? m.game : 'supersworn',
    },
    shared: {
      resources: num((src.shared || {}).resources, 5, 0, 5),
      session: num((src.shared || {}).session, 0, 0, 9999),
      sessionStart: num((src.shared || {}).sessionStart, 0, 0, 1e15),
    },
    heroes: map(src.heroes, cleanHero),
    tracks: map(src.tracks, cleanTrack),
    clocks: map(src.clocks, cleanClock),
    nemeses: map(src.nemeses, cleanNemesis),
    journal: map(src.journal, cleanEntry),
  };
}

export const safePath = path => Array.isArray(path) && path.length > 0 && path.every(p => typeof p === 'string' && p && !BAD_KEYS.has(p));

export function blankCampaign(name = 'New campaign', game = 'supersworn') {
  return {
    meta: { id: uid(), name, created: Date.now(), city: '', game },
    shared: { resources: 5, session: 0, sessionStart: 0 },
    heroes: {}, tracks: {}, clocks: {}, nemeses: {}, journal: {},
  };
}

export function blankHero(name = 'New hero') {
  return {
    id: uid(), created: Date.now(), name, look: '', identity: '',
    stats: { edge: 0, heart: 0, iron: 0, shadow: 0, wits: 0 },
    health: 5, spirit: 5, momentum: 2, heat: 0,
    impacts: {}, legacies: { quests: 0, bonds: 0, heroics: 0 }, xp: { earned: 0, spent: 0 },
    assets: {}, notes: '',
  };
}

const listeners = new Set();
let state = null;
let prefs = lsGet(LS_PREFS, { player: '', dbUrl: '' });

export const store = {
  get state() { return state; },
  get prefs() { return prefs; },
  get storageOk() { return storageOk; },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  remoteWriter: null, // set by sync: (path, value) => void

  load() {
    const id = lsGet(LS_ACTIVE, null);
    const saved = id ? lsGet('ss.c.' + id, null) : null;
    state = saved ? sanitize(saved) : blankCampaign('Street Level');
    this.persist();
    lsSet(LS_ACTIVE, state.meta.id);
  },
  campaigns() { return lsGet(LS_INDEX, []).filter(c => c && ID.test(c.id)); },
  switchTo(id) {
    const c = lsGet('ss.c.' + id, null);
    if (!c) return;
    state = sanitize(c); lsSet(LS_ACTIVE, state.meta.id); emit('*');
  },
  replace(newState) {
    state = sanitize(newState);
    this.persist();
    lsSet(LS_ACTIVE, state.meta.id);
    emit('*');
  },
  newCampaign(name, game) { this.replace(blankCampaign(name, game)); },
  deleteCampaign(id) {
    lsSet(LS_INDEX, this.campaigns().filter(c => c.id !== id));
    try { localStorage.removeItem('ss.c.' + id); } catch { /* ignore */ }
  },
  persist() {
    lsSet('ss.c.' + state.meta.id, state);
    const idx = this.campaigns().filter(c => c.id !== state.meta.id);
    idx.unshift({
      id: state.meta.id, name: state.meta.name, city: state.meta.city, game: state.meta.game, updated: Date.now(),
      heroes: Object.values(state.heroes).map(h => h.name).filter(Boolean).slice(0, 4), session: state.shared.session,
    });
    lsSet(LS_INDEX, idx);
  },
  setPref(k, v) { prefs = { ...prefs, [k]: v }; lsSet(LS_PREFS, prefs); emit('prefs'); },

  // Local edit. Path is an array like ['heroes', id, 'health']; null deletes.
  set(path, value) {
    if (!safePath(path)) return;
    applyPath(state, path, value);
    this.persist();
    if (this.remoteWriter) this.remoteWriter(path, value);
    emit(path[0]);
  },
  // Remote change from sync. overlay = local writes not yet confirmed by the
  // server, reapplied on top so a slow echo or a reconnect never undoes them.
  applyRemote(path, value, overlay = []) {
    if (path.length === 0) {
      state = isObj(value) ? value : blankCampaign();
    } else {
      if (!safePath(path)) return;
      applyPath(state, path, value);
    }
    for (const o of overlay) if (safePath(o.path)) applyPath(state, o.path, o.value);
    state = sanitize(state);
    this.persist();
    lsSet(LS_ACTIVE, state.meta.id);
    emit(path[0] || '*');
  },
  get(path) { return path.reduce((o, k) => (o == null ? undefined : o[k]), state); },
};

export function applyPath(root, path, value) {
  if (!safePath(path)) return;
  let o = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isObj(o[path[i]])) o[path[i]] = {};
    o = o[path[i]];
  }
  const last = path[path.length - 1];
  if (value === undefined || value === null) delete o[last];
  else o[last] = value;
}

function emit(topic) { for (const fn of listeners) fn(topic); }

export const sorted = (m, key = 'created') =>
  Object.values(m || {}).sort((a, b) => (a[key] || 0) - (b[key] || 0));
