import { store, uid, blankHero, sorted } from './store.js';
import { sync } from './sync.js';
import {
  rnd, RANKS, TICKS_PER_MARK, MAX_TICKS, boxes, momentumLimits, HEAT_EFFECTS,
  actionRoll, progressRoll, RESULT_LABEL, ODDS, askOracle, rollOracle,
} from './rules.js';
import { AI_PROVIDERS, askRules } from './ai.js';
import { effectsFor } from './effects.js';

export const GAMES = [{ id: 'supersworn', name: 'Supersworn: Street Level' }];
const gameName = id => (GAMES.find(g => g.id === id) || { name: id }).name;

// ---------- data ----------
const D = { moves: [], oracles: [], assets: [], oracleById: {}, assetById: {}, moveById: {}, rules: {}, sources: [] };

async function loadData() {
  const [sf, ss, vil, notes] = await Promise.all([
    fetch('data/starforged.json').then(r => r.json()),
    fetch('data/supersworn.json').then(r => r.json()),
    fetch('data/villains.json').then(r => r.json()),
    fetch('data/rules-notes.md').then(r => r.text()),
  ]);
  D.appGuide = await fetch('data/app-guide.md').then(r => r.text());
  D.guides = (await fetch('data/guides.json').then(r => r.json())).guides;
  D.villain = vil;
  D.notes = notes;
  ss.oracles = ss.oracles.concat(vil.oracles);
  // Rename Supply to Resources in Starforged text so the rules read the same as the hack.
  const resup = t => t.replace(/\bsupply\b/g, 'resources').replace(/\bSupply\b/g, 'Resources');
  D.rules = ss.rules;
  D.sources = ss.sources;
  D.moves = ss.moves.concat(sf.moves.map(m => ({ ...m, text: resup(m.text), stats: m.stats.map(s => (s === 'supply' ? 'resources' : s)) })));
  D.oracles = ss.oracles.concat(sf.oracles);
  const allowed = new Set(ss.sfAllowedAssets);
  D.assets = ss.assets.concat(sf.assets.filter(a => allowed.has(a.id)).map(a => ({ ...a, abilities: a.abilities.map(resup) })));
  for (const o of D.oracles) D.oracleById[o.id] = o;
  for (const a of D.assets) D.assetById[a.id] = a;
  for (const m of D.moves) D.moveById[m.id] = m;
}

// ---------- ui state (per device, not synced) ----------
const ui = {
  tab: 'heroes', heroId: null, modal: null, lastRoll: null, oracleResults: [], moveId: '', rollStat: 'iron',
  rollAdds: 0, rollHero: null, moveQuery: '', oracleQuery: '', assetQuery: '', pendingRender: false, drafts: {},
  manual: {}, d100: '',
};
const physical = () => store.prefs.physical === '1';
function dicePicker(label, key, max) {
  const cur = ui.manual[key];
  let out = `<div class="dicepick"><span class="lbl">${esc(label)}</span><div class="dicerow n${max}">`;
  for (let v = 1; v <= max; v++) out += `<button class="die ${cur === v ? 'on' : ''}" data-act="pickDie" data-k="${key}" data-v="${v}" aria-label="${esc(label)} ${v}">${v}</button>`;
  return out + '</div></div>';
}
function takeD100() {
  const v = parseInt(ui.d100, 10);
  ui.d100 = '';
  for (const el of document.querySelectorAll('[data-d100]')) el.value = '';
  return physical() && v >= 1 && v <= 100 ? v : undefined;
}
const d100Field = () => (physical() ? `<label class="field d100">Your d100 roll (used by the next table or oracle you tap) <input type="number" inputmode="numeric" min="1" max="100" data-d100="1" value="${esc(ui.d100)}" placeholder="1 to 100"></label>` : '');
try { Object.assign(ui, JSON.parse(localStorage.getItem('ss.ui') || '{}'), { modal: null, lastRoll: null, pendingRender: false, drafts: {} }); } catch { /* ignore */ }
function saveUi() {
  try { localStorage.setItem('ss.ui', JSON.stringify({ tab: ui.tab, heroId: ui.heroId, rollStat: ui.rollStat, rollHero: ui.rollHero })); } catch { /* ignore */ }
}

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = () => store.state;
const me = () => store.prefs.player || 'Player';
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function md(text) {
  // Small markdown subset: paragraphs, "  * " bullets, __bold__ and **bold**.
  const inline = t => esc(t).replace(/__(.+?)__/g, '<b>$1</b>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  return String(text || '').split(/\n\n+/).map(block => {
    const lines = block.split('\n');
    if (lines.every(l => /^\s*[*-] /.test(l))) return '<ul>' + lines.map(l => '<li>' + inline(l.replace(/^\s*[*-] /, '')) + '</li>').join('') + '</ul>';
    return '<p>' + lines.map(inline).join('<br>') + '</p>';
  }).join('');
}

function stepper(path, value, { min = 0, max = 5, label = '' } = {}) {
  return `<div class="stepper" data-path="${esc(JSON.stringify(path))}" data-min="${min}" data-max="${max}">
    ${label ? `<span class="lbl">${esc(label)}</span>` : ''}
    <button class="step" data-act="dec" aria-label="Decrease ${esc(label)}">−</button>
    <span class="val">${value > 0 && min < 0 ? '+' : ''}${esc(value)}</span>
    <button class="step" data-act="inc" aria-label="Increase ${esc(label)}">+</button>
  </div>`;
}

function pips(path, value, max, label) {
  let out = `<div class="pips" role="group" aria-label="${esc(label)}">`;
  for (let i = 1; i <= max; i++) {
    out += `<button class="pip ${i <= value ? 'on' : ''}" data-act="pip" data-path="${esc(JSON.stringify(path))}" data-v="${i === value ? i - 1 : i}" aria-label="${esc(label)} ${i}"></button>`;
  }
  return out + '</div>';
}

function trackBoxes(ticks) {
  let out = '<div class="track">';
  for (let b = 0; b < 10; b++) {
    const t = Math.max(0, Math.min(4, ticks - b * 4));
    out += `<span class="box t${t}"></span>`;
  }
  return out + '</div>';
}

function input(path, value, { placeholder = '', cls = '', area = false } = {}) {
  const p = esc(JSON.stringify(path));
  return area
    ? `<textarea class="${cls}" data-bind="${p}" placeholder="${esc(placeholder)}" rows="4">${esc(value)}</textarea>`
    : `<input class="${cls}" data-bind="${p}" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
}

function portrait(path, value, label) {
  const p = esc(JSON.stringify(path));
  return `<div class="portrait">
    ${value ? `<button class="pic" data-act="viewPic" data-path='${p}' aria-label="View ${esc(label)} larger"><img src="${esc(value)}" alt="${esc(label)}"></button>` : `<div class="pic empty" aria-hidden="true">?</div>`}
    <div class="picbtns">
      <label class="btn sm">${value ? 'Change picture' : 'Add picture'}<input type="file" accept="image/*" data-portrait='${p}' hidden></label>
      ${value ? `<button class="btn sm danger" data-act="del" data-path='${p}'>Remove</button>` : ''}
    </div>
  </div>`;
}

// Shrink a photo to at most 360px on its long side as a JPEG, so it stays small enough to save and sync.
function shrinkImage(file, max = 360) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, max / Math.max(im.width, im.height));
      const c = document.createElement('canvas');
      c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a picture the phone can read.')); };
    im.src = url;
  });
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function log(text, kind = 'note') {
  const e = { id: uid(), created: Date.now(), author: me(), kind, text };
  store.set(['journal', e.id], e);
}

function heroes() { return sorted(S().heroes); }
function currentHero() {
  const hs = heroes();
  return S().heroes[ui.heroId] || hs[0] || null;
}

// ---------- views ----------
function viewHeroes() {
  const hs = heroes();
  const h = currentHero();
  let out = `<section class="card shared">
    <div class="row between"><h3>Shared</h3>${stepper(['shared', 'resources'], S().shared.resources, { label: 'Resources' })}</div>
  </section>
  <div class="chips">${hs.map(x => `<button class="chip ${h && x.id === h.id ? 'on' : ''}" data-act="pickHero" data-id="${x.id}">${x.portrait ? `<img class="face" src="${esc(x.portrait)}" alt="">` : ''}${esc(x.name || 'Unnamed')}</button>`).join('')}
    <button class="chip add" data-act="openCreate">+ Hero</button></div>`;
  if (!h) return out + `<section class="card"><p>No heroes yet.</p><button class="btn accent" data-act="openCreate">Create a hero</button>
    <p class="hint">Joining your partner's game instead? Open settings (gear icon).</p></section>`;
  const P = k => ['heroes', h.id, k];
  const lim = momentumLimits(h);
  const xpEarned = Object.values(h.legacies).reduce((a, t) => a + boxes(t) * 2, 0);
  out += `<section class="card">
    ${portrait(P('portrait'), h.portrait, h.name || 'hero')}
    ${input(P('name'), h.name, { placeholder: 'Hero name', cls: 'title-in' })}
    ${input(P('identity'), h.identity, { placeholder: 'Who they are by day' })}
    <h4>Stats <small>array 3, 2, 2, 1, 1</small></h4>
    <div class="grid5">${D.rules.stats.map(s => stepper(['heroes', h.id, 'stats', s], h.stats[s], { label: s, max: 4 })).join('')}</div>
  </section>
  <section class="card">
    <h4>Meters</h4>
    <div class="meter"><span>Health</span>${pips(P('health'), h.health, 5, 'Health')}</div>
    <div class="meter"><span>Spirit</span>${pips(P('spirit'), h.spirit, 5, 'Spirit')}</div>
    <div class="meter"><span>Momentum <small>max ${lim.max}, reset ${lim.reset}</small></span>
      <div class="row">${stepper(P('momentum'), h.momentum, { min: -6, max: lim.max })}<button class="btn sm" data-act="resetMomentum" data-id="${h.id}">Reset</button></div></div>
    <div class="meter heat h${h.heat}"><span>Heat</span>${pips(P('heat'), h.heat, 5, 'Heat')}</div>
    <p class="heat-note">${esc(HEAT_EFFECTS[h.heat] || '')}</p>
    <h4>Impacts</h4>
    <div class="impacts">${D.rules.impacts.map(i => `<label class="check"><input type="checkbox" data-toggle='${esc(JSON.stringify(['heroes', h.id, 'impacts', i]))}' ${h.impacts[i] ? 'checked' : ''}> ${esc(i)}</label>`).join('')}</div>
  </section>
  <section class="card">
    <h4>Legacies <small>XP earned ${xpEarned}</small></h4>
    ${D.rules.legacies.map(l => `<div class="legacy"><div class="row between"><span>${cap(l)}</span>
      <span class="row"><button class="btn sm" data-act="tick" data-path='${esc(JSON.stringify(['heroes', h.id, 'legacies', l]))}' data-n="-1">−</button>
      <button class="btn sm" data-act="tick" data-path='${esc(JSON.stringify(['heroes', h.id, 'legacies', l]))}' data-n="1">+tick</button>
      <button class="btn sm" data-act="tick" data-path='${esc(JSON.stringify(['heroes', h.id, 'legacies', l]))}' data-n="4">+box</button></span></div>
      ${trackBoxes(h.legacies[l])}</div>`).join('')}
    <div class="row between"><span>XP spent</span>${stepper(['heroes', h.id, 'xp', 'spent'], h.xp.spent, { max: 999 })}</div>
  </section>
  <section class="card">
    <div class="row between"><h4>Assets</h4><button class="btn sm" data-act="openAssets">+ Asset</button></div>
    ${sorted(h.assets).map(inst => assetCard(h, inst)).join('') || '<p class="empty">Start with HQ, one Power with a Source, one Path, and one more.</p>'}
  </section>
  <section class="card">
    <h4>Notes</h4>
    ${input(P('notes'), h.notes, { area: true, placeholder: 'Backstory, background vow, equipment, Connections' })}
    <button class="btn danger sm" data-act="delHero" data-id="${h.id}">Delete hero</button>
  </section>`;
  return out;
}

