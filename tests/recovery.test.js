import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predict } from '../src/predict.js';
import { PRIORITIES } from '../src/planner.js';
import { assessDay, activeRecovery, relaxPolicy, RELAXED_AT, REASONS } from '../src/recovery.js';
import { cleanSettings, cleanSettingsPatch, cleanFlags } from '../src/settings.js';
import { learnRhythm } from '../src/learn.js';
import { createStore } from '../src/store.js';
import { MIN, HOUR } from '../src/time.js';
import { at, generateRhythm } from './helpers.js';

const TODAY = at(2026, 10, 10);
const BABY = { name: 'Test', birth: at(2026, 7, 30) }; // 13 weeks
const D = (h, m = 0) => at(2026, 10, 10, h, m);
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
const sleep = (start, end, kind = 'nap', flags) => ({ id: `${start}`, start, end, kind, notes: '', ...(flags ? { flags } : {}) });
const ongoing = (start, kind = 'nap', flags) => ({ id: `o${start}`, start, end: null, kind, notes: '', ...(flags ? { flags } : {}) });
const night = sleep(D(7) - 9 * HOUR, D(7), 'night');
const hist = () => generateRhythm({ endDay: TODAY, days: 14, seed: 11, window: () => 65, napLen: () => 35 });
const bedOf = (items) => items.find((i) => i.kind === 'bedtime');
const napsIn = (items) => items.filter((i) => i.kind === 'nap');

// A day of ordinary 45-minute naps, and a rough one: an interrupted nap, a short one, a hard transfer.
const ordinary = () => [sleep(D(8, 15), D(9, 0)), sleep(D(10, 20), D(11, 5)), sleep(D(12, 25), D(13, 10)), sleep(D(14, 20), D(15, 5))];
const rough = () => [
  sleep(D(8, 40), D(8, 55), 'nap', { cut: true }),
  sleep(D(11, 0), D(11, 20)),
  sleep(D(13, 30), D(14, 10), 'nap', { settle: 2 }),
];

/* ------------------------------------------------------------------ */
/* Settings and flags                                                  */
/* ------------------------------------------------------------------ */

test('rough-day mode and the settle/cut notes are validated, and old settings stay valid', () => {
  assert.equal(cleanSettings({ bedtime: '21:00' }).recovery, null, 'settings from before rough-day mode have it off');
  assert.deepEqual(cleanSettingsPatch({ recovery: { since: D(8), reasons: ['vaccine', 'vaccine', 'nonsense', 'appointment'] } }).recovery, {
    since: D(8),
    reasons: ['vaccine', 'appointment'],
  });
  assert.equal(cleanSettingsPatch({ recovery: { since: 'now', reasons: [] } }).recovery, null);
  assert.equal(cleanSettingsPatch({ recovery: { reasons: ['vaccine'] } }).recovery, null);
  assert.equal(cleanSettingsPatch({ recovery: null }).recovery, null);
  assert.ok(!('recovery' in cleanSettingsPatch({ bedtime: '21:00' })), 'an absent key stays absent');

  assert.deepEqual(cleanFlags({ settle: 2, cut: true, early: true, planned: 5 }), { early: true, planned: 5, settle: 2, cut: true });
  assert.equal(cleanFlags({ settle: 7, cut: 'yes' }), undefined);
  assert.deepEqual(cleanFlags({ settle: 1 }), { settle: 1 });
});

/* ------------------------------------------------------------------ */
/* How strained the day has been                                       */
/* ------------------------------------------------------------------ */

test('an ordinary day is not strained, and one short nap alone is not a rough day', () => {
  const calm = assessDay({ sleeps: [...hist(), night, ...ordinary()], now: D(16, 0) });
  assert.equal(calm.level, 0);
  assert.equal(calm.relaxed, false);
  const oneShort = assessDay({ sleeps: [...hist(), night, sleep(D(9, 0), D(9, 15)), sleep(D(10, 40), D(11, 25))], now: D(12, 0) });
  assert.ok(oneShort.level > 0.2 && oneShort.level < RELAXED_AT, `${oneShort.level}`);
  assert.equal(oneShort.relaxed, false);
  assert.deepEqual(oneShort.signals, ['1 short nap']);
});

