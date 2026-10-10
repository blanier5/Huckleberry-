import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySleep, buildDays, buildProfile, groupByDay, median } from '../src/analysis.js';
import { createStore } from '../src/store.js';
import { MIN } from '../src/time.js';
import { at, generateHistory } from './helpers.js';

test('classifySleep: clock time and length decide nap vs night', () => {
  assert.equal(classifySleep(at(2026, 10, 1, 13, 0), at(2026, 10, 1, 14, 0)), 'nap');
  assert.equal(classifySleep(at(2026, 10, 1, 17, 30), at(2026, 10, 1, 18, 0)), 'nap');
  assert.equal(classifySleep(at(2026, 10, 1, 19, 0), at(2026, 10, 2, 6, 0)), 'night');
  assert.equal(classifySleep(at(2026, 10, 2, 2, 0), at(2026, 10, 2, 3, 0)), 'night');
  assert.equal(classifySleep(at(2026, 10, 1, 17, 40), at(2026, 10, 2, 6, 0)), 'night'); // early bedtime, long
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test('buildDays folds night wakings into one night block', () => {
  const sleeps = [
    { start: at(2026, 10, 1, 19, 0), end: at(2026, 10, 2, 1, 0), kind: 'night' },
    { start: at(2026, 10, 2, 1, 40), end: at(2026, 10, 2, 6, 30), kind: 'night' },
    { start: at(2026, 10, 2, 9, 0), end: at(2026, 10, 2, 10, 0), kind: 'nap' },
    { start: at(2026, 10, 2, 19, 0), end: at(2026, 10, 3, 6, 30), kind: 'night' },
  ];
  const { days, open } = buildDays(sleeps);
  assert.equal(days.length, 1, 'Oct 2 (6:30 wake -> 19:00 bedtime) is complete');
  assert.equal(days[0].wake, at(2026, 10, 2, 6, 30), 'the 1am waking did not start a new day');
  assert.equal(open.wake, at(2026, 10, 3, 6, 30));
  assert.equal(open.naps.length, 0);

  const more = [{ start: at(2026, 10, 3, 9, 0), end: at(2026, 10, 3, 10, 0), kind: 'nap' }, { start: at(2026, 10, 3, 19, 0), end: at(2026, 10, 4, 6, 30), kind: 'night' }];
  const r = buildDays([...sleeps, ...more]);
  assert.equal(r.days.length, 2);
  assert.equal(r.days[0].wake, at(2026, 10, 2, 6, 30));
  assert.equal(r.days[0].bedtime, at(2026, 10, 2, 19, 0));
  assert.equal(r.days[0].naps.length, 1);
  assert.ok(r.days[0].sane);
});

test('an early-morning nap right after a night waking stays part of the night', () => {
  const sleeps = [
    { start: at(2026, 10, 1, 19, 0), end: at(2026, 10, 2, 5, 0), kind: 'night' },
    { start: at(2026, 10, 2, 5, 45), end: at(2026, 10, 2, 7, 15), kind: 'nap' },
    { start: at(2026, 10, 2, 9, 30), end: at(2026, 10, 2, 10, 30), kind: 'nap' },
    { start: at(2026, 10, 2, 19, 0), end: at(2026, 10, 3, 6, 30), kind: 'night' },
  ];
  const { days } = buildDays(sleeps);
  assert.equal(days.length, 1);
  assert.equal(days[0].wake, at(2026, 10, 2, 7, 15));
  assert.equal(days[0].naps.length, 1);
});

test('buildProfile learns nap count, windows and bedtime', () => {
  const now = at(2026, 10, 10, 12, 0);
  const profile = buildProfile(generateHistory({ endDay: at(2026, 10, 10), days: 21 }), { now });
  assert.equal(profile.napCount, 3);
  assert.equal(profile.windows.length, 4);
  assert.ok(Math.abs(profile.windows[0] - 115) < 8);
  assert.ok(Math.abs(profile.windows[3] - 165) < 12);
  assert.ok(Math.abs(profile.napLens[1] - 75) < 10);
  assert.ok(profile.weight > 0.7);
  assert.equal(buildProfile([], { now }), null);
});

test('groupByDay: a night belongs to the morning it ends, even when split by a waking', () => {
  const now = at(2026, 10, 3, 12, 0);
  const g = groupByDay(
    [
      { id: 'a', start: at(2026, 10, 2, 9, 0), end: at(2026, 10, 2, 10, 0), kind: 'nap' },
      { id: 'b', start: at(2026, 10, 2, 13, 0), end: at(2026, 10, 2, 13, 30), kind: 'nap' },
      { id: 'c', start: at(2026, 10, 1, 19, 0), end: at(2026, 10, 2, 1, 0), kind: 'night' },
      { id: 'd', start: at(2026, 10, 2, 1, 30), end: at(2026, 10, 2, 6, 0), kind: 'night' },
      { id: 'e', start: at(2026, 10, 2, 19, 0), end: at(2026, 10, 3, 6, 30), kind: 'night' },
    ],
    now,
  );
  assert.equal(g.length, 2);
  assert.equal(g[0].date, at(2026, 10, 3));
  assert.equal(g[0].nightMinutes, 11.5 * 60);
  assert.equal(g[1].date, at(2026, 10, 2));
  assert.equal(g[1].napCount, 2);
  assert.equal(g[1].napMinutes, 90);
  assert.equal(g[1].nightMinutes, 10.5 * 60, '6h + 4.5h of the night that ended on Oct 2');
});

test('groupByDay: an unfinished bedtime sleep stays under today', () => {
  const now = at(2026, 10, 2, 22, 0);
  const g = groupByDay([{ id: 'o', start: at(2026, 10, 2, 19, 0), end: null, kind: 'night' }], now);
  assert.equal(g.length, 1);
  assert.equal(g[0].date, at(2026, 10, 2));
});

// ---- store ----

function memoryStorage() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), data };
}

