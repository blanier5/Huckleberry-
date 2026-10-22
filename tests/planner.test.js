import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDay, latestWake, PRIORITIES } from '../src/planner.js';
import { napQuality } from '../src/learn.js';
import { MIN } from '../src/time.js';
import { at } from './helpers.js';

const D = (h, m = 0) => at(2026, 10, 10, h, m);
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
const ctxOf = (o = {}) => ({
  ordinaryWindow: () => 80,
  napLength: () => 45,
  spread: () => 12,
  cueAt: () => 1,
  nightFactor: 1,
  napFlex: 1,
  ...o,
});
const naps = (plan) => plan.items.filter((i) => i.kind === 'nap');
const bed = (plan) => plan.items.find((i) => i.kind === 'bedtime');
const near = (a, b, tolMin, msg) => assert.ok(Math.abs(a - b) <= tolMin * MIN, `${msg ?? ''} ${clock(a)} vs ${clock(b)}`);

test('a normal day: naps follow her usual windows and bedtime lands on the target', () => {
  const plan = planDay({ t0: D(8), bed: D(20, 30), ctx: ctxOf() });
  assert.ok(plan.ok);
  near(bed(plan).at, D(20, 30), 10, 'bedtime');
  const first = naps(plan)[0];
  near(first.at, D(8) + 80 * MIN, 12, 'first nap is about one window after waking');
  // Every gap is a believable one: nothing absurdly short or long.
  let t = D(8);
  for (const n of naps(plan)) {
    assert.ok(n.window > 50 && n.window < 120, `window ${n.window}`);
    assert.ok(n.len >= 15 && n.len <= 75, `nap ${n.len}`);
    t = n.end;
  }
  assert.ok(bed(plan).window > 45 && bed(plan).window < 115);
});

test('there is no nap cap: a day that needs seven naps gets seven', () => {
  const short = ctxOf({ ordinaryWindow: () => 60, napLength: () => 35 });
  const plan = planDay({ t0: D(7), bed: D(21), ctx: short });
  assert.ok(naps(plan).length >= 7, `${naps(plan).length} naps`);
  assert.ok(plan.ok);
  near(bed(plan).at, D(21), 10);
  // Numbers just count up, with no "of N".
  assert.deepEqual(naps(plan).map((n) => n.number), naps(plan).map((_, i) => i + 1));
});

test('the same window rules produce fewer naps when the windows are longer', () => {
  const longer = planDay({ t0: D(7), bed: D(20, 30), ctx: ctxOf({ ordinaryWindow: () => 120, napLength: () => 60 }) });
  const shorter = planDay({ t0: D(7), bed: D(20, 30), ctx: ctxOf({ ordinaryWindow: () => 65, napLength: () => 35 }) });
  assert.ok(naps(longer).length < naps(shorter).length, `${naps(longer).length} < ${naps(shorter).length}`);
});

test('late afternoon is shaped around the desired bedtime rather than landing wherever the windows lead', () => {
  const natural = planDay({ t0: D(8), bed: D(21, 30), ctx: ctxOf(), policy: PRIORITIES.cues });
  const early = planDay({ t0: D(8), bed: D(20, 30), ctx: ctxOf() });
  const late = planDay({ t0: D(8), bed: D(21, 30), ctx: ctxOf() });
  near(bed(early).at, D(20, 30), 10, 'asks for 8:30, gets 8:30');
  near(bed(late).at, D(21, 30), 10, 'asks for 9:30, gets 9:30');
  // The morning barely changes; the late-afternoon naps are where the difference shows up.
  near(naps(early)[0].at, naps(late)[0].at, 15, 'first nap barely moves');
  const lastE = naps(early).at(-1);
  const lastL = naps(late).at(-1);
  assert.ok(lastL.end - lastE.end >= 20 * MIN || naps(late).length > naps(early).length, 'the late-day plan differs in the evening');
  assert.ok(natural.items.length > 0);
});