test('short naps, interrupted naps and trouble settling add up to a rough day', () => {
  const twoShort = assessDay({ sleeps: [night, sleep(D(9, 0), D(9, 15)), sleep(D(10, 30), D(10, 50))], now: D(12, 0) });
  assert.equal(twoShort.relaxed, true, 'two short naps');
  const interrupted = assessDay({ sleeps: [night, sleep(D(9, 0), D(9, 15), 'nap', { cut: true })], now: D(12, 0) });
  assert.equal(interrupted.relaxed, true, 'a nap that was cut short, and was short');
  const nearlyFull = assessDay({ sleeps: [night, sleep(D(9, 0), D(9, 42), 'nap', { cut: true })], now: D(12, 0) });
  assert.ok(nearlyFull.level > 0.3 && !nearlyFull.relaxed, 'an interrupted nap that still got most of its length is only a nudge');
  const failedTransfers = assessDay({ sleeps: [night, sleep(D(9, 0), D(10, 0), 'nap', { settle: 2 }), sleep(D(11, 30), D(11, 50))], now: D(13, 0) });
  assert.equal(failedTransfers.relaxed, true, 'failed transfers plus a short nap');
  const slow = assessDay({ sleeps: [night, sleep(D(9, 0), D(10, 0), 'nap', { settle: 1 })], now: D(12, 0) });
  assert.ok(slow.level > 0 && !slow.relaxed, 'a slow settle by itself is only a nudge');
  const full = assessDay({ sleeps: [...hist(), night, ...rough()], now: D(15, 0) });
  assert.equal(full.relaxed, true);
  assert.match(full.signals.join(', '), /short nap.*interrupted nap.*failed transfers/);
});

test('a baby whose naps are always short is not called strained for it', () => {
  const day = [night, sleep(D(9, 0), D(9, 22)), sleep(D(10, 40), D(11, 2)), sleep(D(12, 20), D(12, 42))];
  assert.equal(assessDay({ sleeps: day, now: D(14) }).relaxed, true, 'by the general curve, three 22-minute naps are short');
  const hers = assessDay({ sleeps: day, typicalNap: () => 24, now: D(14) });
  assert.equal(hers.level, 0, 'but 22 minutes is a normal nap for her');
  const short = assessDay({ sleeps: [night, sleep(D(9, 0), D(9, 12)), sleep(D(10, 40), D(10, 52)), sleep(D(12, 20), D(12, 32))], typicalNap: () => 24, now: D(14) });
  assert.equal(short.relaxed, true, 'three 12-minute naps are short even for her');
});

test('a nap that is still going counts for how she settled but not for how short it is', () => {
  const s = assessDay({ sleeps: [night, ongoing(D(9, 0), 'nap', { settle: 2 })], now: D(9, 5) });
  assert.ok(Math.abs(s.level - 0.45) < 1e-9, `${s.level}`);
  assert.equal(assessDay({ sleeps: [night, ongoing(D(9, 0))], now: D(9, 5) }).level, 0, 'five minutes in is not a short nap yet');
});

test('rough-day mode lasts until she wakes for the day after the night, and not past 36 hours', () => {
  const recovery = { since: D(10), reasons: ['vaccine'] };
  const sleeps = [night, sleep(D(11), D(11, 40))];
  assert.ok(activeRecovery(recovery, sleeps, D(14)));
  // A night is often several chunks: waking at 12:30 AM must not end it.
  const chunks = [...sleeps, sleep(D(20, 30), at(2026, 10, 11, 0, 30), 'night'), sleep(at(2026, 10, 11, 1, 0), at(2026, 10, 11, 4, 0), 'night')];
  assert.ok(activeRecovery(recovery, chunks, at(2026, 10, 11, 4, 10)), 'still on in the small hours');
  const morning = [...chunks, sleep(at(2026, 10, 11, 4, 20), at(2026, 10, 11, 7, 15), 'night')];
  assert.equal(activeRecovery(recovery, morning, at(2026, 10, 11, 7, 20)), null, 'off once she is up for the day');
  assert.equal(activeRecovery(recovery, sleeps, D(10) + 37 * HOUR), null, 'a stale switch does not linger');
  assert.equal(activeRecovery(null, sleeps, D(14)), null);
  const s = assessDay({ sleeps, settings: { recovery }, now: D(14) });
  assert.equal(s.level, 1);
  assert.equal(s.manual, true);
  assert.deepEqual(s.manualReasons, ['vaccine']);
});

test('overnight, the day just ended is what is judged', () => {
  const day = [...ordinary().slice(0, 1), sleep(D(10, 0), D(10, 15)), sleep(D(12, 0), D(12, 20))];
  const sleeps = [night, ...day, ongoing(D(20, 30), 'night')];
  const s = assessDay({ sleeps, now: at(2026, 10, 11, 2, 0) });
  assert.equal(s.relaxed, true, 'two short naps yesterday');
});

