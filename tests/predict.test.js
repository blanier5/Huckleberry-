import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predict } from '../src/predict.js';
import { MIN } from '../src/time.js';
import { at, generateRhythm } from './helpers.js';

const TODAY = at(2026, 10, 10);
const BABY = { name: 'Test', birth: at(2026, 7, 25) }; // about 2.5 months
const sleep = (start, end, kind = 'nap') => ({ id: `${start}`, start, end, kind, notes: '' });
const D = (h, m = 0) => at(2026, 10, 10, h, m);
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * MIN, `${msg ?? ''} ${clock(a)} vs ${clock(b)}`);
const history = (over = {}) => generateRhythm({ endDay: TODAY, days: 14, seed: 11, ...over });
const bedOf = (p) => [p.next, ...p.later].find((i) => i.kind === 'bedtime');
const napsOf = (p) => [p.next, ...p.later].filter((i) => i.kind === 'nap');

test('with no history it starts from typical windows for her age and ends in bedtime', () => {
  const wake = D(8);
  const p = predict({ sleeps: [sleep(at(2026, 10, 9, 20, 30), wake, 'night')], baby: BABY, now: wake + 20 * MIN });
  assert.equal(p.mode, 'awake');
  assert.equal(p.learned, null);
  assert.equal(p.next.kind, 'nap');
  assert.equal(p.next.number, 1);
  const w = (p.next.at - wake) / MIN;
  assert.ok(w > 55 && w < 100, `first window ${w}`);
  assert.ok(bedOf(p), 'the forecast reaches bedtime');
  assert.ok(p.reasons.some((r) => /typical at/i.test(r)));
});

test('learns her own windows (from every recent day, whatever the nap count)', () => {
  const sleeps = history({ window: () => 62, napLen: () => 35 });
  const wake = sleeps.filter((s) => s.kind === 'night').at(-1).end;
  const p = predict({ sleeps, baby: BABY, now: wake + 10 * MIN });
  assert.ok(p.learned && p.learned.windows >= 40);
  const w = (p.next.at - wake) / MIN;
  assert.ok(w < 78, `her short windows pull the first one in: ${w.toFixed(0)}`);
});

test('naps keep being suggested after 5 or 6: nap count is information, not a limit', () => {
  const sleeps = history({ window: () => 65, napLen: () => 35 });
  const day = [
    sleep(D(7, 0) - 9 * 60 * MIN, D(7, 0), 'night'),
    sleep(D(8, 10), D(8, 45)),
    sleep(D(9, 55), D(10, 30)),
    sleep(D(11, 40), D(12, 15)),
    sleep(D(13, 25), D(14, 0)),
    sleep(D(15, 10), D(15, 45)),
    sleep(D(16, 55), D(17, 25)),
  ];
  const p = predict({ sleeps: [...sleeps, ...day], baby: BABY, settings: { bedtime: '21:00' }, now: D(17, 30) });
  assert.equal(p.napsSoFar, 6);
  assert.equal(p.next.kind, 'nap', 'a seventh nap is offered while bedtime is 3.5 hours away');
  assert.equal(p.next.number, 7);
  assert.equal(p.mode, 'awake');
  assert.ok(!p.reasons.some((r) => /typical|which is what/i.test(r) && /naps today/i.test(r)), 'no "that is enough naps" message');
});

test('the next nap depends on the last wake time and nap quality, not on the nap number', () => {
  const sleeps = history();
  const run = (len, napsBefore) => {
    // Earlier naps of an ordinary length, so how many came before is the only thing that differs.
    const naps = Array.from({ length: napsBefore }, (_, i) => sleep(D(8 + i, 0), D(8 + i, 45)));
    const nap = sleep(D(12, 0), D(12, 0) + len * MIN);
    const p = predict({ sleeps: [...sleeps, sleep(D(7) - 9 * 60 * MIN, D(7), 'night'), ...naps.filter((n) => n.end < D(12)), nap], baby: BABY, now: nap.end + 5 * MIN });
    return { p, window: (p.next.at - nap.end) / MIN };
  };
  const short = run(20, 1);
  const long = run(90, 1);
  assert.ok(short.window < long.window * 0.88, `${short.window.toFixed(0)} vs ${long.window.toFixed(0)} min`);
  assert.ok(short.p.reasons.some((r) => /short/i.test(r)));
  const manyBefore = run(20, 3);
  assert.equal(Math.round(manyBefore.window), Math.round(short.window), 'same last wake and nap -> same window, however many naps came before');
});