test('too much awake time before bed becomes a short bridge nap, even if it is nap #6 or #7', () => {
  const ctx = ctxOf({ ordinaryWindow: () => 75, napLength: () => 40 });
  // Nap #5 ended at 6pm and bedtime is 8:30pm: 2.5 hours. One long window would be far too much.
  const plan = planDay({ t0: D(18), prevLen: 40, prevKind: 'nap', bed: D(20, 30), napsDone: 5, ctx });
  assert.equal(naps(plan).length, 1, 'one nap, not a 150-minute stretch');
  const bridge = naps(plan)[0];
  assert.equal(bridge.number, 6, 'a sixth nap is fine');
  assert.ok(bridge.len >= 15 && bridge.len <= 35, `bridge nap ${bridge.len.toFixed(0)} min`);
  assert.equal(bridge.bridge, true);
  assert.ok(bed(plan).window <= 75 * 1.25 + 1, `final window ${bed(plan).window.toFixed(0)}`);
  assert.ok(plan.ok);
  near(bed(plan).at, D(20, 30), 10);

  // Without the bridge the last stretch would have been ~2x her usual window.
  const noBridge = D(20, 30) - D(18) - 0;
  assert.ok(noBridge / MIN > 75 * 1.8);

  // Having already taken 5 naps changes nothing about whether another is offered.
  const lots = planDay({ t0: D(15, 30), prevLen: 40, prevKind: 'nap', bed: D(20, 30), napsDone: 5, ctx });
  assert.ok(naps(lots).length >= 1);
  assert.equal(naps(lots)[0].number, 6);
  assert.ok(lots.ok);
});

test('nap #7 and #8 are still offered while there is room before bedtime', () => {
  const ctx = ctxOf({ ordinaryWindow: () => 70, napLength: () => 30 });
  const plan = planDay({ t0: D(18, 0), prevLen: 30, prevKind: 'nap', bed: D(22, 0), napsDone: 6, ctx });
  assert.ok(naps(plan).length >= 1);
  assert.equal(naps(plan)[0].number, 7);
  assert.ok(naps(plan).every((n) => n.at > D(18)));
});

test('close to bedtime there is no nap, just bedtime', () => {
  const plan = planDay({ t0: D(19, 15), prevLen: 45, prevKind: 'nap', bed: D(20, 30), napsDone: 5, ctx: ctxOf() });
  assert.equal(naps(plan).length, 0);
  near(bed(plan).at, D(20, 30), 10);
  assert.equal(plan.items.length, 1);
});

test('a short nap leads to a shorter next window than a long one', () => {
  const after = (len) => planDay({ t0: D(11), prevLen: len, prevKind: 'nap', bed: D(20, 30), ctx: ctxOf() });
  const s = naps(after(20))[0];
  const l = naps(after(90))[0];
  assert.ok(s.at < l.at, 'earlier after a 20-minute nap');
  const shortWindow = (s.at - D(11)) / MIN;
  const longWindow = (l.at - D(11)) / MIN;
  assert.ok(shortWindow < longWindow * 0.88, `${shortWindow.toFixed(0)} vs ${longWindow.toFixed(0)} min`);
  // And it tracks the quality curve (before bending for bedtime, which is small this early in the day).
  assert.ok(Math.abs(shortWindow / 80 - napQuality(20)) < 0.1);
});

test('next window depends on the last wake, not on how many naps came before', () => {
  const a = planDay({ t0: D(12), prevLen: 50, prevKind: 'nap', napsDone: 1, bed: D(20, 30), ctx: ctxOf() });
  const b = planDay({ t0: D(12), prevLen: 50, prevKind: 'nap', napsDone: 6, bed: D(20, 30), ctx: ctxOf() });
  assert.equal(naps(a)[0].at, naps(b)[0].at);
  assert.equal(naps(b)[0].number, 7);
});

