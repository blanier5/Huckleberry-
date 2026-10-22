import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageTarget, bedtimeTarget, wakeTarget, recentBedtime, recentWake, validShift, PACES, TOLERANCE, EASE_AFTER } from '../src/shift.js';
import { MIN } from '../src/time.js';
import { at } from './helpers.js';

const hm = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
const ms = (day, minutes) => at(2026, 10, day, 0, 0) + minutes * MIN;

/**
 * One entry per day: [dayOfOctober, wake 'HH:MM', bed 'HH:MM']. Each day has a midday nap; the
 * night runs from that bedtime to the next entry's wake (or 9 hours for the last one).
 */
function log(entries) {
  const sleeps = [];
  const first = entries[0];
  sleeps.push({ start: ms(first[0], hm(first[1])) - 9 * 60 * MIN, end: ms(first[0], hm(first[1])), kind: 'night', notes: '' });
  entries.forEach(([day, wake, bed], i) => {
    sleeps.push({ start: ms(day, hm(wake) + 180), end: ms(day, hm(wake) + 240), kind: 'nap', notes: '' });
    const next = entries[i + 1];
    const nightEnd = next ? ms(next[0], hm(next[1])) : ms(day, hm(bed) + 9 * 60);
    sleeps.push({ start: ms(day, hm(bed)), end: nightEnd, kind: 'night', notes: '' });
  });
  return sleeps;
}
const days = (from, n, wake, bedFor) => Array.from({ length: n }, (_, i) => [from + i, wake, bedFor(i)]);
const settings = (over) => ({ bedtime: '20:30', bedShift: { pace: 'steady', startedAt: ms(1, 0), fromMin: hm('19:30') }, ...over });
const NOW = ms(28, 12 * 60);

test('moving later: the target steps up only after enough nights on target', () => {
  // Bedtime lands exactly on whatever the target is (a baby who keeps up).
  const obs = [];
  let expected = hm('19:30');
  const seen = [];
  for (let night = 0; night < 12; night++) {
    const state = stageTarget({ fromMin: hm('19:30'), goalMin: hm('20:30'), pace: 'steady', obs });
    seen.push(state.targetMin);
    obs.push({ at: night, min: state.targetMin });
    expected = state.targetMin;
  }
  const final = stageTarget({ fromMin: hm('19:30'), goalMin: hm('20:30'), pace: 'steady', obs });
  // 15 minutes every 3 nights: 19:30 x3, 19:45 x3, 20:00 x3, 20:15 x3, then 20:30.
  assert.deepEqual(seen, [0, 0, 0, 15, 15, 15, 30, 30, 30, 45, 45, 45].map((m) => hm('19:30') + m));
  assert.equal(final.targetMin, hm('20:30'));
  assert.equal(final.reached, true);
  assert.equal(final.direction, 'reached');
  assert.ok(expected > 0);
});

test('moving earlier works the same way, and the quicker pace needs only two nights', () => {
  const obs = [];
  const seen = [];
  for (let night = 0; night < 8; night++) {
    const s = stageTarget({ fromMin: hm('21:30'), goalMin: hm('20:30'), pace: 'quick', obs });
    seen.push(s.targetMin);
    obs.push({ at: night, min: s.targetMin });
  }
  assert.deepEqual(seen, [0, 0, -15, -15, -30, -30, -45, -45].map((m) => hm('21:30') + m));
  assert.equal(PACES.quick.step, 15);
  assert.equal(PACES.quick.hold, 2);
  assert.equal(PACES.gentle.step, 10);
});

test('a night off target starts the count over, so the target holds', () => {
  const obs = [
    { at: 1, min: hm('21:30') },
    { at: 2, min: hm('21:30') },
    { at: 3, min: hm('22:10') }, // way off: she fell asleep much later
    { at: 4, min: hm('21:30') },
    { at: 5, min: hm('21:30') },
  ];
  const s = stageTarget({ fromMin: hm('21:30'), goalMin: hm('20:30'), pace: 'steady', obs });
  assert.equal(s.targetMin, hm('21:30'), 'never got three in a row');
  assert.equal(s.hits, 2);
  assert.equal(s.steps, 0);
});

test('if she cannot keep up, the target eases back to within a step of what she is really doing', () => {
  // Target steps down to 21:15 after three good nights, then she keeps going to sleep around 21:50.
  const nights = ['21:30', '21:25', '21:20', '21:50', '21:55', '21:50', '21:55'].map((t, i) => ({ at: i, min: hm(t) }));
  const s = stageTarget({ fromMin: hm('21:30'), goalMin: hm('20:30'), pace: 'steady', obs: nights });
  assert.ok(s.targetMin > hm('21:15'), `eased back from 21:15 to ${s.targetMin / 60}`);
  assert.ok(s.eased);
  assert.ok(s.targetMin <= hm('21:50') - 0, 'but never later than what she is doing');
  assert.equal(EASE_AFTER, 4);
  assert.ok(TOLERANCE > 0);
});

test('already past the target toward the goal counts as on target', () => {
  const obs = [0, 1, 2].map((i) => ({ at: i, min: hm('20:45') })); // goal is earlier, she is much earlier already
  const s = stageTarget({ fromMin: hm('21:30'), goalMin: hm('20:30'), pace: 'steady', obs });
  assert.equal(s.steps, 1);
});

test('the goal is held once reached, and a step never overshoots it', () => {
  const s = stageTarget({ fromMin: hm('20:40'), goalMin: hm('20:30'), pace: 'steady', obs: [0, 1, 2, 3, 4, 5].map((i) => ({ at: i, min: hm('20:35') })) });
  assert.equal(s.targetMin, hm('20:30'));
  assert.equal(s.stepsLeft, 0);
});

