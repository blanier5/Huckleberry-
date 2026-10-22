import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnRhythm, napQuality, windowPrior, napLenPrior } from '../src/learn.js';
import { ageNorms } from '../src/norms.js';
import { MIN } from '../src/time.js';
import { at, generateRhythm } from './helpers.js';

const TODAY = at(2026, 10, 10);
const NOW = TODAY + 12 * 60 * MIN;

test('nap quality: short naps shorten the next window, normal naps level off, bounded', () => {
  assert.ok(napQuality(20) < napQuality(45));
  assert.ok(napQuality(45) < napQuality(90) + 1e-9);
  assert.ok(napQuality(20) < napQuality(90) - 0.2, 'a 20-minute nap leads to a clearly shorter window than a 90-minute one');
  assert.ok(Math.abs(napQuality(60) - 1) < 1e-9);
  assert.ok(napQuality(5) >= 0.6 && napQuality(300) <= 1.06);
  for (let m = 5; m < 200; m += 5) assert.ok(napQuality(m + 5) >= napQuality(m), `monotonic at ${m}`);
  assert.equal(napQuality(NaN), 1);
});

test('learns wake windows by time of day, regardless of how many naps a day had', () => {
  const sleeps = generateRhythm({ endDay: TODAY, days: 14, window: () => 80, napLen: () => 40 });
  const perDay = {};
  for (const s of sleeps.filter((x) => x.kind === 'nap')) perDay[new Date(s.start).toDateString()] = (perDay[new Date(s.start).toDateString()] || 0) + 1;
  assert.ok(new Set(Object.values(perDay)).size >= 1);
  const r = learnRhythm(sleeps, { now: NOW });
  const mid = r.windowAt(12);
  // Reported for an ordinary-length nap: 80 min observed after ~40-minute naps (quality 0.93) -> ~86.
  assert.ok(Math.abs(mid.minutes - 80 / napQuality(40)) < 8, `midday window ${mid.minutes}`);
  assert.ok(mid.n > 3);
  assert.ok(r.windowCount > 40);
});

test('days with 4 and with 7 naps both contribute (nothing is matched on nap number)', () => {
  // Alternate short-window days (more naps) and long-window days (fewer naps).
  const many = generateRhythm({ endDay: TODAY - 7 * 24 * 60 * MIN, days: 7, seed: 3, window: () => 62, napLen: () => 30 });
  const few = generateRhythm({ endDay: TODAY, days: 7, seed: 4, window: () => 100, napLen: () => 55 });
  const r = learnRhythm([...many, ...few], { now: NOW });
  assert.ok(r.windowCount > 60);
  const est = r.windowAt(13).minutes;
  assert.ok(est > 62 && est < 100, `blends both kinds of day: ${est}`);
});

test('the quality effect is divided out, so a mix of short and long naps still yields the ordinary window', () => {
  const sleeps = generateRhythm({ endDay: TODAY, days: 14, seed: 5, window: (prev) => 82 * napQuality(prev), napLen: (_h, i) => (i % 2 ? 20 : 70) });
  const r = learnRhythm(sleeps, { now: NOW });
  const est = r.windowAt(12).minutes;
  assert.ok(Math.abs(est - 82) < 9, `ordinary window recovered: ${est}`);
});

test('nap length is learned by time of day (morning naps run longer than evening ones)', () => {
  const sleeps = generateRhythm({ endDay: TODAY, days: 14, seed: 6, window: () => 85, napLen: (h) => (h < 11 ? 65 : h < 16 ? 45 : 25) });
  const r = learnRhythm(sleeps, { now: NOW });
  assert.ok(r.napLenAt(9.5).minutes > r.napLenAt(17).minutes + 15, `${r.napLenAt(9.5).minutes} vs ${r.napLenAt(17).minutes}`);
});

test('no data: estimates are null and the age-based priors take over', () => {
  const r = learnRhythm([], { now: NOW });
  assert.equal(r.windowAt(12), null);
  assert.equal(r.napLenAt(12), null);
  assert.equal(r.cueAt(12), 1);
  const norms = ageNorms(2.4);
  assert.ok(windowPrior(norms, 18) > windowPrior(norms, 7), 'windows grow a little through the day');
  assert.ok(napLenPrior(norms, 18) < napLenPrior(norms, 9), 'naps shrink toward evening');
});

test('"fell asleep early" notes pull windows in near that time of day; without them there is no bias', () => {
  const base = generateRhythm({ endDay: TODAY, days: 14, seed: 7, window: () => 80, napLen: () => 45 });
  const none = learnRhythm(base, { now: NOW });
  assert.equal(none.cueAt(12), 1);
  // Flag the midday naps as "fell asleep early": she actually slept ~20% before the plan said.
  const flagged = base.map((s, i) => {
    if (s.kind !== 'nap') return s;
    const prev = base[i - 1];
    if (!prev) return s;
    const window = (s.start - prev.end) / MIN;
    const h = new Date(s.start).getHours();
    return h >= 11 && h <= 14 && window > 30 && window < 200 ? { ...s, flags: { early: true, planned: prev.end + (window / 0.8) * MIN } } : s;
  });
  const learned = learnRhythm(flagged, { now: NOW });
  assert.ok(learned.cueCount >= 4, `${learned.cueCount} flagged`);
  const cue = learned.cueAt(12.5);
  assert.ok(cue < 0.95 && cue > 0.7, `cue factor ${cue}`);
  assert.equal(learned.cueAt(7.5) >= 0.99, true, 'no evidence in the early morning, so no change there');
});

test('rough night: fewer total hours and more broken-up than usual', () => {
  const nights = (n, last) => {
    const sleeps = generateRhythm({ endDay: TODAY, days: n, seed: 8, night: [[0, 270], [300, 240]] });
    // last night (the one before today): replace it
    const lastBed = at(2026, 10, 9, 20, 30);
    const kept = sleeps.filter((s) => !(s.kind === 'night' && s.start >= lastBed - 60 * MIN));
    return [...kept, ...last.map(([off, len]) => ({ start: lastBed + off * MIN, end: lastBed + (off + len) * MIN, kind: 'night', notes: '' }))];
  };
  const morning = at(2026, 10, 10, 9, 0);
  const rough = learnRhythm(nights(12, [[0, 90], [120, 60], [210, 70], [320, 50], [400, 80], [520, 60]]), { now: morning });
  assert.ok(rough.night.poor, `severity ${rough.night.severity}`);
  assert.ok(rough.night.windowFactor < 0.97 && rough.night.windowFactor >= 0.9);
  assert.ok(rough.night.napFlex > 1);
  const fine = learnRhythm(nights(12, [[0, 280], [310, 230]]), { now: morning });
  assert.equal(fine.night.poor, false);
  assert.equal(fine.night.windowFactor, 1);
  const young = learnRhythm(nights(2, [[0, 90], [120, 60]]), { now: morning });
  assert.equal(young.night.poor, false, 'not enough nights to judge');
});

test('typical bedtime and wake time are medians of recent days', () => {
  const sleeps = generateRhythm({ endDay: TODAY, days: 14, seed: 9, bed: 20 * 60 + 30, wake: 7 * 60 });
  const r = learnRhythm(sleeps, { now: NOW });
  assert.ok(Math.abs(r.bedMin - (20 * 60 + 30)) < 15, String(r.bedMin));
  assert.ok(Math.abs(r.wakeMin - 7 * 60) < 20, String(r.wakeMin));
  assert.ok(r.days >= 10);
});