test('a desired bedtime shapes the late afternoon: 8:30 PM lands near 8:30, not 9:00 or later', () => {
  const sleeps = history({ bed: 21 * 60 + 15 }); // her recent days have drifted late
  const wake = sleeps.filter((s) => s.kind === 'night').at(-1).end;
  const nap1 = sleep(wake + 80 * MIN, wake + 125 * MIN);
  const now = nap1.end + 10 * MIN;
  const at830 = predict({ sleeps: [...sleeps, nap1], baby: BABY, settings: { bedtime: '20:30' }, now });
  const at930 = predict({ sleeps: [...sleeps, nap1], baby: BABY, settings: { bedtime: '21:30' }, now });
  near(bedOf(at830).at, atOnDay(nap1.start, 20, 30), 12, 'lands on 8:30');
  near(bedOf(at930).at, atOnDay(nap1.start, 21, 30), 12, 'lands on 9:30');
  assert.equal(at830.bedtime.source, 'chosen');
  assert.ok(at830.reasons.some((r) => /Bedtime target is 8:30/i.test(r)));
});
function atOnDay(ms, h, m) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
}

test('a long stretch before bed becomes a short bridge nap, even when it is a late-numbered nap', () => {
  const sleeps = history({ window: () => 70, napLen: () => 40 });
  const day = [sleep(D(7) - 9 * 60 * MIN, D(7), 'night'), sleep(D(8, 15), D(9, 0)), sleep(D(10, 10), D(10, 50)), sleep(D(12, 0), D(12, 40)), sleep(D(13, 50), D(14, 30)), sleep(D(15, 40), D(16, 20)), sleep(D(17, 30), D(18, 0))];
  const p = predict({ sleeps: [...sleeps, ...day], baby: BABY, settings: { bedtime: '20:45' }, now: D(18, 5) });
  assert.equal(p.napsSoFar, 6);
  assert.equal(p.next.kind, 'nap');
  const bridge = napsOf(p).find((n) => n.bridge);
  assert.ok(bridge, 'a bridge nap is planned');
  assert.ok(bridge.len >= 15 && bridge.len <= 40);
  assert.ok(p.reasons.some((r) => /bridge nap/i.test(r)));
  near(bedOf(p).at, D(20, 45), 12);
});

test('a short nap is not treated like a long restorative one', () => {
  const sleeps = history();
  const wake = D(11, 0);
  const shortNap = sleep(D(10, 40), wake); // 20 minutes
  const base = [...sleeps, sleep(D(7) - 9 * 60 * MIN, D(7), 'night')];
  const a = predict({ sleeps: [...base, shortNap], baby: BABY, now: wake + 5 * MIN });
  const b = predict({ sleeps: [...base, sleep(D(9, 30), wake)], baby: BABY, now: wake + 5 * MIN });
  assert.ok(a.next.window < b.next.window - 8, `${a.next.window.toFixed(0)} vs ${b.next.window.toFixed(0)}`);
});

test('after a rough night windows are shorter and the day says why', () => {
  const normal = history({ night: [[0, 300], [330, 300]] });
  const lastBed = at(2026, 10, 9, 20, 30);
  const stripped = normal.filter((s) => !(s.kind === 'night' && s.start >= lastBed - 60 * MIN));
  const wake = D(7);
  const roughNight = [[0, 80], [110, 60], [200, 70], [300, 50], [380, 80], [490, 60]].map(([o, l]) => ({ start: lastBed + o * MIN, end: lastBed + (o + l) * MIN, kind: 'night', notes: '' }));
  const fineNight = [[0, 300], [330, 300]].map(([o, l]) => ({ start: lastBed + o * MIN, end: lastBed + (o + l) * MIN, kind: 'night', notes: '' }));
  const rough = predict({ sleeps: [...stripped, ...roughNight], baby: BABY, now: wake + 10 * MIN });
  const fine = predict({ sleeps: [...stripped, ...fineNight], baby: BABY, now: wake + 10 * MIN });
  assert.ok(rough.night.poor);
  assert.equal(fine.night.poor, false);
  assert.ok(rough.next.window < fine.next.window - 3, `${rough.next.window.toFixed(0)} vs ${fine.next.window.toFixed(0)}`);
  assert.ok(rough.reasons.some((r) => /rough night/i.test(r)));
});

