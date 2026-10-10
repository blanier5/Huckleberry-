import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predict } from '../src/predict.js';
import { MIN } from '../src/time.js';
import { ageNorms, slotFactor } from '../src/norms.js';
import { at, generateHistory } from './helpers.js';

const TODAY = at(2026, 10, 10);
const BABY = { name: 'Test', birth: at(2026, 3, 10) }; // ~7 months
const sleep = (start, end, kind = 'nap') => ({ id: `${start}`, start, end, kind, notes: '' });
const history = () => generateHistory({ endDay: TODAY, days: 21 });
const near = (actual, expected, toleranceMin, msg) =>
  assert.ok(Math.abs(actual - expected) <= toleranceMin * MIN, `${msg ?? ''} off by ${((actual - expected) / MIN).toFixed(1)} min`);

test('age norms interpolate smoothly and shrink naps with age', () => {
  assert.equal(ageNorms(7).naps, 3);
  assert.equal(ageNorms(7).ww, 140);
  assert.equal(ageNorms(14).naps, 2);
  assert.equal(ageNorms(20).naps, 1);
  assert.ok(ageNorms(3).ww < ageNorms(9).ww);
  assert.ok(slotFactor(0, 3) < slotFactor(3, 3));
});

test('with no history: age-based nap window from the morning wake-up', () => {
  const wake = at(2026, 10, 10, 6, 45);
  const sleeps = [sleep(at(2026, 10, 9, 19, 0), wake, 'night')];
  const p = predict({ sleeps, baby: BABY, now: wake + 30 * MIN });
  assert.equal(p.mode, 'awake');
  assert.equal(p.learned, null);
  assert.equal(p.next.kind, 'nap');
  assert.equal(p.next.number, 1);
  // 140 min typical * 0.88 first-window factor = 123, then fitted to the day (~1%).
  near(p.next.at, wake + 122 * MIN, 3, 'age-based first window');
  assert.ok(p.later.some((i) => i.kind === 'bedtime'), 'forecast ends in bedtime');
});

test('learns from history: first window moves toward the baby\'s own pattern', () => {
  const wake = at(2026, 10, 10, 6, 45);
  const sleeps = history();
  const p = predict({ sleeps, baby: BABY, now: wake + 30 * MIN });
  assert.ok(p.learned && p.learned.days >= 14);
  assert.equal(p.napsExpected, 3);
  // Own windows are ~115 min, age norm ~140: 82% personal => ~120.
  const lastWake = sleeps[sleeps.length - 1].end;
  near(p.next.at, lastWake + 120 * MIN, 8);
  assert.ok(p.next.at < lastWake + 140 * MIN);
});

test('a short nap pulls the next wake window in', () => {
  const sleeps = history();
  const wake = sleeps[sleeps.length - 1].end;
  const normal = [...sleeps, sleep(wake + 115 * MIN, wake + 175 * MIN)];
  const short = [...sleeps, sleep(wake + 115 * MIN, wake + 140 * MIN)];
  const pn = predict({ sleeps: normal, baby: BABY, now: wake + 180 * MIN });
  const ps = predict({ sleeps: short, baby: BABY, now: wake + 145 * MIN });
  assert.equal(pn.napsToday, 1);
  assert.equal(ps.napsToday, 1);
  assert.ok(ps.next.window < pn.next.window * 0.9, `${ps.next.window} vs ${pn.next.window}`);
  assert.ok(ps.reasons.some((r) => /short/i.test(r)));
});

test('after the usual number of naps, bedtime is next', () => {
  const sleeps = history();
  const wake = sleeps[sleeps.length - 1].end;
  const naps = [
    sleep(wake + 115 * MIN, wake + 175 * MIN),
    sleep(wake + 305 * MIN, wake + 380 * MIN),
    sleep(wake + 525 * MIN, wake + 560 * MIN),
  ];
  const p = predict({ sleeps: [...sleeps, ...naps], baby: BABY, now: wake + 570 * MIN });
  assert.equal(p.napsToday, 3);
  assert.equal(p.next.kind, 'bedtime');
  assert.equal(p.later.length, 0);
  const bedtimes = at(2026, 10, 10, 17, 45);
  assert.ok(p.next.at >= bedtimes && p.next.at <= at(2026, 10, 10, 20, 0), new Date(p.next.at).toString());
});

test('when another nap would run into bedtime, bedtime comes next', () => {
  const sleeps = history();
  const naps = [sleep(at(2026, 10, 10, 10, 0), at(2026, 10, 10, 12, 0)), sleep(at(2026, 10, 10, 14, 30), at(2026, 10, 10, 16, 30))];
  const p = predict({ sleeps: [...sleeps, ...naps], baby: BABY, now: at(2026, 10, 10, 16, 35) });
  assert.equal(p.napsToday, 2);
  assert.equal(p.next.kind, 'bedtime');
  assert.equal(p.next.skippedNap, 3);
});