test('bedtimeTarget replays real nights from the log, ignoring nights before the shift began', () => {
  // Nights before day 10 are all at 22:00 and must be ignored; after the start she lands on target.
  const entries = [...days(1, 9, '07:30', () => '22:00')];
  let target = hm('19:30');
  const fromDay = 10;
  const startSettings = settings({ bedShift: { pace: 'steady', startedAt: ms(fromDay, 0), fromMin: hm('19:30') } });
  for (let d = fromDay; d < fromDay + 9; d++) {
    entries.push([d, '07:30', '00:00'.replace('00:00', `${String(Math.floor(target / 60)).padStart(2, '0')}:${String(target % 60).padStart(2, '0')}`)]);
    target = bedtimeTarget({ settings: startSettings, sleeps: log(entries), now: ms(d + 1, 6 * 60) }).targetMin;
  }
  const r = bedtimeTarget({ settings: startSettings, sleeps: log(entries), now: NOW });
  assert.equal(r.goalMin, hm('20:30'));
  assert.equal(r.shift.count, 9, 'only the nights since the shift began count');
  assert.equal(r.targetMin, hm('20:15'), `after 9 on-target nights: 3 steps of 15 min`);
  assert.equal(r.shift.stepsLeft, 1);
});

test('bedtimeTarget without a shift is just the chosen time; no bedtime means no target', () => {
  assert.deepEqual(bedtimeTarget({ settings: { bedtime: '20:30' }, sleeps: [], now: NOW }), { goalMin: hm('20:30'), targetMin: hm('20:30'), shift: null });
  assert.equal(bedtimeTarget({ settings: { bedtime: null }, sleeps: [], now: NOW }), null);
  assert.equal(bedtimeTarget({ settings: {}, sleeps: [], now: NOW }), null);
  assert.equal(bedtimeTarget({ settings: { bedtime: '03:00' }, sleeps: [], now: NOW }), null, 'out of range');
  assert.equal(bedtimeTarget({ settings: { bedtime: 'later' }, sleeps: [], now: NOW }), null);
});

test('computing a target never changes the log', () => {
  const sleeps = log(days(1, 12, '07:30', () => '21:00'));
  const before = JSON.stringify(sleeps);
  bedtimeTarget({ settings: settings(), sleeps, now: NOW });
  wakeTarget({ settings: { wake: { time: '08:00', range: 30 }, wakeShift: { pace: 'steady', startedAt: ms(1, 0), fromMin: hm('09:30') } }, sleeps, now: NOW });
  recentBedtime(sleeps, NOW);
  assert.equal(JSON.stringify(sleeps), before);
  // Deterministic.
  assert.deepEqual(bedtimeTarget({ settings: settings(), sleeps, now: NOW }), bedtimeTarget({ settings: settings(), sleeps, now: NOW }));
});

test('wake target: a time with a range, e.g. 8:00 AM +/- 30 minutes is 7:30 to 8:30', () => {
  const w = wakeTarget({ settings: { wake: { time: '08:00', range: 30 } }, sleeps: [], now: NOW });
  assert.equal(w.targetMin, hm('08:00'));
  assert.equal(w.lowMin, hm('07:30'));
  assert.equal(w.highMin, hm('08:30'));
  assert.equal(w.shift, null);
  assert.equal(wakeTarget({ settings: { wake: { time: '08:00' } }, sleeps: [], now: NOW }).range, 30, 'default range');
  assert.equal(wakeTarget({ settings: { wake: { time: '08:00', range: 500 } }, sleeps: [], now: NOW }).range, 90, 'range is capped');
  assert.equal(wakeTarget({ settings: {}, sleeps: [], now: NOW }), null);
  assert.equal(wakeTarget({ settings: { wake: { time: '15:00' } }, sleeps: [], now: NOW }), null);
});

test('wake target works toward the goal gradually, one step after she wakes within range of the current target', () => {
  // She wakes around 9:30 and the goal is 8:00. First three mornings on target (9:30) -> step to 9:15.
  const entries = days(1, 8, '09:30', () => '21:00');
  const s = {
    wake: { time: '08:00', range: 30 },
    wakeShift: { pace: 'steady', startedAt: ms(2, 0), fromMin: hm('09:30') },
  };
  const w = wakeTarget({ settings: s, sleeps: log(entries), now: ms(9, 12 * 60) });
  assert.equal(w.goalMin, hm('08:00'));
  assert.equal(w.targetMin, hm('09:00'), 'two steps: 9:30 -> 9:15 -> 9:00');
  assert.equal(w.lowMin, hm('08:30'));
  assert.equal(w.highMin, hm('09:30'));
  assert.equal(w.shift.direction, 'earlier');
});

test('recent bedtime and wake come from the last week of complete days', () => {
  const sleeps = log(days(1, 10, '07:30', (i) => (i < 5 ? '22:00' : '21:00')));
  assert.equal(recentBedtime(sleeps, NOW), hm('21:00'));
  assert.equal(recentWake(sleeps, NOW), hm('07:30'));
  assert.equal(recentBedtime([], NOW), null);
});

test('shift settings are validated', () => {
  assert.equal(validShift({ pace: 'steady', startedAt: 1, fromMin: 1200 }), true);
  assert.equal(validShift({ pace: 'fast', startedAt: 1, fromMin: 1200 }), false);
  assert.equal(validShift({ pace: 'steady', startedAt: 'x', fromMin: 1200 }), false);
  assert.equal(validShift(null), false);
});