test('relaxing the policy: bedtime may move more, wake-by prompts stop, and it never gets stricter', () => {
  const protect = PRIORITIES.protect;
  assert.equal(relaxPolicy(protect, { level: 0.1, relaxed: false }), protect, 'an ordinary day changes nothing');
  const mild = relaxPolicy(protect, { level: 0.5, relaxed: false });
  assert.equal(mild.wakeBy, true);
  assert.ok(mild.slack > protect.slack && mild.slack < 90);
  const rough = relaxPolicy(protect, { level: 1, relaxed: true });
  assert.equal(rough.wakeBy, false);
  assert.equal(rough.slack, 90);
  assert.ok(rough.windowBias < 1 && rough.napBias > 1);
  // Priorities that already allow more keep what they have.
  const sleepFirst = relaxPolicy(PRIORITIES.cues, { level: 1, relaxed: true });
  assert.ok(sleepFirst.slack >= PRIORITIES.cues.slack - 1e-9);
  assert.ok(sleepFirst.flexW <= PRIORITIES.cues.flexW);
});

test('a nap that was cut short is not taken as her natural nap length', () => {
  const base = generateRhythm({ endDay: TODAY, days: 10, seed: 3, window: () => 65, napLen: () => 50 });
  const spoiled = base.map((s, i) => (s.kind === 'nap' && i % 2 === 0 ? { ...s, end: s.start + 12 * MIN, flags: { cut: true } } : s));
  const plain = spoiled.map((s) => ({ ...s, flags: undefined }));
  const at11 = (sleeps) => learnRhythm(sleeps, { now: D(11) }).napLenAt(11)?.minutes;
  assert.ok(at11(spoiled) > at11(plain) + 8, `${at11(spoiled)} vs ${at11(plain)}`);
});

/* ------------------------------------------------------------------ */
/* What it changes: the plan                                           */
/* ------------------------------------------------------------------ */

test('the reported day: a 4:30 PM wake-up to protect a 9 PM bedtime, after a rough day, is not asked of the parent', () => {
  const settings = { bedtime: '21:00', priority: 'protect' };
  const start = D(16, 0);
  const sleeps = [...hist(), night, ...rough(), ongoing(start, 'nap', { settle: 2 })];
  const p = predict({ sleeps, baby: BABY, settings, now: D(16, 20) });
  assert.equal(p.mode, 'asleep');
  assert.equal(p.strain.relaxed, true);
  assert.equal(p.wakeBy, null);
  assert.ok(p.notes.some((n) => /Let her sleep/.test(n)), p.notes.join(' / '));
  assert.ok(!p.notes.some((n) => /wake her by|Wake by/i.test(n)));
  assert.ok(p.expectedWake >= start + 30 * MIN, 'the nap is not cut off in the plan');
  assert.ok(bedOf(p.after).at > D(19, 30) && bedOf(p.after).at < D(22, 30), clock(bedOf(p.after).at));

  // The same moment on an ordinary day: no prompt either, because the evening can absorb it.
  const calm = predict({ sleeps: [...hist(), night, ...ordinary(), ongoing(start)], baby: BABY, settings, now: D(16, 20) });
  assert.equal(calm.strain.relaxed, false);
  assert.equal(calm.wakeBy, null);
});

test('switching rough-day mode on stops the wake-by prompt even when nothing in the log looks rough', () => {
  const sleeps = [...hist(), night, ...ordinary().slice(0, 2), ongoing(D(18, 30))];
  const settings = { bedtime: '21:00' };
  const normal = predict({ sleeps, baby: BABY, settings, now: D(20, 30) });
  assert.ok(normal.wakeBy != null, 'a nap this long on an ordinary day does push bedtime, and the family is told');
  assert.match(normal.notes[0], /If she sleeps on, bedtime lands about .*To hold 9:00 PM, wake her by/);
  const marked = predict({ sleeps, baby: BABY, settings: { ...settings, recovery: { since: D(9), reasons: ['appointment', 'vaccine'] } }, now: D(20, 30) });
  assert.equal(marked.strain.manual, true);
  assert.equal(marked.wakeBy, null);
  assert.ok(marked.notes.some((n) => /Let her sleep/.test(n)));
  assert.ok(bedOf(marked.after).at > D(21, 15), 'bedtime moves instead');
});