function assetCard(h, inst) {
  const a = D.assetById[inst.ref];
  if (!a) return '';
  const base = ['heroes', h.id, 'assets', inst.id];
  return `<details class="asset" data-key="asset-${esc(inst.id)}">
    <summary><span class="cat">${esc(a.cat)}</span> ${esc(a.name)}${inst.fields && Object.values(inst.fields).find(Boolean) ? ` <small>${esc(Object.values(inst.fields).filter(Boolean).join(', '))}</small>` : ''}</summary>
    ${a.requirement ? `<p class="req">${esc(a.requirement)}</p>` : ''}
    ${a.note ? `<p class="req">${esc(a.note)}</p>` : ''}
    ${a.fields.map(f => `<label class="field">${esc(f)} ${input(base.concat(['fields', f]), (inst.fields || {})[f] || '')}</label>`).join('')}
    ${Object.entries(a.meters || {}).map(([k, m]) => `<div class="meter"><span>${esc(cap(m.label))}</span>${pips(base.concat(['meters', k]), (inst.meters || {})[k] ?? 0, m.max, m.label)}</div>`).join('')}
    <ol class="abilities">${a.abilities.map((t, i) => `<li><label class="check top"><input type="checkbox" data-toggle='${esc(JSON.stringify(base.concat(['enabled', 'a' + i])))}' ${(inst.enabled || {})['a' + i] ? 'checked' : ''}> <span>${md(t)}</span></label></li>`).join('')}</ol>
    <button class="btn danger sm" data-act="delAsset" data-path='${esc(JSON.stringify(base))}'>Remove</button>
  </details>`;
}

function viewAssetPicker() {
  const q = ui.assetQuery.toLowerCase();
  const groups = {};
  for (const a of D.assets) {
    if (q && !(a.name + ' ' + a.abilities.join(' ')).toLowerCase().includes(q)) continue;
    (groups[a.cat] = groups[a.cat] || []).push(a);
  }
  const order = ['Headquarters', 'Power', 'Path', 'Module', 'Companion', 'Deed'];
  return `<div class="modal-head"><h3>Add asset</h3><button class="btn sm" data-act="closeModal">Close</button></div>
    <input class="search" data-ui="assetQuery" value="${esc(ui.assetQuery)}" placeholder="Search assets">
    <p class="hint">Sources: ${D.sources.map(s => `<b>${esc(s.name)}</b>`).join(', ')}. Anything but Training or Technology allows one power, with a cost.</p>
    ${order.filter(c => groups[c]).map(c => `<h4>${c}</h4>${groups[c].map(a => `<details class="asset pick" data-key="pick-${esc(a.id)}"><summary>${esc(a.name)} ${a.id.startsWith('ss/') ? '<span class="tag">Supersworn</span>' : ''}</summary>
      ${a.requirement ? `<p class="req">${esc(a.requirement)}</p>` : ''}<ol class="abilities">${a.abilities.map(t => `<li>${md(t)}</li>`).join('')}</ol>
      <button class="btn" data-act="addAsset" data-ref="${a.id}">Add ${esc(a.name)}</button></details>`).join('')}`).join('')}`;
}

function viewTracks() {
  const tracks = sorted(S().tracks);
  const clocks = sorted(S().clocks);
  const nems = sorted(S().nemeses);
  const locked = nems.filter(n => n.status === 'locked').length;
  return `<section class="card">
    <div class="row between"><h3>Progress tracks</h3><button class="btn sm" data-act="addTrack">+ Track</button></div>
    ${tracks.map(t => {
      const p = ['tracks', t.id];
      return `<div class="ptrack ${t.done ? 'done' : ''}">
        ${input(p.concat('name'), t.name, { placeholder: 'Name this vow, case or patrol', cls: 'name-in' })}
        <div class="row wrap">
          <select data-bind='${esc(JSON.stringify(p.concat('type')))}'>${D.rules.trackTypes.map(x => `<option ${x === t.type ? 'selected' : ''}>${x}</option>`).join('')}</select>
          <select data-bind='${esc(JSON.stringify(p.concat('rank')))}'>${RANKS.map(x => `<option ${x === t.rank ? 'selected' : ''}>${x}</option>`).join('')}</select>
          ${t.type === 'combat' ? `<select class="pos ${t.position === 'bad' ? 'bad' : 'ok'}" data-bind='${esc(JSON.stringify(p.concat('position')))}'><option value="control" ${t.position !== 'bad' ? 'selected' : ''}>In control</option><option value="bad" ${t.position === 'bad' ? 'selected' : ''}>Bad spot</option></select>` : ''}
          <span class="muted">${boxes(t.ticks)}/10</span>
        </div>
        ${trackBoxes(t.ticks)}
        <div class="row wrap">
          <button class="btn" data-act="markProgress" data-id="${t.id}">Mark progress</button>
          <button class="btn sm" data-act="tick" data-path='${esc(JSON.stringify(p.concat('ticks')))}' data-n="-1">−1</button>
          <button class="btn sm" data-act="tick" data-path='${esc(JSON.stringify(p.concat('ticks')))}' data-n="1">+1</button>
          <button class="btn accent" data-act="progressRoll" data-id="${t.id}">Roll progress</button>
          <button class="btn sm" data-act="toggleDone" data-id="${t.id}">${t.done ? 'Reopen' : 'Done'}</button>
          <button class="btn sm danger" data-act="del" data-path='${esc(JSON.stringify(p))}'>Delete</button>
        </div>
        ${ui.lastRoll && ui.lastRoll.trackId === t.id ? rollCard(ui.lastRoll) : ''}
      </div>`;
    }).join('') || '<p class="empty">Vows, cases, patrols and fights all live here.</p>'}
  </section>
  <section class="card">
    <div class="row between"><h3>Clocks</h3><button class="btn sm" data-act="addClock">+ Clock</button></div>
    ${clocks.map(c => clockBlock(['clocks', c.id], c)).join('') || '<p class="empty">Tension clocks for scene challenges and threats.</p>'}
  </section>
  <section class="card">
    <div class="row between"><h3>Nemeses</h3><span class="row"><button class="btn sm accent" data-act="genVillain">Generate villain</button><button class="btn sm" data-act="addNemesis">+ Nemesis</button></span></div>
    ${locked ? `<button class="btn" data-act="escapeCheck">Escape check (${locked} locked up): d10, 1 to 3 escapes</button>` : ''}
    ${nems.map(n => {
      const p = ['nemeses', n.id];
      return `<div class="nemesis ${n.status}">
        ${portrait(p.concat('portrait'), n.portrait, n.name || 'villain')}
        ${input(p.concat('name'), n.name, { placeholder: 'Nemesis name', cls: 'name-in' })}
        ${input(p.concat('gimmick'), n.gimmick, { placeholder: 'Gimmick: what they do and how' })}
        <div class="row wrap">
          <select data-bind='${esc(JSON.stringify(p.concat('rank')))}'>${RANKS.map(x => `<option ${x === n.rank ? 'selected' : ''}>${x}</option>`).join('')}</select>
          <select data-bind='${esc(JSON.stringify(p.concat('status')))}'><option value="large" ${n.status === 'large' ? 'selected' : ''}>At large</option><option value="locked" ${n.status === 'locked' ? 'selected' : ''}>Locked up</option><option value="retired" ${n.status === 'retired' ? 'selected' : ''}>Retired</option></select>
        </div>
        ${clockBlock(p, n, 'Scheme', true)}
        <details class="sheet" data-key="sheet-${esc(n.id)}"><summary>Villain sheet</summary>${input(p.concat('sheet'), n.sheet || '', { area: true, placeholder: 'Motive, edge, method, weakness, lair, muscle, look, calling card' })}</details>
        <div class="row wrap">
          ${n.status === 'large' ? `<button class="btn sm" data-act="lockUp" data-id="${n.id}">Lock up</button>` : ''}
          <button class="btn sm danger" data-act="del" data-path='${esc(JSON.stringify(p))}'>Delete</button>
        </div>
      </div>`;
    }).join('') || '<p class="empty">Bosses and villains who escape become a Nemesis.</p>'}
  </section>`;
}

function clockBlock(p, c, label = '', scheme = false) {
  const seg = c.segments || 6;
  const filled = c.filled || 0;
  const r = 34, cx = 40, cy = 40;
  let paths = '';
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI - Math.PI / 2, a1 = ((i + 1) / seg) * 2 * Math.PI - Math.PI / 2;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    paths += `<path d="M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" class="${i < filled ? 'on' : ''}"/>`;
  }
  const full = filled >= seg;
  return `<div class="clock ${full ? 'full' : ''}">
    <svg viewBox="0 0 80 80" width="72" height="72" aria-label="${filled} of ${seg}">${paths}</svg>
    <div class="clock-side">
      ${scheme ? input(p.concat('scheme'), c.scheme || '', { placeholder: 'Scheme: what they are working toward' }) : input(p.concat('name'), c.name || '', { placeholder: 'Clock name', cls: 'name-in' })}
      <div class="row wrap">
        <button class="btn sm" data-act="tick" data-path='${esc(JSON.stringify(p.concat('filled')))}' data-n="-1" data-max="${seg}">−</button>
        <button class="btn sm accent" data-act="tick" data-path='${esc(JSON.stringify(p.concat('filled')))}' data-n="1" data-max="${seg}">Advance</button>
        <select data-bind='${esc(JSON.stringify(p.concat('segments')))}' data-num="1">${[4, 6, 8, 10].map(x => `<option value="${x}" ${x === seg ? 'selected' : ''}>${x}</option>`).join('')}</select>
        ${!scheme ? `<button class="btn sm danger" data-act="del" data-path='${esc(JSON.stringify(p))}'>Delete</button>` : ''}
      </div>
      ${full ? `<p class="alert">${scheme ? 'The scheme goes off! Roll All Hell Breaks Loose and swear an Extreme vow.' : 'Clock filled.'}</p>` : ''}
    </div>
  </div>`;
}

function rollStatOptions(h) {
  const opts = D.rules.stats.map(s => [s, cap(s), h ? h.stats[s] : 0]);
  if (h) {
    opts.push(['health', 'Health', h.health], ['spirit', 'Spirit', h.spirit]);
    for (const inst of Object.values(h.assets)) {
      const a = D.assetById[inst.ref];
      for (const [k, m] of Object.entries((a && a.meters) || {})) opts.push(['asset:' + inst.id + ':' + k, `${a.name} ${m.label}`, (inst.meters || {})[k] || 0]);
    }
  }
  opts.push(['resources', 'Resources (shared)', S().shared.resources]);
  opts.push(['none', 'No stat', 0]);
  return opts;
}

function rollCard(r) {
  const res = r.burned ? r.burn.result : r.result;
  return `<div class="roll ${res} ${r.match ? 'match' : ''}" role="status">
    <div class="outcome">${RESULT_LABEL[res]}${r.match ? ' <span class="m">match</span>' : ''}</div>
    ${r.kind === 'action'
      ? `<div class="dice"><span class="d6">${r.cancelled ? '<s>' + r.a + '</s>' : r.a}</span> ${r.stat < 0 ? '− ' + (-r.stat) : '+ ' + r.stat} ${r.adds ? (r.adds < 0 ? `− ${-r.adds}` : `+ ${r.adds}`) : ''} = <b>${r.burned ? r.burn.score + ' (momentum)' : r.score}</b>
         <span class="vs">vs</span> <span class="d10">${r.c1}</span><span class="d10">${r.c2}</span></div>`
      : `<div class="dice">Progress <b>${r.score}</b> <span class="vs">vs</span> <span class="d10">${r.c1}</span><span class="d10">${r.c2}</span></div>`}
    ${r.cancelled ? '<p class="small">Negative momentum cancelled the action die.</p>' : ''}
    ${r.label ? `<p class="small">${esc(r.label)}</p>` : ''}
    ${r.burn && !r.burned ? `<button class="btn accent" data-act="burn">Burn momentum: ${RESULT_LABEL[r.burn.result]}</button>` : ''}
    ${fxPanel(r)}
    ${r.match ? `<p class="small">${r.kind === 'action' ? 'A match: check scheme clocks, and Nemesis escapes if you were patrolling.' : 'A match: something unexpected happens, for good or ill.'}</p>` : ''}
  </div>`;
}

