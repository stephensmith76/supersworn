// One-tap results. For each move and outcome, the things a player would
// normally do next, as buttons. Nothing is applied automatically: the player
// taps what they choose. A group with `choose: n` lets them pick n options.
//
// Effect types:
//   mom n | health n | spirit n | res n | heat n   change a meter
//   suffer n          shows -n momentum / health / spirit / resources
//   progress n type   mark progress n times on an open track of that type
//   pos v             set position on a combat track ('control' | 'bad')
//   clock n           fill n segments on a tension clock
//   nextAdd           +1 on the next action roll
//   oracle id         roll an oracle
//   ptp               roll Pay the Price
//   nemesis           advance a Nemesis scheme clock
//   escape            Nemesis escape check
//   plot              Uncover a Plot (roll Plot, +2 Heroics ticks)
//   legacy l rank d   legacy reward for the rolled track's rank (d = ranks lower)
//   heroicsScene      scene challenge Heroics reward
//   milestone         Reach a Milestone on a vow
//   done              mark the rolled track done
//   setback           clear boxes equal to the lower challenge die and raise rank
//   newTrack type     add a track of that type
//   note text         a reminder line, no button

const mom = n => ({ t: 'mom', n });
const suffer = n => ({ t: 'suffer', n });
const progress = (n, type) => ({ t: 'progress', n, type });
const pos = v => ({ t: 'pos', v });
const note = text => ({ t: 'note', text });
const one = (...options) => ({ choose: 1, options });
const ptp = { t: 'ptp' };
const nextAdd = { t: 'nextAdd' };
const done = { t: 'done' };
const setback = { t: 'setback' };

export const MOVE_EFFECTS = {
  'sf/face_danger': { strong: [mom(1)], weak: [suffer(1)], miss: [ptp] },
  'sf/secure_an_advantage': { strong: [mom(2), nextAdd], weak: [one(mom(2), nextAdd)], miss: [ptp] },
  'sf/gather_information': { strong: [mom(2)], weak: [mom(1)], miss: [ptp] },
  'sf/compel': { strong: [mom(1)], weak: [note('They agree, but with a demand or complication. Envision the counteroffer.')], miss: [ptp, { t: 'heat', n: 1 }] },
  'sf/enter_the_fray': {
    strong: [mom(2), pos('control'), { t: 'newTrack', type: 'combat' }],
    weak: [one(mom(2), pos('control')), { t: 'newTrack', type: 'combat' }],
    miss: [pos('bad'), { t: 'newTrack', type: 'combat' }],
  },
  'sf/gain_ground': {
    strong: [{ choose: 2, options: [progress(1, 'combat'), mom(2), nextAdd] }],
    weak: [one(progress(1, 'combat'), mom(2), nextAdd)],
    miss: [pos('bad'), ptp],
  },
  'sf/react_under_fire': { strong: [pos('control'), mom(1)], weak: [suffer(1)], miss: [ptp] },
  'sf/strike': { strong: [progress(2, 'combat')], weak: [progress(2, 'combat'), pos('bad')], miss: [pos('bad'), ptp] },
  'sf/clash': { strong: [progress(2, 'combat'), pos('control')], weak: [progress(1, 'combat'), ptp], miss: [ptp] },
  'sf/endure_harm': { strong: [one({ t: 'health', n: 1 }, mom(1))], weak: [note('If not wounded, you may trade 1 momentum for 1 health.'), { t: 'tradeMomFor', meter: 'health' }], miss: [one({ t: 'health', n: -1 }, mom(-2))] },
  'sf/endure_stress': { strong: [one({ t: 'spirit', n: 1 }, mom(1))], weak: [note('If not shaken, you may trade 1 momentum for 1 spirit.'), { t: 'tradeMomFor', meter: 'spirit' }], miss: [one({ t: 'spirit', n: -1 }, mom(-2))] },
  'sf/heal': { strong: [{ t: 'health', n: 3 }], weak: [{ t: 'health', n: 3 }, one(mom(-2), { t: 'res', n: -2 })], miss: [ptp] },
  'sf/hearten': { strong: [{ t: 'spirit', n: 2 }], weak: [{ t: 'spirit', n: 2 }, mom(-1)], miss: [ptp] },
  'sf/resupply': { strong: [one({ t: 'res', n: 2 }, mom(1))], weak: [note('First deal with a cost, complication or demand.'), one({ t: 'res', n: 2 }, mom(1))], miss: [ptp] },
  'sf/swear_an_iron_vow': { strong: [mom(2), { t: 'newTrack', type: 'vow' }], weak: [mom(1), { t: 'newTrack', type: 'vow' }], miss: [note('Envision the obstacle you must overcome first.'), { t: 'newTrack', type: 'vow' }] },
  'sf/scene_challenge/face_danger': {
    strong: [progress(1, 'scene challenge')], strongMatch: [progress(2, 'scene challenge')],
    weak: [progress(1, 'scene challenge'), { t: 'clock', n: 1 }],
    miss: [{ t: 'clock', n: 1 }, ptp], missMatch: [{ t: 'clock', n: 2 }, ptp],
  },
  'sf/scene_challenge/secure_an_advantage': {
    strong: [mom(2), nextAdd], strongMatch: [mom(2), nextAdd, progress(1, 'scene challenge')],
    weak: [one(mom(2), nextAdd)],
    miss: [{ t: 'clock', n: 1 }, ptp], missMatch: [{ t: 'clock', n: 2 }, ptp],
  },
  'ss/go_on_patrol': {
    strong: [progress(1, 'patrol'), { t: 'oracle', id: 'ss/trouble' }],
    strongMatch: [progress(1, 'patrol'), { t: 'oracle', id: 'ss/trouble' }, { t: 'plot' }, { t: 'nemesis' }, { t: 'escape' }],
    weak: [progress(1, 'patrol'), { t: 'oracle', id: 'ss/trouble' }, one(suffer(2), { t: 'nemesis' }, { t: 'heat', n: 1 })],
    weakMatch: [progress(1, 'patrol'), { t: 'oracle', id: 'ss/trouble' }, one(suffer(2), { t: 'nemesis' }, { t: 'heat', n: 1 }), { t: 'nemesis' }, { t: 'escape' }],
    miss: [ptp],
    missMatch: [ptp, { t: 'oracle', id: 'ss/all_hell' }, { t: 'nemesis' }, { t: 'escape' }],
  },
  'ss/work_the_case': {
    strong: [progress(1, 'case'), { t: 'oracle', id: 'ss/clue' }],
    weak: [progress(1, 'case'), { t: 'oracle', id: 'ss/clue' }, one(suffer(1), { t: 'heat', n: 1 }, { t: 'nemesis' })],
    miss: [ptp],
    missMatch: [ptp, note('False lead: next time you Solve the Case, roll one challenge die twice and use the higher.'), { t: 'nemesis' }],
  },
};
// Gather Information with a match also ticks a scheme clock.
MOVE_EFFECTS['sf/gather_information'].strongMatch = [mom(2), { t: 'nemesis' }];
MOVE_EFFECTS['sf/gather_information'].weakMatch = [mom(1), { t: 'nemesis' }];
MOVE_EFFECTS['sf/gather_information'].missMatch = [ptp, { t: 'nemesis' }];
MOVE_EFFECTS['ss/work_the_case'].strongMatch = [...MOVE_EFFECTS['ss/work_the_case'].strong, { t: 'nemesis' }];
MOVE_EFFECTS['ss/work_the_case'].weakMatch = [...MOVE_EFFECTS['ss/work_the_case'].weak, { t: 'nemesis' }];