test('priorities change how tightly bedtime is held', () => {
  const sleeps = history({ window: () => 95, napLen: () => 55 });
  const wake = sleeps.filter((s) => s.kind === 'night').at(-1).end;
  const args = { sleeps, baby: BABY, now: wake + 5 * MIN, settings: { bedtime: '19:30' } };
  const protect = predict({ ...args, settings: { ...args.settings, priority: 'protect' } });
  const cues = predict({ ...args, settings: { ...args.settings, priority: 'cues' } });
  assert.equal(protect.priority, 'protect');
  assert.equal(cues.priority, 'cues');
  assert.ok(Math.abs(bedOf(protect).offset) < Math.abs(bedOf(cues).offset) + 1e-6 || Math.abs(bedOf(protect).offset) < 12);
});

test('a bedtime shift uses the stage target, not the final one', () => {
  const sleeps = history({ bed: 22 * 60 });
  const wake = sleeps.filter((s) => s.kind === 'night').at(-1).end;
  const settings = { bedtime: '20:30', bedShift: { pace: 'steady', startedAt: at(2026, 10, 9), fromMin: 22 * 60 } };
  const p = predict({ sleeps, baby: BABY, settings, now: wake + 10 * MIN });
  assert.equal(p.bedtime.source, 'shift');
  assert.equal(p.bedtime.goalMin, 20 * 60 + 30);
  assert.ok(p.bedtime.bedMin > 20 * 60 + 30, 'not there yet');
  assert.ok(p.reasons.some((r) => /step on the way/i.test(r)));
});

test('a nap that runs long is never cut short in the plan; the evening adjusts and waking her is a last resort', () => {
  const sleeps = history();
  const asleep = (startAt, nowAt) => [...sleeps, sleep(D(7) - 9 * 60 * MIN, D(7), 'night'), { id: 'o', start: startAt, end: null, kind: 'nap', notes: '' }, nowAt];
  const run = (start, now) => predict({ sleeps: asleep(start, null).filter(Boolean), baby: BABY, settings: { bedtime: '20:00' }, now });

  // Just started: nothing to say.
  const fresh = run(D(17, 20), D(17, 40));
  assert.equal(fresh.wakeBy, null);
  assert.equal(fresh.notes.length, 0);

  // Running past the usual length, but the evening can absorb it: fewer naps, no wake-by.
  const long = run(D(17, 20), D(18, 40));
  assert.equal(long.wakeBy, null);
  assert.ok(long.notes.some((n) => /past the usual .*fewer nap/i.test(n)), long.notes.join(' / '));
  assert.ok(long.expectedWake >= D(18, 40), 'the plan starts from when she actually wakes, not from a cut-off');

  // So long that bedtime really slips: waking her is offered, along with what sleeping on costs.
  const tooLong = run(D(17, 20), D(19, 20));
  assert.ok(tooLong.wakeBy != null && tooLong.wakeBy >= D(17, 30));
  assert.match(tooLong.notes[0], /If she sleeps on, bedtime lands about .* after your 8:00 PM target\. To hold 8:00 PM, wake her by/);
  assert.ok(bedOf({ next: tooLong.after[0], later: tooLong.after.slice(1) }).at > D(20, 15), 'the shown plan lets her sleep and moves bedtime');
});