test('after waking on a rough day: the plan is flexible, says why, and still has no nap limit', () => {
  const wake = D(16, 10);
  const sleeps = [...hist(), night, ...rough(), sleep(D(15, 20), wake)];
  const settings = { bedtime: '21:00' };
  const p = predict({ sleeps, baby: BABY, settings, now: wake + 5 * MIN });
  assert.equal(p.mode, 'awake');
  assert.equal(p.strain.relaxed, true);
  assert.ok(p.reasons.some((r) => /Today has been rough \(.*short nap.*interrupted nap.*failed transfers/.test(r)), p.reasons.join('\n'));
  assert.equal(p.napsSoFar, 4, 'counted for information only');
  assert.equal(p.next.kind, 'nap', 'a fifth nap is offered');

  const calm = predict({ sleeps: [...hist(), night, ...ordinary(), sleep(D(15, 20), wake)], baby: BABY, settings, now: wake + 5 * MIN });
  assert.ok(!calm.reasons.some((r) => /rough/i.test(r)));
  assert.ok(p.next.window < calm.next.window, `windows are a little shorter on a rough day: ${p.next.window.toFixed(0)} vs ${calm.next.window.toFixed(0)}`);
});

test('manual rough-day mode lists its reasons in the explanation', () => {
  const wake = D(11, 0);
  const sleeps = [...hist(), night, sleep(D(10, 15), wake)];
  const p = predict({ sleeps, baby: BABY, settings: { recovery: { since: D(8), reasons: ['vaccine', 'illness'] } }, now: wake + 5 * MIN });
  assert.ok(p.reasons.some((r) => /Rough-day mode is on \(vaccination or shots, not feeling well\)/.test(r)), p.reasons.join('\n'));
});

test('a rough night with the wake-time target: she can sleep past the range without being woken', () => {
  const settings = { bedtime: '20:30', wake: { time: '08:00', range: 30 }, recovery: { since: D(9), reasons: ['vaccine'] } };
  const start = D(20, 30);
  const asleep = [...hist(), night, sleep(D(9, 0), D(9, 40)), ongoing(start, 'night')];
  const late = predict({ sleeps: asleep, baby: BABY, settings, now: at(2026, 10, 11, 8, 50) });
  assert.equal(late.mode, 'asleep');
  assert.equal(late.pastTarget, false);
  assert.equal(late.wakeBy, null);
  assert.match(late.notes[0], /Let her sleep in if she needs it/);
  const normal = predict({ sleeps: asleep, baby: BABY, settings: { ...settings, recovery: null }, now: at(2026, 10, 11, 8, 50) });
  assert.equal(normal.pastTarget, true);
  assert.match(normal.notes[0], /Past the .*target/);
});

/* ------------------------------------------------------------------ */
/* Stored and synced                                                   */
/* ------------------------------------------------------------------ */

const memoryStorage = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
};

test('rough-day mode and the settle/cut notes are saved, synced, and survive an older phone', () => {
  const t = { now: D(9) };
  const store = createStore(memoryStorage(), { clock: () => t.now });
  store.setBaby({ name: 'Mia', birth: BABY.birth });
  store.setSettings({ recovery: { since: D(9), reasons: ['vaccine', 'bogus'] } });
  assert.deepEqual(store.state.settings.recovery, { since: D(9), reasons: ['vaccine'] });
  assert.deepEqual(store.pendingSnapshot().profile.settings.recovery, { since: D(9), reasons: ['vaccine'] });

  const s = store.startSleep('nap', D(9, 30));
  t.now = D(10, 10);
  store.endSleep(t.now);
  store.updateSleep(s.id, { flags: { settle: 2, cut: true } });
  assert.deepEqual(store.state.sleeps[0].flags, { settle: 2, cut: true });
  assert.deepEqual(store.pendingSnapshot().sleeps.find((x) => x.id === s.id).flags, { settle: 2, cut: true });
  store.updateSleep(s.id, { flags: null });
  assert.equal(store.state.sleeps[0].flags, undefined, 'clearing the notes clears them');

  // A profile from a phone that predates rough-day mode leaves it alone; an explicit clear turns it off.
  store.ackPending(store.pendingSnapshot());
  const stamp = store.state.profileAt;
  store.applyRemote({ profile: { baby: { name: 'Mia', birth: BABY.birth }, settings: { bedtime: '21:00' }, updatedAt: stamp + 10 } });
  assert.deepEqual(store.state.settings.recovery, { since: D(9), reasons: ['vaccine'] });
  store.applyRemote({ profile: { baby: { name: 'Mia', birth: BABY.birth }, settings: { recovery: null }, updatedAt: stamp + 20 } });
  assert.equal(store.state.settings.recovery, null);
});

test('every reason has a label and a key, and none repeats', () => {
  assert.equal(new Set(REASONS.map((r) => r.key)).size, REASONS.length);
  assert.ok(REASONS.every((r) => r.label.length > 3));
});