function viewRoll() {
  const hs = heroes();
  const h = S().heroes[ui.rollHero] || currentHero();
  const opts = rollStatOptions(h);
  if (!opts.some(o => o[0] === ui.rollStat)) ui.rollStat = (D.moveById[ui.moveId] || {}).stats?.[0] || 'edge';
  const move = D.moveById[ui.moveId];
  const groups = {};
  const q = ui.moveQuery.toLowerCase();
  for (const m of D.moves) {
    if (q && !(m.name + ' ' + m.text).toLowerCase().includes(q)) continue;
    const g = (m.id.startsWith('ss/') ? 'Supersworn: ' : '') + m.cat;
    (groups[g] = groups[g] || []).push(m);
  }
  const progTracks = sorted(S().tracks).filter(t => !t.done);
  const phys = physical();
  const haveAction = ui.manual.a && ui.manual.c1 && ui.manual.c2;
  const haveProg = ui.manual.p1 && ui.manual.p2;
  return `<section class="card">
    <div class="row between"><h3>Action roll</h3>
      <div class="seg" role="group" aria-label="Who rolls the dice">
        <button class="${phys ? '' : 'on'}" data-act="diceMode" data-v="0">App rolls</button><button class="${phys ? 'on' : ''}" data-act="diceMode" data-v="1">My dice</button></div></div>
    <div class="form">
      <label>Hero <select data-ui="rollHero">${hs.map(x => `<option value="${x.id}" ${h && x.id === h.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label>Move <select data-ui="moveId"><option value="">(none)</option>${D.moves.filter(m => m.roll === 'action_roll').map(m => `<option value="${m.id}" ${m.id === ui.moveId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
      <label>Roll + <select data-ui="rollStat">${opts.map(([k, l, v]) => `<option value="${k}" ${k === ui.rollStat ? 'selected' : ''}>${esc(l)} (${v})</option>`).join('')}</select></label>
      <div class="row between"><span>Adds</span>${stepper(['__ui', 'rollAdds'], ui.rollAdds, { min: -3, max: 5 })}</div>
    </div>
    ${phys ? `${dicePicker('Action die (d6)', 'a', 6)}${dicePicker('Challenge die 1 (d10)', 'c1', 10)}${dicePicker('Challenge die 2 (d10)', 'c2', 10)}` : ''}
    <button class="btn big accent" data-act="actionRoll" ${h && (!phys || haveAction) ? '' : 'disabled'}>${phys ? 'Resolve' : 'Roll'}</button>
    ${phys && !haveAction ? '<p class="hint">Roll your dice, then tap what you got.</p>' : ''}
    ${h ? '' : '<p class="empty">Add a hero first.</p>'}
    ${ui.lastRoll && ui.lastRoll.kind === 'action' ? rollCard(ui.lastRoll) : ''}
    ${move ? `<details class="movetext" data-key="cur-move" open><summary>${esc(move.name)}</summary>${md(move.text)}${(move.oracles || []).map(o => `<button class="btn sm" data-act="rollOracle" data-id="${o}">Roll ${esc(D.oracleById[o].name)}</button>`).join(' ')}</details>` : ''}
  </section>
  <section class="card">
    <h3>Progress roll</h3>
    ${phys ? `${dicePicker('Challenge die 1 (d10)', 'p1', 10)}${dicePicker('Challenge die 2 (d10)', 'p2', 10)}<p class="hint">${haveProg ? 'Now tap the track you are rolling for.' : 'Roll two d10, tap what you got, then tap the track.'}</p>` : ''}
    ${progTracks.length ? `<div class="chips">${progTracks.map(t => `<button class="chip ${ui.progPick === t.id ? 'on' : ''}" data-act="progressRoll" data-id="${t.id}" ${phys && !haveProg ? 'disabled' : ''}>${esc(t.name || t.type)} (${boxes(t.ticks)})</button>`).join('')}</div>` : '<p class="empty">No open tracks.</p>'}
    ${ui.lastRoll && ui.lastRoll.kind === 'progress' ? rollCard(ui.lastRoll) : ''}
  </section>
  <section class="card">
    <h3>Ask the Oracle</h3>
    ${d100Field()}
    <div class="chips">${ODDS.map(([l, c]) => `<button class="chip" data-act="yesno" data-c="${c}">${l}</button>`).join('')}</div>
    <div class="chips">${[6, 10, 100].map(n => `<button class="chip" data-act="die" data-n="${n}">d${n}</button>`).join('')}</div>
    ${ui.lastYesNo ? `<p class="yesno ${ui.lastYesNo.yes ? 'yes' : 'no'}">${esc(ui.lastYesNo.text)}</p>` : ''}
  </section>
  <section class="card">
    <h3>Moves</h3>
    <input class="search" data-ui="moveQuery" value="${esc(ui.moveQuery)}" placeholder="Search moves">
    ${Object.entries(groups).map(([g, ms]) => `<h4>${esc(g)}</h4>${ms.map(m => `<details class="movetext" data-key="m-${esc(m.id)}"><summary>${esc(m.name)}</summary>${md(m.text)}
      <div class="row wrap">${m.roll === 'action_roll' ? `<button class="btn sm accent" data-act="useMove" data-id="${m.id}">Roll this</button>` : ''}
      ${(m.oracles || []).map(o => `<button class="btn sm" data-act="rollOracle" data-id="${o}">Roll ${esc(D.oracleById[o].name)}</button>`).join('')}</div></details>`).join('')}`).join('')}
  </section>`;
}

function viewOracles() {
  const q = ui.oracleQuery.toLowerCase();
  const groups = {};
  for (const o of D.oracles) {
    if (q && !(o.name + ' ' + o.group).toLowerCase().includes(q)) continue;
    (groups[o.group] = groups[o.group] || []).push(o);
  }
  return `<section class="card">
    <div class="chips">
      <button class="chip on" data-act="spark" data-a="sf/core/action" data-b="sf/core/theme">Action + Theme</button>
      <button class="chip on" data-act="spark" data-a="sf/core/descriptor" data-b="sf/core/focus">Descriptor + Focus</button>
      <button class="chip on" data-act="spark" data-a="ss/loc/location" data-b="sf/core/descriptor">Place</button>
      <button class="chip on" data-act="spark" data-a="sf/characters/role" data-b="sf/characters/goal">NPC</button>
    </div>
    ${ui.oracleResults.length ? `<ol class="results">${ui.oracleResults.map(r => `<li><b>${esc(r.text)}</b> <small>${esc(r.label)}</small></li>`).join('')}</ol>` : '<p class="empty">Tap a table to roll. Results also go to the journal.</p>'}
  </section>
  ${physical() ? `<section class="card">${d100Field()}</section>` : ''}
  <input class="search" data-ui="oracleQuery" value="${esc(ui.oracleQuery)}" placeholder="Search oracles">
  ${Object.entries(groups).map(([g, os]) => `<section class="card"><h4>${esc(g)}</h4><div class="chips">${os.map(o => `<button class="chip" data-act="rollOracle" data-id="${o.id}">${esc(o.name)}</button>`).join('')}</div></section>`).join('')}`;
}

function viewVillain() {
  const v = ui.villain || {};
  return `<div class="modal-head"><h3>Villain</h3><button class="btn sm" data-act="closeModal">Close</button></div>
  <p class="hint">Name them yourselves. Tap a die to reroll one line.</p>
  <section class="card villain">
    ${D.villain.fields.map(([k, label]) => `<div class="vrow"><span class="vlabel">${esc(label)}</span><span class="vval">${esc(v[k] || '')}</span>
      <button class="btn sm" data-act="rerollField" data-k="${k}" aria-label="Reroll ${esc(label)}">🎲</button></div>`).join('')}
  </section>
  <div class="row wrap"><button class="btn" data-act="genVillain">Reroll all</button><button class="btn accent" data-act="villainToNemesis">Add as Nemesis</button></div>`;
}

function viewAsk() {
  const ai = aiReady();
  const msgs = ui.chat || [];
  const guides = `<section class="card">
    <h3>Guides</h3>
    <p class="hint">Example sequences of moves for common situations. Tap a move to open it on the Roll tab.</p>
    ${D.guides.map(g => `<details class="guide" data-key="g-${esc(g.id)}"><summary>${esc(g.title)}</summary><p class="muted">${esc(g.summary)}</p>
      <ol class="steps">${g.steps.map(s => `<li><b>${esc(s.t)}</b>${md(s.x)}${s.m && D.moveById[s.m] ? `<button class="btn sm" data-act="guideMove" data-id="${s.m}">${esc(D.moveById[s.m].name)}</button>` : ''}</li>`).join('')}</ol>
      ${g.tip ? `<p class="tipline">${esc(g.tip)}</p>` : ''}</details>`).join('')}
  </section>`;
  return guides + `<section class="card">
    <h3>Ask</h3>
    <p class="hint">Ask about the rules or how to use this app. Answers use the Supersworn and Starforged rules, this app's manual, and your current heroes, tracks and Nemeses. ${ai ? `Using ${esc(ai.label)}.` : ''}</p>
    ${ai ? '' : `<p class="alert">Add an API key in settings (gear icon) to turn this on.</p>`}
  </section>
  <div class="chat">${msgs.map((m, i) => `<div class="msg ${m.role}">${m.role === 'user' ? esc(m.show || m.text) : md(m.text)}
    ${m.role === 'assistant' && !m.error ? `<button class="btn sm" data-act="saveAnswer" data-i="${i}" ${m.saved ? 'disabled' : ''}>${m.saved ? 'Saved' : 'Save to journal'}</button>` : ''}</div>`).join('')}
    ${ui.asking ? '<div class="msg assistant thinking">Checking the rules…</div>' : ''}</div>
  <section class="card ask">
    <textarea id="askq" data-draft="1" rows="2" placeholder="How do I start a fight? Or: can I burn momentum on a progress roll?" ${ai ? '' : 'disabled'}>${esc(ui.drafts.askq || '')}</textarea>
    <div class="row wrap"><button class="btn accent" data-act="askSend" ${ai && !ui.asking ? '' : 'disabled'}>Ask</button>
    <button class="btn" data-act="askSend" data-walk="1" ${ai && !ui.asking ? '' : 'disabled'}>Walk me through it</button>
    ${msgs.length ? '<button class="btn sm" data-act="askClear">Clear chat</button>' : ''}</div>
  </section>`;
}

function viewJournal() {
  const entries = sorted(S().journal).reverse();
  const n = S().shared.session;
  return `<section class="card session">
    <div class="row between"><h3>${n ? `Session ${n}` : 'No session yet'}</h3>
    <span class="row"><button class="btn sm accent" data-act="openBegin">Begin session</button><button class="btn sm" data-act="openEnd" ${n ? '' : 'disabled'}>End session</button></span></div>
  </section>
  <section class="card">
    <textarea id="jtext" data-draft="1" rows="3" placeholder="What happens next?">${esc(ui.drafts.jtext || '')}</textarea>
    <button class="btn accent" data-act="addEntry">Add to journal</button>
  </section>
  ${entries.map(e => `<article class="entry k-${e.kind}"><header><b>${esc(e.author)}</b> <time>${new Date(e.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
    <button class="x" data-act="del" data-path='${esc(JSON.stringify(['journal', e.id]))}' aria-label="Delete entry">×</button></header>${md(e.text)}</article>`).join('') || '<p class="empty">Rolls and notes from both players show up here.</p>'}`;
}

function viewSettings() {
  const camps = store.campaigns();
  const st = sync.status;
  return `<div class="modal-head"><h3>Settings</h3><button class="btn sm" data-act="closeModal">Close</button></div>
  <section class="card">
    <label class="field">Your name (shown in the journal) <input data-pref="player" value="${esc(store.prefs.player)}" placeholder="Stephen"></label>
    <label class="field">Campaign name ${input(['meta', 'name'], S().meta.name)}</label>
    <label class="field">City name ${input(['meta', 'city'], S().meta.city || '', { placeholder: 'Name it together in session zero' })}</label>
  </section>
  <section class="card">
    <h4>Play together remotely</h4>
    <p class="hint">One of you hosts and reads the code to the other over Discord or the phone. You need a Firebase database URL first (setup steps are below).</p>
    <label class="field">Firebase database URL <input data-pref="dbUrl" value="${esc(store.prefs.dbUrl)}" placeholder="https://your-project-default-rtdb.firebaseio.com"></label>
    ${sync.code
      ? `<p class="code">Session code <b>${esc(sync.code)}</b> <span class="dot ${esc(st)}"></span> ${esc(st)}</p>
         ${sync.detail ? `<p class="${st === 'error' ? 'err' : 'hint'}">${esc(sync.detail)}</p>` : ''}
         ${sync.pending ? `<p class="hint">${sync.pending} change${sync.pending === 1 ? '' : 's'} waiting to send.</p>` : ''}
         <button class="btn" data-act="leave">Stop syncing</button>`
      : `<div class="row wrap"><button class="btn accent" data-act="host">Host this campaign</button>
         <input id="joincode" placeholder="CODE" maxlength="6" class="codein"><button class="btn" data-act="join">Join</button></div>`}
    <p class="err" id="syncerr"></p>
    <details><summary>Firebase setup (once, about 5 minutes)</summary>
      <ol class="small"><li>Go to console.firebase.google.com and create a project (no analytics needed).</li>
      <li>Build, then Realtime Database, then Create database. Pick a US location and start in test mode.</li>
      <li>In the Rules tab, paste <code>{"rules":{"campaigns":{"$code":{".read":true,".write":true}}}}</code> and publish. Anyone with a code can read that campaign, which is fine for two players.</li>
      <li>Copy the database URL from the top of the Data tab into the box above. Your friend pastes the same URL.</li></ol></details>
  </section>
  <section class="card">
    <h4>Rules chat</h4>
    <p class="hint">Pick a provider and paste your own API key. The key stays on this device and is never synced.</p>
    <label class="field">Provider <select data-pref="aiProvider">${Object.entries(AI_PROVIDERS).map(([k, p]) => `<option value="${k}" ${store.prefs.aiProvider === k ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
    <label class="field">API key <input type="password" data-pref="aiKey" value="${esc(store.prefs.aiKey || '')}" placeholder="Paste key" autocomplete="off"></label>
    <label class="field">Model <input data-pref="aiModel" value="${esc(store.prefs.aiModel || '')}" placeholder="${esc((AI_PROVIDERS[store.prefs.aiProvider || 'gemini'] || AI_PROVIDERS.gemini).model)}"></label>
    <details><summary>Getting a key</summary><ul class="small">
      <li><b>Gemini (free):</b> sign in at aistudio.google.com with a personal Google account and choose Get API key. The free tier is plenty for rules questions. Google may use free-tier chats to improve its products.</li>
      <li><b>Claude:</b> make an account at console.anthropic.com, add a few dollars of credit, and create a key. This is separate from a Claude.ai subscription. A rules question costs about a cent.</li></ul></details>
  </section>
  <section class="card">
    <h4>Campaigns</h4>
    <p class="hint">${camps.length} on this device. You can also tap the campaign name at the top.</p>
    <div class="row wrap"><button class="btn" data-act="openCampaigns">Choose campaign</button>
      <button class="btn" data-act="export">Export backup</button>
      <label class="btn">Import backup<input type="file" id="importfile" accept="application/json" hidden></label></div>
  </section>
  <section class="card small">
    <h4>Truths</h4><ul>${D.rules.truths.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    <p class="muted">Rules text from Ironsworn: Starforged by Shawn Tomkin, CC BY 4.0, via Datasworn. Supersworn hack by its original author, with street-level revisions.</p>
  </section>`;
}

// ---------- render ----------
const VIEWS = { heroes: viewHeroes, tracks: viewTracks, roll: viewRoll, oracles: viewOracles, journal: viewJournal, ask: viewAsk };
const viewPic = () => `<div class="modal-head"><h3>Picture</h3><button class="btn sm" data-act="closePic">Close</button></div>
  ${ui.pic ? `<img class="bigpic" src="${esc(ui.pic)}" alt="">` : ''}`;
const MODALS = { pic: viewPic, assets: viewAssetPicker, settings: viewSettings, villain: viewVillain, create: viewCreate, campaigns: viewCampaigns, begin: viewBegin, end: viewEnd };
const $view = () => document.getElementById('view');

function render() {
  const v = $view();
  if (!v) return;
  const scroll = v.scrollTop;
  const dkey = d => d.dataset.key || (d.querySelector('summary') || {}).textContent;
  const open = new Set([...v.querySelectorAll('details[open]')].map(dkey));
  try {
    v.innerHTML = MODALS[ui.modal] ? MODALS[ui.modal]() : (VIEWS[ui.tab] || viewHeroes)();
  } catch (err) {
    console.error(err);
    v.innerHTML = `<section class="card"><p class="alert">Something went wrong drawing this screen.</p><p class="small">${esc(err.message)}</p><button class="btn" data-act="closeModal">Try again</button></section>`;
  }
  for (const d of v.querySelectorAll('details')) if (open.has(dkey(d)) && d.dataset.key !== 'cur-move') d.open = true;
  for (const [id, val] of Object.entries(ui.drafts)) { const el = document.getElementById(id); if (el && !el.value) el.value = val; }
  v.scrollTop = scroll;
  document.getElementById('campname').textContent = S().meta.name;
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('on', b.dataset.tab === ui.tab && !ui.modal);
  const dot = document.getElementById('syncdot');
  dot.className = 'dot ' + (sync.code ? sync.status : 'off');
  dot.title = sync.code ? `Synced: ${sync.code} (${sync.status})${sync.detail ? '. ' + sync.detail : ''}` : 'Not syncing';
  ui.pendingRender = false;
}

let pointerDown = false;
function requestRender() {
  if (pointerDown) { ui.pendingRender = true; return; } // a tap is in progress: let its click land first
  const a = document.activeElement;
  if (a && $view().contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.type !== 'checkbox') {
    ui.pendingRender = true; // don't yank the field out from under someone typing
    return;
  }
  render();
}

// ---------- actions ----------
function clampSet(path, value, min, max) {
  const v = Math.max(min, Math.min(max, value));
  if (path[0] === '__ui') { ui[path[1]] = v; render(); return; }
  store.set(path, v);
}

function doActionRoll() {
  const h = S().heroes[ui.rollHero] || currentHero();
  if (!h) return;
  const opts = rollStatOptions(h);
  const opt = opts.find(o => o[0] === ui.rollStat) || opts[0];
  const m = ui.manual;
  const dice = physical() ? (m.a && m.c1 && m.c2 ? { a: m.a, c1: m.c1, c2: m.c2 } : null) : undefined;
  if (dice === null) return;
  const r = actionRoll({ stat: opt[2], adds: ui.rollAdds, momentum: h.momentum, dice });
  r.physical = !!dice;
  ui.manual = { ...ui.manual, a: null, c1: null, c2: null };
  const move = D.moveById[ui.moveId];
  r.heroId = h.id;
  r.moveId = ui.moveId;
  r.applied = {};
  r.label = `${h.name}: ${move ? move.name + ', ' : ''}+${opt[1]}`;
  ui.lastRoll = r;
  log(`**${RESULT_LABEL[r.result]}${r.match ? ' (match)' : ''}** ${r.label}${r.physical ? ' (own dice)' : ''}\nAction ${r.cancelled ? '0 (cancelled)' : r.a} + ${r.stat}${r.adds ? ' + ' + r.adds : ''} = ${r.score} vs ${r.c1}, ${r.c2}`, 'roll');
}

function doProgressRoll(id) {
  const t = S().tracks[id];
  if (!t) return;
  const m = ui.manual;
  const dice = physical() ? (m.p1 && m.p2 ? { c1: m.p1, c2: m.p2 } : null) : undefined;
  if (dice === null) { ui.tab = 'roll'; ui.progPick = id; saveUi(); return; }
  const r = progressRoll({ ticks: t.ticks, dice });
  ui.manual = { ...ui.manual, p1: null, p2: null };
  ui.progPick = null;
  r.trackId = id;
  r.applied = {};
  const hh = S().heroes[ui.rollHero] || currentHero();
  r.heroId = hh ? hh.id : null;
  r.label = `${t.name || t.type} (${t.rank} ${t.type})`;
  // Take Decisive Action from a bad spot: strong hit without a match counts as weak, weak as miss.
  if (t.type === 'combat' && t.position === 'bad' && r.result !== 'miss') {
    const was = r.result;
    r.result = r.result === 'strong' && !r.match ? 'weak' : r.result === 'weak' ? 'miss' : r.result;
    if (r.result !== was) r.label += `. In a bad spot: ${RESULT_LABEL[was].toLowerCase()} counts as ${RESULT_LABEL[r.result].toLowerCase()}`;
  }
  ui.lastRoll = r;
  log(`**${RESULT_LABEL[r.result]}${r.match ? ' (match)' : ''}** Progress roll: ${r.label}\nProgress ${r.score} vs ${r.c1}, ${r.c2}`, 'roll');
}

function doOracle(id, quiet = false) {
  const o = D.oracleById[id];
  if (!o) return null;
  const r = rollOracle(o, D.oracleById, 0, takeD100());
  const label = r.chain.map(c => `${c.table} ${c.roll}`).join(' → ');
  if (!quiet) {
    ui.oracleResults.unshift({ text: r.text, label });
    ui.oracleResults = ui.oracleResults.slice(0, 8);
    log(`**${r.text}** (${label})`, 'oracle');
  }
  return { text: r.text, label };
}

function rollVillainField(k) {
  const o = D.villain.oracles.find(x => x.field === k);
  return rollOracle(o, D.oracleById).text;
}

const actions = {
  genVillain() {
    ui.villain = {};
    for (const [k] of D.villain.fields) ui.villain[k] = rollVillainField(k);
    ui.modal = 'villain'; render(); $view().scrollTop = 0;
  },
  rerollField(el) { ui.villain[el.dataset.k] = rollVillainField(el.dataset.k); render(); },
  villainToNemesis() {
    const v = ui.villain;
    const rank = v.rank.toLowerCase();
    const n = {
      id: uid(), created: Date.now(), name: '', status: 'large', rank, segments: rank === 'formidable' ? 6 : 8, filled: 2,
      gimmick: `${v.theme}. ${v.edge} (${v.source}).`, scheme: v.scheme,
      sheet: D.villain.fields.filter(([k]) => !['rank', 'theme', 'scheme'].includes(k)).map(([k, l]) => `${l}: ${v[k]}`).join('\n'),
    };
    store.set(['nemeses', n.id], n);
    log(`**A new villain emerges.** ${n.gimmick} Scheme: ${n.scheme}.`, 'oracle');
    ui.modal = null; ui.tab = 'tracks'; saveUi(); render();
  },
  guideMove(el) {
    const m = D.moveById[el.dataset.id];
    ui.moveId = m.id;
    if (m.stats.length) ui.rollStat = m.stats[0];
    ui.lastRoll = null; ui.tab = 'roll'; saveUi(); render();
    const mt = $view().querySelector('.movetext[open]');
    $view().scrollTop = 0;
    if (m.roll !== 'action_roll') {
      // Not rollable from the action roller: open it in the moves list instead.
      ui.moveId = ''; ui.moveQuery = m.name; render();
      const d = $view().querySelector(`details[data-key="m-${CSS.escape(m.id)}"]`);
      if (d) { d.open = true; d.scrollIntoView(); }
    } else if (mt) mt.scrollIntoView({ block: 'nearest' });
  },
  async askSend(el) {
    const q = document.getElementById('askq');
    let text = q.value.trim();
    const show = (el && el.dataset.walk ? 'Walk me through it: ' : '') + text;
    if (!text || ui.asking) return;
    delete ui.drafts.askq;
    if (el && el.dataset.walk) text = `Walk us through this situation step by step as a sequence of moves, using our current heroes and their assets. For each step give the move, the stat to roll, and what each result would mean. Situation: ${text}`;
    ui.chat = (ui.chat || []).concat({ role: 'user', text, show });
    ui.asking = true; render();
    try {
      const answer = await askRules(ui.chat.filter(m => !m.error), buildContext());
      ui.chat.push({ role: 'assistant', text: answer });
    } catch (e) {
      ui.chat.push({ role: 'assistant', text: e.message, error: true });
    }
    ui.asking = false; saveChat(); render();
    $view().scrollTop = $view().scrollHeight;
  },
  askClear() { ui.chat = []; saveChat(); render(); },
  saveAnswer(el) {
    const a = ui.chat[+el.dataset.i], qn = ui.chat[+el.dataset.i - 1];
    if (a.saved) return;
    a.saved = true; saveChat();
    log(`**Rules: ${qn ? (qn.show || qn.text) : ''}**\n\n${a.text}`, 'oracle');
  },
  inc(el) { const s = el.closest('.stepper'); const p = JSON.parse(s.dataset.path); const cur = p[0] === '__ui' ? ui[p[1]] : store.get(p) || 0; clampSet(p, cur + 1, +s.dataset.min, +s.dataset.max); },
  dec(el) { const s = el.closest('.stepper'); const p = JSON.parse(s.dataset.path); const cur = p[0] === '__ui' ? ui[p[1]] : store.get(p) || 0; clampSet(p, cur - 1, +s.dataset.min, +s.dataset.max); },
  pip(el) { store.set(JSON.parse(el.dataset.path), +el.dataset.v); },
  tick(el) {
    const p = JSON.parse(el.dataset.path);
    const max = el.dataset.max ? +el.dataset.max : MAX_TICKS;
    store.set(p, Math.max(0, Math.min(max, (store.get(p) || 0) + +el.dataset.n)));
  },
  pickHero(el) { ui.heroId = el.dataset.id; ui.rollHero = el.dataset.id; saveUi(); render(); },
  addHero() { const h = blankHero(); h.stats = { edge: 0, heart: 0, iron: 0, shadow: 0, wits: 0 }; store.set(['heroes', h.id], h); ui.heroId = h.id; ui.rollHero = h.id; saveUi(); render(); },
  delHero(el) { if (confirmTwice(el)) { store.set(['heroes', el.dataset.id], null); ui.heroId = null; render(); } },
  resetMomentum(el) { const h = S().heroes[el.dataset.id]; store.set(['heroes', h.id, 'momentum'], momentumLimits(h).reset); },
  openAssets() { ui.modal = 'assets'; ui.assetQuery = ''; render(); $view().scrollTop = 0; },
  closeModal() { ui.modal = null; render(); },
  addAsset(el) {
    const h = currentHero();
    const a = D.assetById[el.dataset.ref];
    const inst = { id: uid(), created: Date.now(), ref: a.id, enabled: { a0: true }, fields: {}, meters: {} };
    for (const [k, m] of Object.entries(a.meters || {})) inst.meters[k] = k === 'health' || k === 'integrity' ? m.max : 0;
    store.set(['heroes', h.id, 'assets', inst.id], inst);
    ui.modal = null; render();
  },
  delAsset(el) { if (confirmTwice(el)) store.set(JSON.parse(el.dataset.path), null); },
  del(el) { if (confirmTwice(el)) store.set(JSON.parse(el.dataset.path), null); },
  addTrack() { const t = { id: uid(), created: Date.now(), name: '', type: 'vow', rank: 'dangerous', ticks: 0, done: false }; store.set(['tracks', t.id], t); },
  markProgress(el) { const t = S().tracks[el.dataset.id]; store.set(['tracks', t.id, 'ticks'], Math.min(MAX_TICKS, t.ticks + TICKS_PER_MARK[t.rank])); },
  toggleDone(el) { const t = S().tracks[el.dataset.id]; store.set(['tracks', t.id, 'done'], !t.done); },
  progressRoll(el) { doProgressRoll(el.dataset.id); render(); },
  addClock() { const c = { id: uid(), created: Date.now(), name: '', segments: 6, filled: 0 }; store.set(['clocks', c.id], c); },
  addNemesis() { const n = { id: uid(), created: Date.now(), name: '', gimmick: '', rank: 'extreme', scheme: '', segments: 8, filled: 2, status: 'large' }; store.set(['nemeses', n.id], n); },
  lockUp(el) {
    const n = S().nemeses[el.dataset.id];
    for (const [k, v] of [['status', 'locked'], ['filled', 0], ['scheme', '']]) store.set(['nemeses', n.id, k], v);
    log(`**${n.name || 'A Nemesis'} is locked up.** Scheme cleared.`, 'roll');
  },
  escapeCheck() {
    const locked = sorted(S().nemeses).filter(n => n.status === 'locked');
    if (!locked.length) return;
    const d = rnd(10);
    if (d <= D.rules.nemesisEscape.max) {
      const n = locked[rnd(locked.length) - 1];
      const nextRank = RANKS[Math.min(RANKS.length - 1, Math.max(0, RANKS.indexOf(n.rank)) + 1)];
      for (const [k, v] of [['status', 'large'], ['rank', nextRank], ['filled', 0], ['scheme', '']]) store.set(['nemeses', n.id, k], v);
      log(`**Escape! ${n.name || 'A Nemesis'} is out** (d10: ${d}). Rank is now ${nextRank}. Give them a new scheme.`, 'roll');
    } else {
      log(`Escape check: d10 ${d}. Everyone stays locked up.`, 'roll');
    }
    ui.tab = 'journal'; saveUi(); render();
  },
  actionRoll() { doActionRoll(); render(); },
  burn() {
    const r = ui.lastRoll;
    if (!r || !r.burn) return;
    const h = S().heroes[r.heroId];
    if (!h) { ui.lastRoll = null; render(); return; }
    const now = actionRoll({ stat: r.stat, adds: r.adds, momentum: h.momentum, dice: { a: r.a, c1: r.c1, c2: r.c2 } });
    if (!now.burn) { r.burn = null; render(); return; } // momentum changed since the roll
    r.burn = now.burn;
    r.burned = true;
    store.set(['heroes', h.id, 'momentum'], momentumLimits(h).reset);
    log(`**Burned momentum** (${r.burn.score}): now a ${RESULT_LABEL[r.burn.result].toLowerCase()}. Momentum reset.`, 'roll');
    render();
  },
  useMove(el) {
    const m = D.moveById[el.dataset.id];
    ui.moveId = m.id;
    if (m.stats.length) ui.rollStat = m.stats[0];
    ui.lastRoll = null;
    render(); $view().scrollTop = 0;
  },
  yesno(el) {
    const r = askOracle(+el.dataset.c, takeD100());
    const label = ODDS.find(o => o[1] === r.chance)[0];
    ui.lastYesNo = { yes: r.yes, text: `${label}: ${r.yes ? 'Yes' : 'No'} (${r.roll})${r.match ? ', with a twist!' : ''}` };
    log(`**Ask the Oracle** (${label}): ${r.yes ? 'Yes' : 'No'}, rolled ${r.roll}${r.match ? '. Match: extreme result or twist.' : ''}`, 'oracle');
    render();
  },
  die(el) { const n = +el.dataset.n; const v = rnd(n); ui.lastYesNo = { yes: true, text: `d${n}: ${v}` }; log(`d${n}: **${v}**`, 'roll'); render(); },
  rollOracle(el) { doOracle(el.dataset.id); render(); },
  spark(el) {
    const a = doOracle(el.dataset.a, true), b = doOracle(el.dataset.b, true);
    if (!a || !b) return;
    const text = `${a.text} / ${b.text}`;
    ui.oracleResults.unshift({ text, label: `${a.label}; ${b.label}` });
    ui.oracleResults = ui.oracleResults.slice(0, 8);
    log(`**${text}** (${el.textContent.trim()})`, 'oracle');
    render();
  },
  addEntry() {
    const t = document.getElementById('jtext');
    if (!t.value.trim()) return;
    delete ui.drafts.jtext;
    log(t.value.trim(), 'note'); t.value = '';
  },
  async host() {
    try { const c = await sync.host(); log(`${me()} started hosting. Session code **${c}**.`); render(); } catch (e) { showErr(e.message); }
  },
  async join() {
    const c = document.getElementById('joincode').value;
    if (!c.trim()) return showErr('Enter the code your partner gave you.');
    try { await sync.join(c); ui.modal = null; log(`${me()} joined.`); render(); } catch (e) { showErr(e.message); }
  },
  leave() { sync.leave(); render(); },
  switchCamp(el) { sync.leave(); store.switchTo(el.dataset.id); ui.heroId = null; ui.rollHero = null; ui.lastRoll = null; ui.modal = null; ui.tab = 'heroes'; saveUi(); render(); },
  delCamp(el) { if (confirmTwice(el)) { store.deleteCampaign(el.dataset.id); render(); } },
  newCamp() {
    const name = (document.getElementById('newcampname') || {}).value || 'New campaign';
    const game = (document.getElementById('newcampgame') || {}).value || 'supersworn';
    sync.leave(); store.newCampaign(name.trim() || 'New campaign', game); ui.heroId = null; ui.modal = null; ui.tab = 'heroes'; saveUi(); render();
  },
  openCampaigns() { ui.modal = 'campaigns'; render(); $view().scrollTop = 0; },
  openCreate() { ui.cw = newWizard(); ui.modal = 'create'; render(); $view().scrollTop = 0; },
  cwArchetype(el) { applyArchetype(el.dataset.id); render(); },
  cwBlank() { actions.addHero(); ui.modal = null; render(); },
  cwCreate() { createFromWizard(); },
  openBegin() { ui.modal = 'begin'; ui.beginDone = {}; render(); $view().scrollTop = 0; },
  openEnd() { ui.modal = 'end'; ui.endDone = {}; ui.recapDraft = ui.recapDraft || ''; render(); $view().scrollTop = 0; },
  beginSession() {
    const n = S().shared.session + 1;
    store.set(['shared', 'session'], n);
    store.set(['shared', 'sessionStart'], Date.now());
    log(`**Session ${n} begins.**`, 'session');
    ui.beginDone.started = true; render();
  },
  beginSpotlight() { doOracle('sf/moves/begin_a_session'); ui.beginDone.spot = true; render(); },
  allMomentum(el) {
    for (const h of heroes()) store.set(['heroes', h.id, 'momentum'], Math.min(momentumLimits(h).max, h.momentum + 1));
    log('Everyone takes +1 momentum.', 'roll');
    (el.dataset.which === 'end' ? ui.endDone : ui.beginDone).mom = true; render();
  },
  endAdvance(el) {
    const n = S().nemeses[el.dataset.id];
    if (!n) return;
    store.set(['nemeses', n.id, 'filled'], Math.min(n.segments, n.filled + 1));
    log(`${n.name || 'A Nemesis'} went unopposed. Scheme ${Math.min(n.segments, n.filled + 1)}/${n.segments}.`, 'roll');
    ui.endDone['n' + n.id] = true; render();
  },
  async genRecap(el) {
    if (!aiReady()) return;
    const since = S().shared.sessionStart || 0;
    const lines = sorted(S().journal).filter(e => e.created >= since && e.kind !== 'recap').map(e => `- ${e.author}: ${e.text.replace(/\n/g, ' ')}`).join('\n');
    if (!lines) { ui.recapDraft = 'Nothing in the journal this session yet.'; render(); return; }
    el.disabled = true; el.textContent = 'Writing…';
    try {
      ui.recapDraft = await askRules([{ role: 'user', text: `Write a short "previously on" recap of this session for the two players, in 4 to 6 sentences of plain past-tense story (no rules talk, no dice numbers, no bullet points, no em dashes). Then one line starting "Loose ends:" listing open threads. Journal:\n${lines}` }], buildContext());
    } catch (e) { ui.recapDraft = 'Could not write a recap: ' + e.message; }
    render();
  },
  saveRecap() {
    const t = document.getElementById('recaptext');
    const text = (t ? t.value : ui.recapDraft || '').trim();
    if (!text) return;
    log(`**Recap of session ${S().shared.session}.**\n\n${text}`, 'recap');
    ui.recapDraft = ''; ui.endDone.recap = true; render();
  },
  fx(el) { applyFx(el); },
  viewPic(el) { ui.pic = store.get(JSON.parse(el.dataset.path)); ui.modalBefore = ui.modal; ui.modal = 'pic'; render(); },
  closePic() { ui.modal = ui.modalBefore || null; ui.pic = null; render(); },
  diceMode(el) { store.setPref('physical', el.dataset.v); ui.manual = {}; render(); },
  pickDie(el) { const k = el.dataset.k, v = +el.dataset.v; ui.manual[k] = ui.manual[k] === v ? null : v; render(); },
  export() {
    const blob = new Blob([JSON.stringify(S(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (S().meta.name || 'campaign').replace(/\W+/g, '-') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
};

function saveChat() { try { localStorage.setItem('ss.chat', JSON.stringify((ui.chat || []).slice(-30))); } catch { /* ignore */ } }
try { ui.chat = JSON.parse(localStorage.getItem('ss.chat') || '[]'); } catch { ui.chat = []; }

function aiReady() {
  const p = AI_PROVIDERS[store.prefs.aiProvider || 'gemini'];
  return store.prefs.aiKey && p ? p : null;
}

// Static rules go first (cacheable); the live game state goes second.
let rulesText = null;
function buildContext() {
  if (!rulesText) {
    const ss = D.moves.filter(m => m.id.startsWith('ss/')).map(m => `### ${m.name} (Supersworn)\n${m.text}`).join('\n\n');
    const sf = D.moves.filter(m => m.id.startsWith('sf/')).map(m => `### ${m.name} (Starforged, ${m.cat})\n${m.text}`).join('\n\n');
    const assets = D.assets.filter(a => a.id.startsWith('ss/')).map(a => `### ${a.name} (${a.cat})\n${a.requirement ? a.requirement + '\n' : ''}${a.note ? a.note + '\n' : ''}${a.abilities.map((t, i) => `${i + 1}. ${t}`).join('\n')}`).join('\n\n');
    rulesText = `${D.appGuide}\n\n${D.notes}\n\n## Moves\n\n${ss}\n\n${sf}\n\n## Supersworn assets\n\n${assets}`;
  }
  const s = S();
  const heroLines = sorted(s.heroes).map(h => {
    const lim = momentumLimits(h);
    const as = sorted(h.assets).map(inst => {
      const a = D.assetById[inst.ref];
      if (!a) return '';
      const on = a.abilities.map((t, i) => ((inst.enabled || {})['a' + i] ? `   - [x] ${t}` : null)).filter(Boolean).join('\n');
      return `  - ${a.name} (${a.cat})${Object.keys(inst.meters || {}).length ? ' ' + JSON.stringify(inst.meters) : ''}\n${on}`;
    }).join('\n');
    return `- ${h.name}: edge ${h.stats.edge}, heart ${h.stats.heart}, iron ${h.stats.iron}, shadow ${h.stats.shadow}, wits ${h.stats.wits}; health ${h.health}, spirit ${h.spirit}, momentum ${h.momentum} (max ${lim.max}, reset ${lim.reset}), heat ${h.heat}; impacts: ${Object.keys(h.impacts).filter(k => h.impacts[k]).join(', ') || 'none'}\n  Assets (enabled abilities marked):\n${as}`;
  }).join('\n');
  const tracks = sorted(s.tracks).filter(t => !t.done).map(t => `- ${t.name || '(unnamed)'}: ${t.rank} ${t.type}, ${boxes(t.ticks)} boxes (${t.ticks} ticks)`).join('\n');
  const nems = sorted(s.nemeses).map(n => `- ${n.name || '(unnamed)'}: ${n.rank}, ${n.status}, scheme "${n.scheme}" ${n.filled}/${n.segments}. ${n.gimmick}`).join('\n');
  const recent = sorted(s.journal).slice(-6).map(e => `- ${e.text.replace(/\n/g, ' ')}`).join('\n');
  const state = `## Current game\nShared Resources: ${s.shared.resources}\n\nHeroes:\n${heroLines || 'none'}\n\nOpen tracks:\n${tracks || 'none'}\n\nNemeses:\n${nems || 'none'}\n\nRecent journal:\n${recent || 'none'}`;
  return { rules: rulesText, state };
}

// ---------- one-tap results ----------
const METER_LABEL = { mom: 'momentum', health: 'health', spirit: 'spirit', res: 'Resources', heat: 'Heat' };
const signed = n => (n > 0 ? '+' + n : '−' + -n);
const rankShift = (rank, d) => RANKS[Math.max(-1, RANKS.indexOf(rank) - d)];
const LEGACY_TICKS = { troublesome: 1, dangerous: 2, formidable: 4, extreme: 8, epic: 12 };

function fxContext(r) {
  return { hero: S().heroes[r.heroId] || null, track: r.trackId ? S().tracks[r.trackId] : null };
}

function openTracks(type) { return sorted(S().tracks).filter(t => !t.done && t.type === type); }

function fxButton(label, key, arg, disabled, cls = '') {
  return `<button class="btn sm fx ${cls}" data-act="fx" data-k="${esc(key)}" data-arg="${esc(arg || '')}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
}

function fxItem(e, key, r, off) {
  const { hero, track } = fxContext(r);
  switch (e.t) {
    case 'note': return `<p class="fxnote">${esc(e.text)}</p>`;
    case 'mom': case 'health': case 'spirit': case 'res': case 'heat':
      return fxButton(`${signed(e.n)} ${METER_LABEL[e.t]}`, key, '', off);
    case 'suffer':
      return `<span class="fxgroup"><span class="fxlabel">Suffer ${signed(-e.n)}:</span>${['mom', 'health', 'spirit', 'res'].map(m => fxButton(METER_LABEL[m], key, m, off)).join('')}</span>`;
    case 'tradeMomFor': return fxButton(`−1 momentum, +1 ${e.meter}`, key, '', off);
    case 'progress': {
      const ts = openTracks(e.type);
      if (!ts.length) return fxButton(`New ${e.type} track`, key + ':new', e.type, false, 'ghost');
      return ts.map(t => fxButton(`Mark progress${e.n > 1 ? ' ×' + e.n : ''}: ${t.name || t.type}`, key, t.id, off)).join('');
    }
    case 'pos': {
      const ts = openTracks('combat');
      return ts.map(t => fxButton(`${e.v === 'bad' ? 'Bad spot' : 'In control'}${ts.length > 1 ? ': ' + (t.name || 'fight') : ''}`, key, t.id, off, e.v === 'bad' ? 'warn' : '')).join('');
    }
    case 'clock': {
      const cs = sorted(S().clocks).filter(c => c.filled < c.segments);
      if (!cs.length) return '<p class="fxnote">No open clock. Add one on the Tracks tab.</p>';
      return cs.map(c => fxButton(`Fill ${e.n}: ${c.name || 'clock'}`, key, c.id, off, 'warn')).join('');
    }
    case 'nextAdd': return fxButton('+1 on next roll', key, '', off);
    case 'oracle': return fxButton(`Roll ${(D.oracleById[e.id] || {}).name || 'oracle'}`, key, '', off);
    case 'ptp': return fxButton('Pay the Price', key, '', off, 'warn');
    case 'nemesis': {
      const ns = sorted(S().nemeses).filter(n => n.status === 'large' && n.filled < n.segments);
      return ns.map(n => fxButton(`Advance scheme: ${n.name || 'Nemesis'}`, key, n.id, off, 'warn')).join('');
    }
    case 'escape': return sorted(S().nemeses).some(n => n.status === 'locked') ? fxButton('Escape check', key, '', off, 'warn') : '';
    case 'plot': return fxButton('Uncover a Plot', key, '', off);
    case 'legacy': {
      const rank = track && rankShift(track.rank, e.d);
      const ticks = rank ? LEGACY_TICKS[rank] : 0;
      return ticks ? fxButton(`${cap(e.l)} +${ticks} tick${ticks === 1 ? '' : 's'}`, key, '', off) : `<p class="fxnote">No ${e.l} reward at this rank.</p>`;
    }
    case 'heroicsScene': {
      const ticks = track ? (track.rank === 'troublesome' ? 0 : track.rank === 'dangerous' ? 1 : 2) : 0;
      return ticks ? fxButton(`Heroics +${ticks} tick${ticks === 1 ? '' : 's'}`, key, '', off) : '';
    }
    case 'milestone': {
      const vs = openTracks('vow');
      return vs.length ? vs.map(v => fxButton(`Milestone: ${v.name || 'vow'}`, key, v.id, off)).join('') : '<p class="fxnote">No open vow to mark a milestone on.</p>';
    }
    case 'done': return track ? fxButton('Mark track done', key, '', off || track.done) : '';
    case 'setback': {
      const n = Math.min(r.c1, r.c2);
      return fxButton(`Keep at it: clear ${n} box${n === 1 ? '' : 'es'}, raise rank`, key, '', off);
    }
    case 'abandon': return fxButton('Abandon: Pay the Price, +1 Heat', key, '', off, 'warn');
    case 'wrongPerson': return fxButton('Wrong person: +2 Heat, Pay the Price', key, '', off, 'warn');
    case 'forsake': return fxButton('Forsake the vow', key, '', off, 'warn');
    case 'newTrack': return openTracks(e.type).length ? '' : fxButton(`New ${e.type} track`, key, e.type, off, 'ghost');
    default: return '';
  }
}

function fxPanel(r) {
  const fx = effectsFor(r, r.trackId ? S().tracks[r.trackId] : null);
  if (!fx || !fx.list.length) return '';
  const a = r.applied || {};
  const items = fx.list.map((e, i) => {
    if (e.choose) {
      const used = e.options.filter((_, j) => a[`${i}.${j}`]).length;
      const full = used >= e.choose;
      return `<div class="fxchoose"><span class="fxlabel">Choose ${e.choose === 1 ? 'one' : e.choose}:</span>${e.options.map((o, j) => fxItem(o, `${i}.${j}`, r, a[`${i}.${j}`] || full)).join('')}</div>`;
    }
    return fxItem(e, String(i), r, a[String(i)]);
  }).join('');
  return `<div class="fxpanel">${fx.name ? `<div class="fxlabel">${esc(fx.name)}</div>` : ''}${items}</div>`;
}

function findFx(r, key) {
  const fx = effectsFor(r, r.trackId ? S().tracks[r.trackId] : null);
  if (!fx) return null;
  const [i, j] = key.split(':')[0].split('.').map(Number);
  const e = fx.list[i];
  return j === undefined ? e : e && e.options && e.options[j];
}

function bumpMeter(hero, meter, n) {
  if (meter === 'res') {
    store.set(['shared', 'resources'], Math.max(0, Math.min(5, S().shared.resources + n)));
    return `Resources ${signed(n)}`;
  }
  if (!hero) return '';
  if (meter === 'mom') {
    const lim = momentumLimits(hero);
    store.set(['heroes', hero.id, 'momentum'], Math.max(-6, Math.min(lim.max, hero.momentum + n)));
    return `${hero.name}: momentum ${signed(n)}`;
  }
  const max = meter === 'heat' ? 5 : meter === 'health' && Object.values(hero.assets).some(x => x.ref === 'ss/power_toughness') ? 6 : 5;
  store.set(['heroes', hero.id, meter], Math.max(0, Math.min(max, hero[meter] + n)));
  return `${hero.name}: ${METER_LABEL[meter]} ${signed(n)}`;
}

function applyFx(el) {
  const r = ui.lastRoll;
  if (!r) return;
  const key = el.dataset.k, arg = el.dataset.arg;
  const e = findFx(r, key);
  if (!e) return;
  const { hero, track } = fxContext(r);
  const said = [];
  const say = t => { if (t) said.push(t); };
  if (key.endsWith(':new')) {
    const t = { id: uid(), created: Date.now(), name: '', type: arg, rank: 'dangerous', ticks: 0, done: false };
    store.set(['tracks', t.id], t);
    render();
    return; // creating a track does not use up the effect
  }
  switch (e.t) {
    case 'mom': case 'health': case 'spirit': case 'res': case 'heat': say(bumpMeter(hero, e.t, e.n)); break;
    case 'suffer': say(bumpMeter(hero, arg, -e.n)); break;
    case 'tradeMomFor': say(bumpMeter(hero, 'mom', -1)); say(bumpMeter(hero, e.meter, 1)); break;
    case 'progress': {
      const t = S().tracks[arg];
      if (!t) return;
      store.set(['tracks', t.id, 'ticks'], Math.min(MAX_TICKS, t.ticks + TICKS_PER_MARK[t.rank] * e.n));
      say(`Progress${e.n > 1 ? ' ×' + e.n : ''} on ${t.name || t.type}`);
      break;
    }
    case 'pos': store.set(['tracks', arg, 'position'], e.v); say(e.v === 'bad' ? 'In a bad spot' : 'In control'); break;
    case 'clock': {
      const c = S().clocks[arg];
      if (!c) return;
      store.set(['clocks', c.id, 'filled'], Math.min(c.segments, c.filled + e.n));
      say(`${c.name || 'Clock'} ${Math.min(c.segments, c.filled + e.n)}/${c.segments}`);
      break;
    }
    case 'nextAdd': ui.rollAdds = 1; say('+1 on the next roll'); break;
    case 'oracle': doOracle(e.id); break;
    case 'ptp': doOracle('sf/moves/pay_the_price'); break;
    case 'nemesis': {
      const n = S().nemeses[arg];
      if (!n) return;
      store.set(['nemeses', n.id, 'filled'], Math.min(n.segments, n.filled + 1));
      say(`${n.name || 'A Nemesis'}'s scheme advances (${Math.min(n.segments, n.filled + 1)}/${n.segments})`);
      break;
    }
    case 'escape': r.applied[key] = true; actions.escapeCheck(); return;
    case 'plot': doOracle('ss/plot'); if (hero) store.set(['heroes', hero.id, 'legacies', 'heroics'], Math.min(40, hero.legacies.heroics + 2)); say('Uncover a Plot: Heroics +2 ticks'); break;
    case 'legacy': {
      const rank = track && rankShift(track.rank, e.d);
      const ticks = rank ? LEGACY_TICKS[rank] : 0;
      if (hero && ticks) store.set(['heroes', hero.id, 'legacies', e.l], Math.min(40, hero.legacies[e.l] + ticks));
      say(`${hero ? hero.name + ': ' : ''}${e.l} +${ticks} ticks`);
      break;
    }
    case 'heroicsScene': {
      const ticks = track ? (track.rank === 'dangerous' ? 1 : 2) : 0;
      if (hero) store.set(['heroes', hero.id, 'legacies', 'heroics'], Math.min(40, hero.legacies.heroics + ticks));
      say(`Heroics +${ticks} ticks`);
      break;
    }
    case 'milestone': {
      const v = S().tracks[arg];
      if (!v) return;
      store.set(['tracks', v.id, 'ticks'], Math.min(MAX_TICKS, v.ticks + TICKS_PER_MARK[v.rank]));
      say(`Milestone on ${v.name || 'vow'}`);
      break;
    }
    case 'done': if (track) { store.set(['tracks', track.id, 'done'], true); say(`${track.name || track.type} done`); } break;
    case 'setback': if (track) {
      const n = Math.min(r.c1, r.c2);
      store.set(['tracks', track.id, 'ticks'], Math.max(0, track.ticks - n * 4));
      store.set(['tracks', track.id, 'rank'], RANKS[Math.min(RANKS.length - 1, RANKS.indexOf(track.rank) + 1)]);
      say(`${track.name || track.type}: cleared ${n} boxes and raised the rank`);
    } break;
    case 'abandon': doOracle('sf/moves/pay_the_price'); say(bumpMeter(hero, 'heat', 1)); if (track) store.set(['tracks', track.id, 'done'], true); say('Patrol abandoned'); break;
    case 'wrongPerson': doOracle('sf/moves/pay_the_price'); say(bumpMeter(hero, 'heat', 2)); say('Accused the wrong person'); break;
    case 'forsake': if (track) store.set(['tracks', track.id, 'done'], true); say('Vow forsaken. Endure Stress.'); break;
    case 'newTrack': {
      const t = { id: uid(), created: Date.now(), name: '', type: arg, rank: 'dangerous', ticks: 0, done: false };
      store.set(['tracks', t.id], t);
      break;
    }
    default: return;
  }
  r.applied[key] = true;
  if (said.length) log(said.join('. ') + '.', 'roll');
  render();
}

// ---------- character creation ----------
const ARCHETYPES = [
  { id: 'brawler', name: 'Masked brawler', blurb: 'Fists, grit and a neighborhood to protect.', stats: { iron: 3, edge: 2, heart: 2, shadow: 1, wits: 1 }, power: 'ss/power_super_strength', source: 'Training', path: 'ss/vigilante', extra: 'ss/kit', vow: 'Drive the gang that killed my brother out of the neighborhood' },
  { id: 'excop', name: 'Ex-cop gone rogue', blurb: 'Knows how the department works, and who owns it.', stats: { wits: 3, iron: 2, heart: 2, edge: 1, shadow: 1 }, power: 'ss/power_danger_sense', source: 'Training', path: 'ss/investigator', extra: 'ss/special_vehicle', vow: 'Prove who in the department set me up' },
  { id: 'hacker', name: 'Hacker in a van', blurb: 'Cameras, phones and locks all answer to you.', stats: { wits: 3, shadow: 2, edge: 2, heart: 1, iron: 1 }, power: 'ss/power_gadgeteer', source: 'Technology', path: 'ss/genius', extra: 'ss/kit', vow: 'Expose the company that ruined my family' },
  { id: 'thief', name: 'Reformed thief', blurb: 'Rooftops, locks and old debts.', stats: { shadow: 3, edge: 2, wits: 2, heart: 1, iron: 1 }, power: 'ss/power_danger_sense', source: 'Training', path: 'ss/secret_identity', extra: 'ss/kit', vow: 'Pay back everyone I stole from' },
  { id: 'medic', name: 'Night-shift medic', blurb: 'Patches people up, then goes looking for whoever hurt them.', stats: { heart: 3, iron: 2, wits: 2, edge: 1, shadow: 1 }, power: 'ss/power_healing_factor', source: 'Mutation', path: 'ss/code_of_honor', extra: 'ss/kit', vow: "Find out what's making people sick in the projects" },
  { id: 'reporter', name: 'Reporter with a mask', blurb: 'The story by day, the truth by night.', stats: { heart: 3, wits: 2, shadow: 2, edge: 1, iron: 1 }, power: 'ss/power_enhanced_senses', source: 'Training', path: 'ss/journalist', extra: 'ss/investigator', vow: 'Bring down the man who owns city hall' },
  { id: 'occult', name: 'Occult detective', blurb: 'One strange gift, and it cost too much.', stats: { wits: 3, heart: 2, shadow: 2, edge: 1, iron: 1 }, power: 'ss/power_custom', source: 'Supernatural', path: 'ss/investigator', extra: 'ss/secret_identity', vow: 'Find out what I bargained away' },
];
const STAT_ARRAY = [3, 2, 2, 1, 1];

function newWizard() {
  return { archetype: '', name: '', identity: '', stats: { edge: 0, heart: 0, iron: 0, shadow: 0, wits: 0 }, power: '', source: 'Training', path: '', extra: '', bgVow: '', nowVow: '', nowRank: 'dangerous', hqType: '' };
}
function applyArchetype(id) {
  const a = ARCHETYPES.find(x => x.id === id);
  if (!a) return;
  Object.assign(ui.cw, { archetype: a.id, stats: { ...a.stats }, power: a.power, source: a.source, path: a.path, extra: a.extra, bgVow: ui.cw.bgVow || a.vow });
}
function cwReady(w) { return !!(w.name.trim() && statsValid(w.stats) && w.power && w.path && w.bgVow.trim()); }
function cwRefresh() {
  const btn = document.querySelector('[data-act="cwCreate"]');
  if (!btn || !ui.cw) return;
  const ready = cwReady(ui.cw);
  btn.disabled = !ready;
  const hint = btn.nextElementSibling;
  if (hint && hint.classList.contains('hint') && hint.dataset.cwhint) hint.hidden = ready;
}
function statsValid(st) {
  return Object.values(st).sort((x, y) => y - x).join() === STAT_ARRAY.join();
}

function viewCreate() {
  const w = ui.cw || (ui.cw = newWizard());
  const assetsOf = cats => D.assets.filter(a => cats.includes(a.cat));
  const opt = (list, cur, blank = '(choose)') => `<option value="">${blank}</option>` + list.map(a => `<option value="${esc(a.id)}" ${a.id === cur ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  const valid = statsValid(w.stats);
  const strange = w.source && !['Training', 'Technology'].includes(w.source);
  const ready = cwReady(w);
  return `<div class="modal-head"><h3>New hero</h3><button class="btn sm" data-act="closeModal">Cancel</button></div>
  <section class="card">
    <h4>1. Pick an archetype <small>or skip and build your own</small></h4>
    <div class="arch">${ARCHETYPES.map(a => `<button class="archbtn ${w.archetype === a.id ? 'on' : ''}" data-act="cwArchetype" data-id="${a.id}"><b>${esc(a.name)}</b><span>${esc(a.blurb)}</span></button>`).join('')}</div>
  </section>
  <section class="card">
    <h4>2. Who are they?</h4>
    <label class="field">Hero name <input data-cw="name" value="${esc(w.name)}" placeholder="What the papers call you"></label>
    <label class="field">By day <input data-cw="identity" value="${esc(w.identity)}" placeholder="Name and how you pay rent"></label>
  </section>
  <section class="card">
    <h4>3. Stats <small>${valid ? 'looks good' : 'use 3, 2, 2, 1, 1'}</small></h4>
    <div class="cwstats">${D.rules.stats.map(s => `<label>${cap(s)} <select data-cw="stat.${s}">${[0, 1, 2, 3].map(v => `<option value="${v}" ${w.stats[s] === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`).join('')}</div>
    ${valid ? '' : '<p class="err">Each stat gets one number from 3, 2, 2, 1, 1.</p>'}
  </section>
  <section class="card">
    <h4>4. Assets <small>HQ is added for you</small></h4>
    <label class="field">Power <select data-cw="power">${opt(assetsOf(['Power']), w.power)}</select></label>
    <label class="field">Source <select data-cw="source">${D.sources.map(s => `<option ${s.name === w.source ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    ${strange ? `<p class="hint">${esc(w.source)} powers are limited to one card and come with a cost. Note the cost on the power after creating.</p>` : ''}
    <label class="field">Path <select data-cw="path">${opt(assetsOf(['Path']), w.path)}</select></label>
    <label class="field">One more <select data-cw="extra">${opt(assetsOf(['Module', 'Companion', 'Path', 'Power', 'Deed']), w.extra, '(none for now)')}</select></label>
    <label class="field">Hideout <input data-cw="hqType" value="${esc(w.hqType)}" placeholder="Back room of a diner, a friend's garage…"></label>
  </section>
  <section class="card">
    <h4>5. Vows</h4>
    <label class="field">Background vow (Epic) <input data-cw="bgVow" value="${esc(w.bgVow)}" placeholder="The thing you'll spend the whole campaign on"></label>
    <label class="field">What you're doing right now <input data-cw="nowVow" value="${esc(w.nowVow)}" placeholder="Optional: a smaller vow tied to the city"></label>
    <label class="field">Its rank <select data-cw="nowRank">${['troublesome', 'dangerous'].map(x => `<option ${x === w.nowRank ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
  </section>
  <section class="card">
    <button class="btn big accent" data-act="cwCreate" ${ready ? '' : 'disabled'}>Create hero</button>
<p class="hint" data-cwhint="1" ${ready ? 'hidden' : ''}>Needs a name, valid stats, a power, a path and a background vow.</p>
    <p class="hint">After this, generate a Nemesis together on the Tracks tab. It's a villain who already knows one of you, with their scheme clock at 2.</p>
    <button class="btn sm" data-act="cwBlank">Skip and make a blank hero instead</button>
  </section>`;
}

function createFromWizard() {
  const w = ui.cw;
  if (!w || !statsValid(w.stats)) return;
  const h = blankHero(w.name.trim());
  h.identity = w.identity.trim();
  h.stats = { ...w.stats };
  const add = (ref, fields = {}) => {
    const a = D.assetById[ref];
    if (!a) return;
    const inst = { id: uid(), created: Date.now() + Object.keys(h.assets).length, ref, enabled: { a0: true }, fields, meters: {} };
    for (const [k, m] of Object.entries(a.meters || {})) inst.meters[k] = k === 'health' || k === 'integrity' ? m.max : 0;
    h.assets[inst.id] = inst;
  };
  add('ss/hq', w.hqType ? { type: w.hqType.trim() } : {});
  add(w.power, { source: w.source });
  add(w.path);
  if (w.extra) add(w.extra);
  if (Object.values(h.assets).some(x => x.ref === 'ss/power_toughness')) h.health = 6;
  store.set(['heroes', h.id], h);
  const vow = (name, rank) => { const t = { id: uid(), created: Date.now(), name, type: 'vow', rank, ticks: 0, done: false }; store.set(['tracks', t.id], t); };
  vow(`${h.name}: ${w.bgVow.trim()}`, 'epic');
  if (w.nowVow.trim()) vow(`${h.name}: ${w.nowVow.trim()}`, w.nowRank);
  log(`**${h.name} joins the fight.** ${h.identity ? h.identity + '. ' : ''}Background vow: ${w.bgVow.trim()}.`, 'note');
  ui.heroId = h.id; ui.rollHero = h.id; ui.cw = null; ui.modal = null; ui.tab = 'heroes'; saveUi();
  render(); $view().scrollTop = 0;
}

// ---------- sessions ----------
function lastRecap() { return sorted(S().journal).filter(e => e.kind === 'recap').pop(); }

function viewBegin() {
  const d = ui.beginDone || {};
  const recap = lastRecap();
  return `<div class="modal-head"><h3>Begin session ${S().shared.session + 1}</h3><button class="btn sm" data-act="closeModal">${d.started ? 'Done' : 'Cancel'}</button></div>
  ${recap ? `<section class="card recap"><h4>Previously…</h4>${md(recap.text.replace(/^\*\*Recap of session \d+\.\*\*\s*/, ''))}</section>` : ''}
  <section class="card">
    <ol class="steps">
      <li><b>Check in on content.</b><p>Anything either of you wants kept off the table, or handled off screen? Set a flag.</p></li>
      <li><b>Recap.</b><p>${recap ? 'Read the recap above out loud.' : 'Talk through what happened last time.'}</p></li>
      <li><b>Set the scene.</b><p>Where is each hero right now, and what do they want tonight?</p></li>
      <li><b>Optional: spotlight a danger.</b><p>A short scene the heroes can't see. If you play one, everyone takes +1 momentum.</p>
        <div class="row wrap">${fxBtn('beginSpotlight', 'Roll a spotlight', d.spot)}${fxBtn('allMomentum', 'Everyone +1 momentum', d.mom, 'begin')}</div></li>
    </ol>
    <button class="btn big accent" data-act="beginSession" ${d.started ? 'disabled' : ''}>${d.started ? `Session ${S().shared.session} started` : 'Start the session'}</button>
  </section>`;
}
function fxBtn(act, label, done, which = '', id = '') {
  return `<button class="btn sm" data-act="${act}" data-which="${esc(which)}" data-id="${esc(id)}" ${done ? 'disabled' : ''}>${esc(label)}</button>`;
}

function viewEnd() {
  const d = ui.endDone || {};
  const ai = aiReady();
  const large = sorted(S().nemeses).filter(n => n.status === 'large');
  return `<div class="modal-head"><h3>End session ${S().shared.session}</h3><button class="btn sm" data-act="closeModal">Done</button></div>
  <section class="card">
    <ol class="steps">
      <li><b>Missed progress?</b><p>Did you move forward on a vow? Reach a Milestone. Grow closer to a Connection? Develop Your Relationship. Mark it on the Tracks tab.</p></li>
      <li><b>Nemeses who went unopposed</b><p>Advance the scheme of any Nemesis the heroes didn't touch this session.</p>
        <div class="row wrap">${large.length ? large.map(n => fxBtn('endAdvance', `Advance ${n.name || 'Nemesis'} (${n.filled}/${n.segments})`, d['n' + n.id], '', n.id)).join('') : '<span class="muted">No Nemesis at large.</span>'}</div></li>
      <li><b>Pick a focus for next time</b><p>Note a vow, Connection or thread to focus on next session, and take +1 momentum.</p>
        <div class="row wrap">${fxBtn('allMomentum', 'Everyone +1 momentum', d.mom, 'end')}</div></li>
      <li><b>Recap</b><p>${ai ? 'Let the AI draft a "previously on" from tonight\'s journal, then edit it.' : 'Write a few lines about tonight. It shows up at the start of next session.'}</p>
        ${ai ? `<button class="btn sm" data-act="genRecap">Draft recap from the journal</button>` : ''}
        <textarea id="recaptext" rows="6" placeholder="Tonight, Night Owl…">${esc(ui.recapDraft || '')}</textarea>
        <button class="btn accent" data-act="saveRecap" ${d.recap ? 'disabled' : ''}>${d.recap ? 'Recap saved' : 'Save recap'}</button></li>
    </ol>
  </section>`;
}

// ---------- campaign chooser ----------
function viewCampaigns() {
  const camps = store.campaigns();
  const cur = S().meta.id;
  const when = t => (t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
  return `<div class="modal-head"><h3>Campaigns</h3><button class="btn sm" data-act="closeModal">Close</button></div>
  ${camps.map(c => `<section class="card camp ${c.id === cur ? 'current' : ''}">
    ${c.id === cur ? `<input class="title-in" data-rename="1" value="${esc(S().meta.name)}" aria-label="Campaign name">` : `<h3>${esc(c.name)}</h3>`}
    <p class="muted small">${esc(gameName(c.game || 'supersworn'))}${c.city ? ' · ' + esc(c.city) : ''}${c.session ? ` · session ${esc(c.session)}` : ''} · ${esc(when(c.updated))}</p>
    ${c.heroes && c.heroes.length ? `<p class="small">${c.heroes.map(esc).join(', ')}</p>` : ''}
    <div class="row wrap">${c.id === cur ? '<span class="tag">Open now</span>' : `<button class="btn accent sm" data-act="switchCamp" data-id="${esc(c.id)}">Open</button><button class="btn sm danger" data-act="delCamp" data-id="${esc(c.id)}">Delete</button>`}</div>
  </section>`).join('')}
  <section class="card">
    <h4>New campaign</h4>
    <label class="field">Name <input id="newcampname" placeholder="Eastside Nights"></label>
    <label class="field">Game <select id="newcampgame">${GAMES.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}<option disabled>More games later</option></select></label>
    <button class="btn" data-act="newCamp">Create campaign</button>
  </section>`;
}

function showErr(msg) { const e = document.getElementById('syncerr'); if (e) e.textContent = msg; }

function confirmTwice(el) {
  if (el.dataset.armed) return true;
  el.dataset.armed = '1';
  const old = el.textContent;
  el.textContent = 'Tap again to confirm';
  setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = old; } }, 3000);
  return false;
}

// ---------- wiring ----------
function wire() {
  document.addEventListener('click', e => {
    const tab = e.target.closest('nav button[data-tab]');
    if (tab) { ui.tab = tab.dataset.tab; ui.modal = null; saveUi(); render(); $view().scrollTop = 0; return; }
    if (e.target.closest('#campname')) { ui.modal = ui.modal === 'campaigns' ? null : 'campaigns'; render(); $view().scrollTop = 0; return; }
    if (e.target.closest('#settingsbtn')) { ui.modal = ui.modal === 'settings' ? null : 'settings'; render(); $view().scrollTop = 0; return; }
    const el = e.target.closest('[data-act]');
    if (el && actions[el.dataset.act]) { e.preventDefault(); actions[el.dataset.act](el); }
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.toggle) {
      const p = JSON.parse(el.dataset.toggle);
      store.set(p, el.checked);
      if (p[0] === 'heroes' && p[2] === 'impacts') {
        const h = S().heroes[p[1]];
        const { max } = momentumLimits(h);
        if (h && h.momentum > max) store.set(['heroes', h.id, 'momentum'], max);
      }
      return;
    }
    if (el.dataset.bind) {
      let v = el.value;
      if (el.dataset.num) v = +v;
      store.set(JSON.parse(el.dataset.bind), v);
      return;
    }
    if (el.dataset.pref) { store.setPref(el.dataset.pref, el.value.trim()); return; }
    if (el.dataset.cw) {
      const k = el.dataset.cw;
      if (k.startsWith('stat.')) ui.cw.stats[k.slice(5)] = +el.value; else ui.cw[k] = el.value;
      if (el.tagName === 'SELECT') render();
      return;
    }
    if (el.id === 'recaptext') { ui.recapDraft = el.value; return; }
    if (el.dataset.rename) { store.set(['meta', 'name'], el.value.trim() || 'Campaign'); return; }
    if (el.dataset.ui) {
      ui[el.dataset.ui] = el.value;
      if (el.dataset.ui === 'rollHero') { ui.heroId = el.value; }
      if (el.dataset.ui === 'moveId') { const m = D.moveById[el.value]; if (m && m.stats.length) ui.rollStat = m.stats[0]; }
      saveUi(); render();
      return;
    }
    if (el.dataset.portrait && el.files && el.files[0]) {
      const path = JSON.parse(el.dataset.portrait);
      shrinkImage(el.files[0]).then(url => store.set(path, url)).catch(err => toast(err.message));
      return;
    }
    if (el.id === 'importfile' && el.files[0]) {
      el.files[0].text().then(t => {
        try {
          const data = JSON.parse(t);
          if (!data || typeof data !== 'object' || !data.meta) throw new Error();
          if (store.campaigns().some(c => c.id === data.meta.id)) data.meta = { ...data.meta, id: uid(), name: (data.meta.name || 'Campaign') + ' (imported)' };
          sync.leave(); store.replace(data); ui.modal = null; render();
        }
        catch { showErr('That file is not a Supersworn backup.'); }
      });
    }
  });
  // Live search fields re-render as you type, keeping focus.
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.ui && el.classList.contains('search')) {
      ui[el.dataset.ui] = el.value;
      const pos = el.selectionStart;
      render();
      const again = $view().querySelector(`[data-ui="${el.dataset.ui}"]`);
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    }
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (!t.dataset) return;
    if (t.dataset.draft) ui.drafts[t.id] = t.value;
    if (t.dataset.cw && t.tagName === 'INPUT' && ui.cw) { ui.cw[t.dataset.cw] = t.value; cwRefresh(); }
    if (t.id === 'recaptext') ui.recapDraft = t.value;
    if (t.dataset.d100) ui.d100 = t.value;
  });
  document.addEventListener('focusout', () => setTimeout(() => { if (ui.pendingRender) requestRender(); }, 0));
  // Hold re-renders while a finger is down so the button being tapped still exists when its click fires.
  let releaseTimer = null;
  const release = () => { clearTimeout(releaseTimer); pointerDown = false; if (ui.pendingRender) requestRender(); };
  document.addEventListener('pointerdown', () => { pointerDown = true; clearTimeout(releaseTimer); }, true);
  document.addEventListener('pointerup', () => { clearTimeout(releaseTimer); releaseTimer = setTimeout(release, 400); }, true);
  document.addEventListener('pointercancel', release, true);
  document.addEventListener('click', () => setTimeout(release, 0), true);
  store.onChange(() => requestRender());
  sync.onStatus(() => requestRender());
}

async function main() {
  store.load();
  try { await loadData(); }
  catch (err) {
    $view().innerHTML = '<section class="card"><p class="alert">Could not load the game data.</p><p class="small">Check your connection and reload. If you installed the app, open it once while online.</p></section>';
    return;
  }
  wire();
  render();
  let saved = null;
  try { saved = localStorage.getItem('ss.syncCode'); } catch { /* ignore */ }
  if (saved) sync.resume(saved);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

main();