test('after a rough night windows run shorter and extra naps are easier to add', () => {
  const normal = planDay({ t0: D(8), bed: D(20, 30), ctx: ctxOf() });
  const rough = planDay({ t0: D(8), bed: D(20, 30), ctx: ctxOf({ nightFactor: 0.91, napFlex: 1.25 }) });
  const wN = (naps(normal)[0].at - D(8)) / MIN;
  const wR = (naps(rough)[0].at - D(8)) / MIN;
  assert.ok(wR < wN - 4, `${wR.toFixed(0)} < ${wN.toFixed(0)}`);
  assert.ok(naps(rough).length >= naps(normal).length);
});

test('priorities: protect holds bedtime tightly; cues lets it drift; sleep keeps naps whole', () => {
  // A day whose natural rhythm would land well away from the target.
  const ctx = ctxOf({ ordinaryWindow: () => 100, napLength: () => 55 });
  const args = { t0: D(7), bed: D(20), ctx };
  const protect = planDay({ ...args, policy: PRIORITIES.protect });
  const cues = planDay({ ...args, policy: PRIORITIES.cues });
  const sleep = planDay({ ...args, policy: PRIORITIES.sleep });
  assert.ok(Math.abs(bed(protect).offset) <= 12, `protect off by ${bed(protect).offset.toFixed(0)}`);
  assert.ok(Math.abs(bed(cues).offset) <= 76);
  assert.ok(Math.abs(bed(protect).offset) <= Math.abs(bed(cues).offset) + 1e-6);
  const napMinutes = (p) => naps(p).reduce((s, n) => s + n.len, 0);
  assert.ok(napMinutes(sleep) > napMinutes(protect), `maximize-sleep offers more nap time: ${napMinutes(sleep).toFixed(0)} vs ${napMinutes(protect).toFixed(0)} min`);
});

test('bedtime already here or past: just bedtime, right away', () => {
  const plan = planDay({ t0: D(20, 45), prevLen: 30, prevKind: 'nap', bed: D(20, 30), ctx: ctxOf() });
  assert.equal(naps(plan).length, 0);
  assert.ok(bed(plan).at >= D(20, 45));
});

test('stable: the same inputs give the same plan, and a later wake never makes the next nap earlier', () => {
  const p1 = planDay({ t0: D(10), prevLen: 45, prevKind: 'nap', bed: D(20, 30), ctx: ctxOf() });
  const p2 = planDay({ t0: D(10), prevLen: 45, prevKind: 'nap', bed: D(20, 30), ctx: ctxOf() });
  assert.deepEqual(p1.items, p2.items);
  let prev = 0;
  for (let m = 0; m <= 60; m += 5) {
    const p = planDay({ t0: D(10) + m * MIN, prevLen: 45, prevKind: 'nap', bed: D(20, 30), ctx: ctxOf() });
    const at = naps(p)[0].at;
    assert.ok(at >= prev, `monotonic at +${m}`);
    prev = at;
  }
});

test('latestWake: the last moment to end a nap before the evening starts to get squeezed', () => {
  const ctx = ctxOf();
  const start = D(16, 30);
  const args = { start, from: start + 10 * MIN, around: start + 45 * MIN, bed: D(20, 30), ctx, policy: PRIORITIES.protect };
  const by = latestWake(args);
  assert.ok(by != null && by > start);
  const plan = (e) => planDay({ t0: e, prevLen: (e - start) / MIN, prevKind: 'nap', bed: D(20, 30), ctx });
  assert.equal(plan(by).tooLate, false, 'waking by then is fine');
  assert.equal(plan(by + 20 * MIN).tooLate, true, 'twenty minutes later the evening is being squeezed');
  assert.ok(by < D(19, 30));
  // If she is already past the point where it works, the answer is "as soon as she can".
  const soon = latestWake({ ...args, start: D(20, 0), from: D(20, 15), around: D(20, 40) });
  assert.equal(soon, D(20, 15), 'asleep at 8pm with bedtime at 8:30: wake now');
});