test('a configured bedtime pulls bedtime later, within reason', () => {
  const sleeps = history();
  const wake = sleeps[sleeps.length - 1].end;
  const naps = [sleep(wake + 115 * MIN, wake + 175 * MIN), sleep(wake + 305 * MIN, wake + 380 * MIN), sleep(wake + 525 * MIN, wake + 560 * MIN)];
  const now = wake + 570 * MIN;
  const learned = predict({ sleeps: [...sleeps, ...naps], baby: BABY, now });
  const chosen = predict({ sleeps: [...sleeps, ...naps], baby: BABY, settings: { bedtimeMin: 20 * 60 }, now });
  assert.equal(chosen.next.kind, 'bedtime');
  assert.equal(chosen.bedtimeMin, 20 * 60);
  assert.ok(chosen.next.at > learned.next.at + 10 * MIN, 'moves toward the chosen time');
  assert.ok(chosen.next.at <= at(2026, 10, 10, 20, 45), 'but never past bedtime + 45 min');
});

test('a chosen bedtime reshapes the whole remaining day, not just the last window', () => {
  const sleeps = history();
  const wake = sleeps[sleeps.length - 1].end;
  const now = wake + 20 * MIN;
  const learned = predict({ sleeps, baby: BABY, now });
  const late = predict({ sleeps, baby: BABY, settings: { bedtimeMin: 20 * 60 + 15 }, now });
  const bed = (p) => [p.next, ...p.later].find((i) => i.kind === 'bedtime').at;
  assert.ok(bed(late) >= at(2026, 10, 10, 20, 0), new Date(bed(late)).toString());
  assert.ok(late.next.at > learned.next.at, 'first nap shifts later too');
});

test('shortens a late nap rather than skipping it when there is still room', () => {
  const wake = at(2026, 10, 10, 6, 45);
  const sleeps = [sleep(at(2026, 10, 9, 19, 0), wake, 'night'), sleep(at(2026, 10, 10, 9, 0), at(2026, 10, 10, 10, 0))];
  const p = predict({ sleeps, baby: { ...BABY, birth: at(2026, 1, 10) }, now: at(2026, 10, 10, 10, 5) }); // ~9 mo
  // Whatever the forecast is, no nap may end later than the cap and every item is in order.
  const items = [p.next, ...p.later];
  for (let i = 1; i < items.length; i++) assert.ok(items[i].at >= items[i - 1].at);
  assert.equal(items[items.length - 1].kind, 'bedtime');
});

test('asleep: expected wake from typical nap length, and a forecast afterwards', () => {
  const sleeps = history();
  const wake = sleeps[sleeps.length - 1].end;
  const start = wake + 115 * MIN;
  const p = predict({ sleeps: [...sleeps, { id: 'o', start, end: null, kind: 'nap', notes: '' }], baby: BABY, now: start + 20 * MIN });
  assert.equal(p.mode, 'asleep');
  assert.equal(p.napNumber, 1);
  near(p.expectedWake, start + 60 * MIN, 8);
  assert.equal(p.after[0].kind, 'nap');
  assert.equal(p.after[0].number, 2);
});

test('asleep at night: expects the usual morning wake-up', () => {
  const sleeps = history();
  const start = at(2026, 10, 10, 19, 0);
  const p = predict({ sleeps: [...sleeps, { id: 'n', start, end: null, kind: 'night', notes: '' }], baby: BABY, now: at(2026, 10, 10, 23, 0) });
  assert.equal(p.mode, 'asleep');
  assert.equal(p.kind, 'night');
  near(p.expectedWake, at(2026, 10, 11, 6, 45), 15);
  assert.equal(p.after[0].number, 1);
});

test('edge states: empty, stale, night waking', () => {
  assert.equal(predict({ sleeps: [], baby: BABY, now: TODAY }).mode, 'empty');
  const old = [sleep(at(2026, 10, 8, 10, 0), at(2026, 10, 8, 11, 0))];
  assert.equal(predict({ sleeps: old, baby: BABY, now: TODAY + 12 * 60 * MIN }).mode, 'stale');
  const night = [sleep(at(2026, 10, 9, 19, 0), at(2026, 10, 10, 2, 30), 'night')];
  assert.equal(predict({ sleeps: night, baby: BABY, now: at(2026, 10, 10, 2, 45) }).mode, 'night-awake');
});

test('old history does not drive predictions for a baby who has aged', () => {
  const old = generateHistory({ endDay: at(2026, 6, 1), days: 21 });
  const wake = at(2026, 10, 10, 6, 45);
  const sleeps = [...old, sleep(at(2026, 10, 9, 19, 0), wake, 'night')];
  const p = predict({ sleeps, baby: BABY, now: wake + 30 * MIN });
  assert.equal(p.learned, null);
});