// Progress rolls: the move depends on the track type.
export const TRACK_EFFECTS = {
  combat: { name: 'Take Decisive Action', strong: [mom(1), done], weak: [{ t: 'oracle', id: 'sf/moves/take_decisive_action' }, done], miss: [ptp, done] },
  patrol: {
    name: 'Finish Patrol',
    strong: [{ t: 'legacy', l: 'heroics', d: 0 }, { t: 'heat', n: -1 }, done],
    weak: [{ t: 'legacy', l: 'heroics', d: 1 }, done],
    miss: [one({ t: 'abandon' }, setback)],
  },
  case: {
    name: 'Solve the Case',
    strong: [mom(2), { t: 'milestone' }, done, note('The confrontation drops one rank.')],
    weak: [{ t: 'milestone' }, { t: 'nemesis' }, done, note('They know you are coming: advance their scheme or face an ambush.')],
    miss: [one({ t: 'wrongPerson' }, setback)],
  },
  vow: {
    name: 'Fulfill Your Vow',
    strong: [{ t: 'legacy', l: 'quests', d: 0 }, done],
    weak: [note('Full reward if you swear a new vow to set things right, otherwise one rank lower.'), one({ t: 'legacy', l: 'quests', d: 0 }, { t: 'legacy', l: 'quests', d: 1 }), done],
    miss: [one(setback, { t: 'forsake' })],
  },
  connection: {
    name: 'Forge a Bond',
    strong: [{ t: 'legacy', l: 'bonds', d: 0 }, done],
    weak: [note('They ask something more of you first.'), { t: 'legacy', l: 'bonds', d: 0 }, done],
    miss: [note('They reveal a motive or bias that complicates things. Recommit or give up on the bond.'), setback],
  },
  'scene challenge': { name: 'Finish the Scene', strong: [{ t: 'heroicsScene' }, done], weak: [ptp, { t: 'heroicsScene' }, done], miss: [ptp, done] },
};

export function effectsFor(roll, track) {
  const spec = roll.kind === 'action' ? MOVE_EFFECTS[roll.moveId] : track && TRACK_EFFECTS[track.type];
  if (!spec) return null;
  const res = roll.burned ? roll.burn.result : roll.result;
  const list = (roll.match && spec[res + 'Match']) || spec[res] || [];
  return { name: spec.name, list };
}
