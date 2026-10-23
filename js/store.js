// Campaign state. Collections are maps keyed by id so two players can edit
// different things at once and sync merges cleanly path by path.
const LS_INDEX = 'ss.campaigns';
const LS_ACTIVE = 'ss.active';
const LS_PREFS = 'ss.prefs';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function lsGet(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } }

export function blankCampaign(name = 'New campaign') {
  return {
    meta: { id: uid(), name, created: Date.now(), city: '' },
    shared: { resources: 5 },
    heroes: {}, tracks: {}, clocks: {}, nemeses: {}, journal: {},
  };
}

export function blankHero(name = 'New hero') {
  return {
    id: uid(), created: Date.now(), name, look: '', identity: '',
    stats: { edge: 1, heart: 1, iron: 1, shadow: 1, wits: 1 },
    health: 5, spirit: 5, momentum: 2, heat: 0,
    impacts: {}, legacies: { quests: 0, bonds: 0, heroics: 0 }, xp: { earned: 0, spent: 0 },
    assets: {}, notes: '',
  };
}

const listeners = new Set();
let state = null;
let prefs = lsGet(LS_PREFS, { player: '', dbUrl: '', theme: 'auto' });

export const store = {
  get state() { return state; },
  get prefs() { return prefs; },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  remoteWriter: null, // set by sync: (path, value) => void

  load() {
    const id = lsGet(LS_ACTIVE, null);
    state = id ? lsGet('ss.c.' + id, null) : null;
    if (!state) { state = blankCampaign('Street Level'); this.persist(); }
    normalize(state);
    lsSet(LS_ACTIVE, state.meta.id);
  },
  campaigns() { return lsGet(LS_INDEX, []); },
  switchTo(id) {
    const c = lsGet('ss.c.' + id, null);
    if (!c) return;
    state = c; normalize(state); lsSet(LS_ACTIVE, id); emit('*');
  },
  replace(newState, { local = true } = {}) {
    state = newState; normalize(state);
    if (local) this.persist();
    else lsSet('ss.c.' + state.meta.id, state);
    lsSet(LS_ACTIVE, state.meta.id);
    emit('*');
  },
  newCampaign(name) { this.replace(blankCampaign(name)); },
  deleteCampaign(id) {
    lsSet(LS_INDEX, this.campaigns().filter(c => c.id !== id));
    try { localStorage.removeItem('ss.c.' + id); } catch { /* ignore */ }
  },
  persist() {
    lsSet('ss.c.' + state.meta.id, state);
    const idx = this.campaigns().filter(c => c.id !== state.meta.id);
    idx.unshift({ id: state.meta.id, name: state.meta.name, updated: Date.now() });
    lsSet(LS_INDEX, idx);
  },
  setPref(k, v) { prefs = { ...prefs, [k]: v }; lsSet(LS_PREFS, prefs); emit('prefs'); },

  // Path is an array like ['heroes', id, 'health']. value undefined/null deletes.
  set(path, value, { remote = false } = {}) {
    applyPath(state, path, value);
    this.persist();
    if (!remote && this.remoteWriter) this.remoteWriter(path, value);
    emit(path[0]);
  },
  get(path) { return path.reduce((o, k) => (o == null ? undefined : o[k]), state); },
};

export function applyPath(root, path, value) {
  let o = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (o[path[i]] == null || typeof o[path[i]] !== 'object') o[path[i]] = {};
    o = o[path[i]];
  }
  const last = path[path.length - 1];
  if (value === undefined || value === null) delete o[last];
  else o[last] = value;
}

function normalize(s) {
  const b = blankCampaign();
  for (const k of Object.keys(b)) if (s[k] == null) s[k] = b[k];
  if (s.shared.resources == null) s.shared.resources = 5;
  for (const h of Object.values(s.heroes)) {
    const bh = blankHero();
    for (const k of Object.keys(bh)) if (h[k] == null) h[k] = bh[k];
    for (const k of Object.keys(bh.stats)) if (h.stats[k] == null) h.stats[k] = 0;
    for (const k of Object.keys(bh.legacies)) if (h.legacies[k] == null) h.legacies[k] = 0;
  }
}

function emit(topic) { for (const fn of listeners) fn(topic); }

export const sorted = (map, key = 'created') =>
  Object.values(map || {}).sort((a, b) => (a[key] || 0) - (b[key] || 0));
