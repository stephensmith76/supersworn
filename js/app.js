import { store, uid, blankHero, sorted } from './store.js';
import { sync } from './sync.js';
import {
  rnd, RANKS, TICKS_PER_MARK, LEGACY_REWARD, MAX_TICKS, boxes, momentumLimits, HEAT_EFFECTS,
  actionRoll, progressRoll, RESULT_LABEL, ODDS, askOracle, rollOracle,
} from './rules.js';
import { AI_PROVIDERS, askRules } from './ai.js';

// ---------- data ----------
const D = { moves: [], oracles: [], assets: [], oracleById: {}, assetById: {}, moveById: {}, rules: {}, sources: [] };

async function loadData() {
  const [sf, ss, vil, notes] = await Promise.all([
    fetch('data/starforged.json').then(r => r.json()),
    fetch('data/supersworn.json').then(r => r.json()),
    fetch('data/villains.json').then(r => r.json()),
    fetch('data/rules-notes.md').then(r => r.text()),
  ]);
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
  rollAdds: 0, rollHero: null, moveQuery: '', oracleQuery: '', assetQuery: '', pendingRender: false,
};
try { Object.assign(ui, JSON.parse(localStorage.getItem('ss.ui') || '{}'), { modal: null, lastRoll: null, pendingRender: false }); } catch { /* ignore */ }
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
    <span class="val">${value > 0 && min < 0 ? '+' : ''}${value}</span>
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
  <div class="chips">${hs.map(x => `<button class="chip ${h && x.id === h.id ? 'on' : ''}" data-act="pickHero" data-id="${x.id}">${esc(x.name || 'Unnamed')}</button>`).join('')}
    <button class="chip add" data-act="addHero">+ Hero</button></div>`;
  if (!h) return out + `<p class="empty">No heroes yet. Add one to start, or open settings to join your partner's campaign.</p>`;
  const P = k => ['heroes', h.id, k];
  const lim = momentumLimits(h);
  const xpEarned = Object.values(h.legacies).reduce((a, t) => a + boxes(t) * 2, 0);
  out += `<section class="card">
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
  return `<details class="asset">
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
    ${order.filter(c => groups[c]).map(c => `<h4>${c}</h4>${groups[c].map(a => `<details class="asset pick"><summary>${esc(a.name)} ${a.id.startsWith('ss/') ? '<span class="tag">Supersworn</span>' : ''}</summary>
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
        ${input(p.concat('name'), n.name, { placeholder: 'Nemesis name', cls: 'name-in' })}
        ${input(p.concat('gimmick'), n.gimmick, { placeholder: 'Gimmick: what they do and how' })}
        <div class="row wrap">
          <select data-bind='${esc(JSON.stringify(p.concat('rank')))}'>${RANKS.map(x => `<option ${x === n.rank ? 'selected' : ''}>${x}</option>`).join('')}</select>
          <select data-bind='${esc(JSON.stringify(p.concat('status')))}'><option value="large" ${n.status === 'large' ? 'selected' : ''}>At large</option><option value="locked" ${n.status === 'locked' ? 'selected' : ''}>Locked up</option><option value="retired" ${n.status === 'retired' ? 'selected' : ''}>Retired</option></select>
        </div>
        ${clockBlock(p, n, 'Scheme', true)}
        <details class="sheet"><summary>Villain sheet</summary>${input(p.concat('sheet'), n.sheet || '', { area: true, placeholder: 'Motive, edge, method, weakness, lair, muscle, look, calling card' })}</details>
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
      ? `<div class="dice"><span class="d6">${r.cancelled ? '<s>' + r.a + '</s>' : r.a}</span> + ${r.stat} ${r.adds ? `+ ${r.adds}` : ''} = <b>${r.burned ? r.burn.score + ' (momentum)' : r.score}</b>
         <span class="vs">vs</span> <span class="d10">${r.c1}</span><span class="d10">${r.c2}</span></div>`
      : `<div class="dice">Progress <b>${r.score}</b> <span class="vs">vs</span> <span class="d10">${r.c1}</span><span class="d10">${r.c2}</span></div>`}
    ${r.cancelled ? '<p class="small">Negative momentum cancelled the action die.</p>' : ''}
    ${r.label ? `<p class="small">${esc(r.label)}</p>` : ''}
    ${r.burn && !r.burned ? `<button class="btn accent" data-act="burn">Burn momentum: ${RESULT_LABEL[r.burn.result]}</button>` : ''}
    ${r.match && r.kind === 'action' ? '<p class="small">A match: check scheme clocks, and Nemesis escapes if you were patrolling.</p>' : ''}
  </div>`;
}

function viewRoll() {
  const hs = heroes();
  const h = S().heroes[ui.rollHero] || currentHero();
  const opts = rollStatOptions(h);
  const move = D.moveById[ui.moveId];
  const groups = {};
  const q = ui.moveQuery.toLowerCase();
  for (const m of D.moves) {
    if (q && !(m.name + ' ' + m.text).toLowerCase().includes(q)) continue;
    const g = (m.id.startsWith('ss/') ? 'Supersworn: ' : '') + m.cat;
    (groups[g] = groups[g] || []).push(m);
  }
  const progTracks = sorted(S().tracks).filter(t => !t.done);
  return `<section class="card">
    <h3>Action roll</h3>
    <div class="form">
      <label>Hero <select data-ui="rollHero">${hs.map(x => `<option value="${x.id}" ${h && x.id === h.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label>Move <select data-ui="moveId"><option value="">(none)</option>${D.moves.filter(m => m.roll === 'action_roll').map(m => `<option value="${m.id}" ${m.id === ui.moveId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
      <label>Roll + <select data-ui="rollStat">${opts.map(([k, l, v]) => `<option value="${k}" ${k === ui.rollStat ? 'selected' : ''}>${esc(l)} (${v})</option>`).join('')}</select></label>
      <div class="row between"><span>Adds</span>${stepper(['__ui', 'rollAdds'], ui.rollAdds, { min: -3, max: 5 })}</div>
    </div>
    <button class="btn big accent" data-act="actionRoll" ${h ? '' : 'disabled'}>Roll</button>
    ${h ? '' : '<p class="empty">Add a hero first.</p>'}
    ${ui.lastRoll && ui.lastRoll.kind === 'action' ? rollCard(ui.lastRoll) : ''}
    ${move ? `<details class="movetext" open><summary>${esc(move.name)}</summary>${md(move.text)}${(move.oracles || []).map(o => `<button class="btn sm" data-act="rollOracle" data-id="${o}">Roll ${esc(D.oracleById[o].name)}</button>`).join(' ')}</details>` : ''}
  </section>
  <section class="card">
    <h3>Progress roll</h3>
    ${progTracks.length ? `<div class="chips">${progTracks.map(t => `<button class="chip" data-act="progressRoll" data-id="${t.id}">${esc(t.name || t.type)} (${boxes(t.ticks)})</button>`).join('')}</div>` : '<p class="empty">No open tracks.</p>'}
    ${ui.lastRoll && ui.lastRoll.kind === 'progress' ? rollCard(ui.lastRoll) : ''}
  </section>
  <section class="card">
    <h3>Ask the Oracle</h3>
    <div class="chips">${ODDS.map(([l, c]) => `<button class="chip" data-act="yesno" data-c="${c}">${l}</button>`).join('')}</div>
    <div class="chips">${[6, 10, 100].map(n => `<button class="chip" data-act="die" data-n="${n}">d${n}</button>`).join('')}</div>
    ${ui.lastYesNo ? `<p class="yesno ${ui.lastYesNo.yes ? 'yes' : 'no'}">${esc(ui.lastYesNo.text)}</p>` : ''}
  </section>
  <section class="card">
    <h3>Moves</h3>
    <input class="search" data-ui="moveQuery" value="${esc(ui.moveQuery)}" placeholder="Search moves">
    ${Object.entries(groups).map(([g, ms]) => `<h4>${esc(g)}</h4>${ms.map(m => `<details class="movetext"><summary>${esc(m.name)}</summary>${md(m.text)}
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
    ${D.guides.map(g => `<details class="guide"><summary>${esc(g.title)}</summary><p class="muted">${esc(g.summary)}</p>
      <ol class="steps">${g.steps.map(s => `<li><b>${esc(s.t)}</b>${md(s.x)}${s.m && D.moveById[s.m] ? `<button class="btn sm" data-act="guideMove" data-id="${s.m}">${esc(D.moveById[s.m].name)}</button>` : ''}</li>`).join('')}</ol>
      ${g.tip ? `<p class="tipline">${esc(g.tip)}</p>` : ''}</details>`).join('')}
  </section>`;
  return guides + `<section class="card">
    <h3>Rules questions</h3>
    <p class="hint">Answers use the Supersworn and Starforged rules plus your current heroes, tracks and Nemeses. ${ai ? `Using ${esc(ai.label)}.` : ''}</p>
    ${ai ? '' : `<p class="alert">Add an API key in settings (gear icon) to turn this on.</p>`}
  </section>
  <div class="chat">${msgs.map((m, i) => `<div class="msg ${m.role}">${m.role === 'user' ? esc(m.show || m.text) : md(m.text)}
    ${m.role === 'assistant' && !m.error ? `<button class="btn sm" data-act="saveAnswer" data-i="${i}">Save to journal</button>` : ''}</div>`).join('')}
    ${ui.asking ? '<div class="msg assistant thinking">Checking the rules…</div>' : ''}</div>
  <section class="card ask">
    <textarea id="askq" rows="2" placeholder="Can I burn momentum on a progress roll?" ${ai ? '' : 'disabled'}></textarea>
    <div class="row wrap"><button class="btn accent" data-act="askSend" ${ai && !ui.asking ? '' : 'disabled'}>Ask</button>
    <button class="btn" data-act="askSend" data-walk="1" ${ai && !ui.asking ? '' : 'disabled'}>Walk me through it</button>
    ${msgs.length ? '<button class="btn sm" data-act="askClear">Clear chat</button>' : ''}</div>
  </section>`;
}

function viewJournal() {
  const entries = sorted(S().journal).reverse();
  return `<section class="card">
    <textarea id="jtext" rows="3" placeholder="What happens next?"></textarea>
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
      ? `<p class="code">Session code <b>${esc(sync.code)}</b> <span class="dot ${st}"></span> ${esc(st)}</p><button class="btn" data-act="leave">Stop syncing</button>`
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
    <h4>Campaigns on this device</h4>
    ${camps.map(c => `<div class="row between"><span>${esc(c.name)}${c.id === S().meta.id ? ' <small>(open)</small>' : ''}</span>
      <span>${c.id !== S().meta.id ? `<button class="btn sm" data-act="switchCamp" data-id="${c.id}">Open</button> <button class="btn sm danger" data-act="delCamp" data-id="${c.id}">Delete</button>` : ''}</span></div>`).join('')}
    <div class="row wrap"><button class="btn" data-act="newCamp">New campaign</button>
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
const MODALS = { assets: viewAssetPicker, settings: viewSettings, villain: viewVillain };
const $view = () => document.getElementById('view');

function render() {
  const v = $view();
  if (!v) return;
  const scroll = v.scrollTop;
  const open = [...v.querySelectorAll('details[open] > summary')].map(s => s.textContent);
  v.innerHTML = MODALS[ui.modal] ? MODALS[ui.modal]() : (VIEWS[ui.tab] || viewHeroes)();
  for (const s of v.querySelectorAll('details > summary')) if (open.includes(s.textContent)) s.parentElement.open = true;
  v.scrollTop = scroll;
  document.getElementById('campname').textContent = S().meta.name;
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('on', b.dataset.tab === ui.tab && !ui.modal);
  const dot = document.getElementById('syncdot');
  dot.className = 'dot ' + (sync.code ? sync.status : 'off');
  dot.title = sync.code ? `Synced: ${sync.code} (${sync.status})` : 'Not syncing';
  ui.pendingRender = false;
}

function requestRender() {
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
  const opt = rollStatOptions(h).find(o => o[0] === ui.rollStat) || ['none', 'No stat', 0];
  const r = actionRoll({ stat: opt[2], adds: ui.rollAdds, momentum: h.momentum });
  const move = D.moveById[ui.moveId];
  r.heroId = h.id;
  r.label = `${h.name}: ${move ? move.name + ', ' : ''}+${opt[1]}`;
  ui.lastRoll = r;
  log(`**${RESULT_LABEL[r.result]}${r.match ? ' (match)' : ''}** ${r.label}\nAction ${r.cancelled ? '0 (cancelled)' : r.a} + ${r.stat}${r.adds ? ' + ' + r.adds : ''} = ${r.score} vs ${r.c1}, ${r.c2}`, 'roll');
}

function doProgressRoll(id) {
  const t = S().tracks[id];
  if (!t) return;
  const r = progressRoll({ ticks: t.ticks });
  r.trackId = id;
  r.label = `${t.name || t.type} (${t.rank} ${t.type})`;
  ui.lastRoll = r;
  log(`**${RESULT_LABEL[r.result]}${r.match ? ' (match)' : ''}** Progress roll: ${r.label}\nProgress ${r.score} vs ${r.c1}, ${r.c2}`, 'roll');
}

function doOracle(id, quiet = false) {
  const o = D.oracleById[id];
  if (!o) return null;
  const r = rollOracle(o, D.oracleById);
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
      const d = $view().querySelector('.movetext:not([open])');
      if (d) { d.open = true; d.scrollIntoView(); }
    } else if (mt) mt.scrollIntoView({ block: 'nearest' });
  },
  async askSend(el) {
    const q = document.getElementById('askq');
    let text = q.value.trim();
    const show = (el && el.dataset.walk ? 'Walk me through it: ' : '') + text;
    if (!text || ui.asking) return;
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
    log(`**Rules: ${qn ? (qn.show || qn.text) : ''}**\n\n${a.text}`, 'oracle');
    el.textContent = 'Saved';
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
    store.set(['nemeses', n.id], { ...n, status: 'locked', filled: 0, scheme: '' });
    log(`**${n.name || 'A Nemesis'} is locked up.** Scheme cleared.`, 'roll');
  },
  escapeCheck() {
    const locked = sorted(S().nemeses).filter(n => n.status === 'locked');
    if (!locked.length) return;
    const d = rnd(10);
    if (d <= D.rules.nemesisEscape.max) {
      const n = locked[rnd(locked.length) - 1];
      const nextRank = RANKS[Math.min(RANKS.length - 1, RANKS.indexOf(n.rank) + 1)];
      store.set(['nemeses', n.id], { ...n, status: 'large', rank: nextRank, filled: 0, scheme: '' });
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
    const r = askOracle(+el.dataset.c);
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
  switchCamp(el) { sync.leave(); store.switchTo(el.dataset.id); ui.heroId = null; render(); },
  delCamp(el) { if (confirmTwice(el)) { store.deleteCampaign(el.dataset.id); render(); } },
  newCamp() { sync.leave(); store.newCampaign('New campaign'); ui.heroId = null; render(); },
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
    rulesText = `${D.notes}\n\n## Moves\n\n${ss}\n\n${sf}\n\n## Supersworn assets\n\n${assets}`;
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
    if (e.target.closest('#settingsbtn')) { ui.modal = ui.modal === 'settings' ? null : 'settings'; render(); $view().scrollTop = 0; return; }
    const el = e.target.closest('[data-act]');
    if (el && actions[el.dataset.act]) { e.preventDefault(); actions[el.dataset.act](el); }
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.toggle) { store.set(JSON.parse(el.dataset.toggle), el.checked); return; }
    if (el.dataset.bind) {
      let v = el.value;
      if (el.dataset.num) v = +v;
      store.set(JSON.parse(el.dataset.bind), v);
      return;
    }
    if (el.dataset.pref) { store.setPref(el.dataset.pref, el.value.trim()); return; }
    if (el.dataset.ui) {
      ui[el.dataset.ui] = el.value;
      if (el.dataset.ui === 'rollHero') { ui.heroId = el.value; }
      if (el.dataset.ui === 'moveId') { const m = D.moveById[el.value]; if (m && m.stats.length) ui.rollStat = m.stats[0]; }
      saveUi(); render();
      return;
    }
    if (el.id === 'importfile' && el.files[0]) {
      el.files[0].text().then(t => {
        try { const data = JSON.parse(t); if (!data.meta) throw new Error(); data.meta.id = data.meta.id || uid(); sync.leave(); store.replace(data); ui.modal = null; render(); }
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
  document.addEventListener('focusout', () => setTimeout(() => { if (ui.pendingRender) requestRender(); }, 0));
  store.onChange(() => requestRender());
  sync.onStatus(() => requestRender());
}

async function main() {
  store.load();
  await loadData();
  wire();
  render();
  let saved = null;
  try { saved = localStorage.getItem('ss.syncCode'); } catch { /* ignore */ }
  if (saved) sync.resume(saved);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

main();
