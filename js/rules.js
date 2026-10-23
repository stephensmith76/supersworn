// Dice and game math. Kept free of UI so it is easy to check.
export const rnd = n => 1 + Math.floor(Math.random() * n);

export const RANKS = ['troublesome', 'dangerous', 'formidable', 'extreme', 'epic'];
export const TICKS_PER_MARK = { troublesome: 12, dangerous: 8, formidable: 4, extreme: 2, epic: 1 };
export const LEGACY_REWARD = { troublesome: 1, dangerous: 2, formidable: 4, extreme: 8, epic: 12 };
export const MAX_TICKS = 40;

export const boxes = ticks => Math.floor(Math.min(ticks, MAX_TICKS) / 4);

export function momentumLimits(hero) {
  const n = Object.values(hero.impacts || {}).filter(Boolean).length;
  return { max: 10 - n, reset: n === 0 ? 2 : n === 1 ? 1 : 0 };
}

export const HEAT_EFFECTS = [
  'Rumors only.',
  'Rumors only.',
  'In the papers. Vigilante police ability off. Police on scene on patrol weak hits.',
  'In the papers. Vigilante police ability off. Police on scene on patrol weak hits.',
  'Task force. Cops on every patrol miss. Secret Identity -1.',
  'Manhunt! Face Danger +shadow or your HQ is raided, then drop Heat to 3.',
];

function outcome(score, c1, c2) {
  const hits = (score > c1) + (score > c2);
  return hits === 2 ? 'strong' : hits === 1 ? 'weak' : 'miss';
}

// Action roll. momentum is the hero's current momentum (for cancel and burn).
export function actionRoll({ stat = 0, adds = 0, momentum = 0, dice } = {}) {
  const d = dice || { a: rnd(6), c1: rnd(10), c2: rnd(10) };
  const cancelled = momentum < 0 && -momentum === d.a;
  const aVal = cancelled ? 0 : d.a;
  const score = Math.min(10, aVal + stat + adds);
  const res = { kind: 'action', ...d, stat, adds, cancelled, score, result: outcome(score, d.c1, d.c2), match: d.c1 === d.c2 };
  // Burning momentum replaces the action score with momentum.
  if (momentum > 0 && momentum > score) {
    const burnResult = outcome(momentum, d.c1, d.c2);
    if (burnResult !== res.result) res.burn = { score: momentum, result: burnResult };
  }
  return res;
}

export function progressRoll({ ticks, dice } = {}) {
  const d = dice || { c1: rnd(10), c2: rnd(10) };
  const score = boxes(ticks);
  return { kind: 'progress', ...d, score, result: outcome(score, d.c1, d.c2), match: d.c1 === d.c2 };
}

export const RESULT_LABEL = { strong: 'Strong hit', weak: 'Weak hit', miss: 'Miss' };

export const ODDS = [
  ['Almost certain', 90], ['Likely', 75], ['50/50', 50], ['Unlikely', 25], ['Small chance', 10],
];
export function askOracle(chance) {
  const r = rnd(100);
  return { kind: 'yesno', roll: r, chance, yes: r <= chance, match: r % 11 === 0 };
}

// Oracle rolling. Rows are [min, max, text]; text starting with '@' points at another table.
export function rollOracle(table, byId, depth = 0) {
  let roll;
  if (table.dice === '2d10') roll = rnd(10) + rnd(10);
  else roll = rnd(100);
  const row = table.rows.find(r => roll >= r[0] && roll <= r[1]);
  let text = row ? row[2] : '?';
  const chain = [{ table: table.name, roll }];
  if (text.startsWith('@') && depth < 4) {
    const next = byId[text.slice(1)];
    if (next) {
      const sub = rollOracle(next, byId, depth + 1);
      return { text: sub.text, chain: chain.concat(sub.chain) };
    }
  }
  return { text, chain };
}