test('asleep through the night with a wake target: waking guidance follows the range', () => {
  const sleeps = history();
  const start = at(2026, 10, 10, 20, 30);
  const settings = { wake: { time: '08:00', range: 30 }, bedtime: '20:30' };
  const asleep = [...sleeps, { id: 'n', start, end: null, kind: 'night', notes: '' }];
  const early = predict({ sleeps: asleep, baby: BABY, settings, now: at(2026, 10, 11, 6, 30) });
  assert.equal(early.mode, 'asleep');
  assert.ok(early.wakeRange);
  assert.equal(early.pastTarget, false);
  assert.ok(early.notes[0].match(/Target wake 8:00 AM \(7:30 AM–8:30 AM\)/), early.notes[0]);
  const inside = predict({ sleeps: asleep, baby: BABY, settings, now: at(2026, 10, 11, 8, 10) });
  assert.match(inside.notes[0], /Wake by 8:30 AM to protect tonight's bedtime/);
  const late = predict({ sleeps: asleep, baby: BABY, settings, now: at(2026, 10, 11, 8, 50) });
  assert.equal(late.pastTarget, true);
  assert.match(late.notes[0], /Past the .*target/);
  assert.equal(late.wakeBy, at(2026, 10, 11, 8, 30));
});

test('waking late compresses the day instead of moving bedtime', () => {
  const sleeps = history();
  const settings = { bedtime: '20:30', wake: { time: '08:00', range: 30 } };
  // Drop the generated night that ends at 7:00 today, then add our own night with a different wake.
  const noLastNight = sleeps.filter((s) => !(s.kind === 'night' && s.start >= at(2026, 10, 9, 20, 0)));
  const onTime = predict({ sleeps: [...noLastNight, sleep(D(8) - 11 * 60 * MIN, D(8), 'night')], baby: BABY, settings, now: D(8, 10) });
  const late = predict({ sleeps: [...noLastNight, sleep(D(9, 40) - 13 * 60 * MIN, D(9, 40), 'night')], baby: BABY, settings, now: D(9, 50) });
  near(bedOf(onTime).at, D(20, 30), 12);
  near(bedOf(late).at, D(20, 30), 14, 'bedtime holds');
  assert.ok(late.reasons.some((r) => /after the end of the .* wake range/i.test(r)));
});

test('"fell asleep early" notes shorten the windows near that time of day', () => {
  const base = history({ window: () => 80, napLen: () => 45 });
  const flagged = base.map((s, i) => {
    const prev = base[i - 1];
    if (s.kind !== 'nap' || !prev) return s;
    const w = (s.start - prev.end) / MIN;
    return w > 30 && w < 200 ? { ...s, flags: { early: true, planned: prev.end + (w / 0.8) * MIN } } : s;
  });
  const wake = D(11, 0);
  const nap = sleep(D(10, 15), wake);
  const prior = [sleep(D(7) - 9 * 60 * MIN, D(7), 'night')];
  const without = predict({ sleeps: [...base, ...prior, nap], baby: BABY, now: wake + 5 * MIN });
  const withNotes = predict({ sleeps: [...flagged, ...prior, nap], baby: BABY, now: wake + 5 * MIN });
  assert.ok(withNotes.cues >= 4);
  assert.ok(withNotes.next.window < without.next.window - 5, `${withNotes.next.window.toFixed(0)} vs ${without.next.window.toFixed(0)}`);
  assert.ok(withNotes.reasons.some((r) => /fallen asleep early/i.test(r)));
});

test('asleep at night without a wake target: expects her usual morning', () => {
  const sleeps = history();
  const start = at(2026, 10, 10, 20, 30);
  const p = predict({ sleeps: [...sleeps, { id: 'n', start, end: null, kind: 'night', notes: '' }], baby: BABY, now: at(2026, 10, 10, 23, 0) });
  assert.equal(p.mode, 'asleep');
  assert.equal(p.kind, 'night');
  near(p.expectedWake, at(2026, 10, 11, 7, 0), 30);
  assert.equal(p.after[0].kind, 'nap');
  assert.equal(p.after[0].number, 1);
});

test('edge states: empty, stale, night waking', () => {
  assert.equal(predict({ sleeps: [], baby: BABY, now: TODAY }).mode, 'empty');
  const old = [sleep(at(2026, 10, 8, 10, 0), at(2026, 10, 8, 11, 0))];
  assert.equal(predict({ sleeps: old, baby: BABY, now: TODAY + 12 * 60 * MIN }).mode, 'stale');
  const night = [sleep(at(2026, 10, 9, 20, 0), at(2026, 10, 10, 2, 30), 'night')];
  assert.equal(predict({ sleeps: night, baby: BABY, now: at(2026, 10, 10, 2, 45) }).mode, 'night-awake');
});

test('old history does not drive predictions for a baby who has grown out of it', () => {
  const old = generateRhythm({ endDay: at(2026, 7, 1), days: 14, seed: 5 });
  const wake = D(8);
  const p = predict({ sleeps: [...old, sleep(at(2026, 10, 9, 20, 30), wake, 'night')], baby: BABY, now: wake + 20 * MIN });
  assert.equal(p.learned, null);
});

test('bedtime past or right now: bedtime is next', () => {
  const sleeps = history();
  const nap = sleep(D(19, 20), D(20, 5));
  const p = predict({ sleeps: [...sleeps, sleep(D(7) - 9 * 60 * MIN, D(7), 'night'), nap], baby: BABY, settings: { bedtime: '20:30' }, now: D(20, 10) });
  assert.equal(p.next.kind, 'bedtime');
  assert.equal(p.later.length, 0);
});