test('store: start/end a sleep, persist, reload', () => {
  const storage = memoryStorage();
  const s1 = createStore(storage);
  s1.setBaby({ name: 'Mia', birth: at(2026, 3, 10) });
  assert.ok(s1.startSleep('nap', at(2026, 10, 10, 13, 0)));
  assert.equal(s1.startSleep('nap', at(2026, 10, 10, 13, 5)), null, 'cannot start two at once');
  s1.endSleep(at(2026, 10, 10, 14, 10));
  assert.equal(s1.ongoing, null);

  const s2 = createStore(storage);
  assert.equal(s2.state.baby.name, 'Mia');
  assert.equal(s2.state.sleeps.length, 1);
  assert.equal(s2.state.sleeps[0].end - s2.state.sleeps[0].start, 70 * MIN);
});

test('store: a nap that runs all night is reclassified as night sleep', () => {
  const s = createStore(memoryStorage());
  s.startSleep('nap', at(2026, 10, 10, 17, 30));
  s.endSleep(at(2026, 10, 11, 6, 0));
  assert.equal(s.state.sleeps[0].kind, 'night');
});

test('store: merging skips duplicates and rejects bad rows', () => {
  const s = createStore(memoryStorage());
  const a = { start: at(2026, 10, 1, 9, 0), end: at(2026, 10, 1, 10, 0), kind: 'nap' };
  assert.deepEqual(s.mergeSleeps([a, { start: 5, end: 3 }]), { added: 1, duplicates: 0 });
  assert.deepEqual(s.mergeSleeps([{ ...a }, { start: at(2026, 10, 1, 13, 0), end: at(2026, 10, 1, 14, 0) }]), { added: 1, duplicates: 1 });
  assert.equal(s.state.sleeps.length, 2);
  assert.equal(s.state.sleeps[1].kind, 'nap');
});

test('store: JSON backup round-trips and merges', () => {
  const a = createStore(memoryStorage());
  a.setBaby({ name: 'Mia', birth: at(2026, 3, 10) });
  a.addSleep({ start: at(2026, 10, 1, 9, 0), end: at(2026, 10, 1, 10, 0) });
  const b = createStore(memoryStorage());
  b.addSleep({ start: at(2026, 10, 1, 13, 0), end: at(2026, 10, 1, 14, 0) });
  const r = b.importJSON(a.exportJSON());
  assert.equal(r.added, 1);
  assert.equal(b.state.sleeps.length, 2);
  assert.equal(b.state.baby.name, 'Mia');
  assert.throws(() => b.importJSON('{"nope":1}'));
});

test('store: corrupt storage falls back to empty state', () => {
  const storage = memoryStorage();
  storage.setItem('napberry:v1', '{not json');
  assert.deepEqual(createStore(storage).state.sleeps, []);
});
