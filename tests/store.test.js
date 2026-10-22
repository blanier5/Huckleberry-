import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { MIN } from '../src/time.js';
import { at } from './helpers.js';

const memoryStorage = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
};
const T0 = at(2026, 10, 10, 8, 0);
const mk = () => {
  const t = { now: T0 };
  const store = createStore(memoryStorage(), { clock: () => t.now });
  return { t, store };
};
const nap = (h, m, len = 60) => ({ start: at(2026, 10, 10, h, m), end: at(2026, 10, 10, h, m) + len * MIN, kind: 'nap' });

test('a sleep is identified by its start minute, so the same nap is the same record everywhere', () => {
  const { store } = mk();
  const a = store.addSleep(nap(9, 0));
  assert.equal(a.id, `s${Math.round(nap(9, 0).start / MIN)}`);
  assert.equal(store.addSleep({ ...nap(9, 0), end: nap(9, 0).end + 5 * MIN }), null, 'same minute is the same sleep');
  assert.equal(store.hasSleepAt(nap(9, 0).start), true);
  assert.equal(store.hasSleepAt(nap(9, 0).start, a.id), false, 'a sleep does not collide with itself');
});

test('every local change is stamped, queued, and the stamp always moves forward', () => {
  const { t, store } = mk();
  const s = store.addSleep(nap(9, 0));
  const first = s.updatedAt;
  assert.equal(first, T0);
  assert.deepEqual(Object.keys(store.state.pending.sleeps), [s.id]);
  store.updateSleep(s.id, { notes: 'a' }); // clock hasn't moved: still strictly newer
  assert.ok(store.state.sleeps[0].updatedAt > first);
  t.now -= 60 * MIN; // a device clock set back
  const before = store.state.sleeps[0].updatedAt;
  store.updateSleep(s.id, { notes: 'b' });
  assert.ok(store.state.sleeps[0].updatedAt > before);
});

test('deleting leaves a tombstone that is queued like any change', () => {
  const { store } = mk();
  const s = store.addSleep(nap(9, 0));
  store.removeSleep(s.id);
  assert.equal(store.state.sleeps.length, 0);
  assert.ok(store.state.tombstones[s.id] > s.updatedAt);
  const snap = store.pendingSnapshot();
  assert.deepEqual(snap.sleeps.map((x) => [x.id, x.deleted]), [[s.id, true]]);
});

test('ackPending clears what was sent but keeps anything edited since', () => {
  const { t, store } = mk();
  const s = store.addSleep(nap(9, 0));
  const snap = store.pendingSnapshot();
  t.now += MIN;
  store.updateSleep(s.id, { notes: 'edited while uploading' });
  store.ackPending(snap);
  assert.equal(store.hasPending(), true);
  store.ackPending(store.pendingSnapshot());
  assert.equal(store.hasPending(), false);
});

test('remote changes: newer wins, older is ignored, a newer delete removes, a stale resurrect loses', () => {
  const { store } = mk();
  const s = store.addSleep(nap(9, 0));
  store.ackPending(store.pendingSnapshot());
  const remote = (over) => ({ id: s.id, start: s.start, end: s.end, kind: 'nap', notes: '', deleted: false, updatedAt: s.updatedAt, ...over });

  assert.equal(store.applyRemote({ sleeps: [remote({ notes: 'older', updatedAt: s.updatedAt - 5 })] }), false);
  assert.equal(store.state.sleeps[0].notes, '');
  assert.equal(store.hasPending(), true, 'we hold something newer than the server, so we offer it');

  assert.equal(store.applyRemote({ sleeps: [remote({ notes: 'newer', updatedAt: s.updatedAt + 5 })] }), true);
  assert.equal(store.state.sleeps[0].notes, 'newer');

  store.applyRemote({ sleeps: [{ id: s.id, deleted: true, updatedAt: s.updatedAt + 10 }] });
  assert.equal(store.state.sleeps.length, 0);
  store.applyRemote({ sleeps: [remote({ notes: 'zombie', updatedAt: s.updatedAt + 7 })] });
  assert.equal(store.state.sleeps.length, 0, 'older than the delete');
});

test('remote data is validated: bad ids, times and profiles are ignored', () => {
  const { store } = mk();
  const good = { id: `s${Math.round(nap(9, 0).start / MIN)}`, ...nap(9, 0), updatedAt: 5 };
  store.applyRemote({
    sleeps: [
      { ...good, id: 'wrong-id-for-this-start' },
      { ...good, id: 's1', start: 1, end: 0 },
      { id: 'x', updatedAt: 'soon' },
      null,
      good,
    ],
    profile: { baby: { name: 5, birth: 'x' }, updatedAt: 9 },
  });
  assert.equal(store.state.sleeps.length, 1);
  assert.equal(store.state.baby, null);
  store.applyRemote({ profile: { baby: { name: 'Mia', birth: at(2026, 3, 10) }, settings: { bedtime: 'late' }, updatedAt: 9 } });
  assert.equal(store.state.baby.name, 'Mia');
  assert.equal(store.state.settings.bedtime, null, 'invalid bedtime dropped');
});

test('two sleeps in progress (one from each phone) collapse to the first', () => {
  const { store } = mk();
  const first = { id: `s${Math.round((T0 + 10 * MIN) / MIN)}`, start: T0 + 10 * MIN, end: null, kind: 'nap', updatedAt: 1 };
  const second = { id: `s${Math.round((T0 + 12 * MIN) / MIN)}`, start: T0 + 12 * MIN, end: null, kind: 'nap', updatedAt: 1 };
  store.applyRemote({ sleeps: [second, first] });
  assert.equal(store.state.sleeps.length, 1);
  assert.equal(store.ongoing.start, T0 + 10 * MIN);
});

test('moving a start time re-identifies the sleep and refuses a collision', () => {
  const { store } = mk();
  const a = store.addSleep(nap(9, 0));
  store.addSleep(nap(12, 0));
  assert.equal(store.updateSleep(a.id, { start: nap(12, 0).start, end: nap(12, 0).end }), null);
  const moved = store.updateSleep(a.id, { start: at(2026, 10, 10, 9, 20), end: at(2026, 10, 10, 10, 20) });
  assert.notEqual(moved.id, a.id);
  assert.ok(store.state.tombstones[a.id], 'the old identity is deleted so other phones drop it');
  assert.equal(store.state.sleeps.length, 2);
});

test('joining adopts the family profile and uploads local sleeps', () => {
  const { store } = mk();
  store.setBaby({ name: 'Typed locally', birth: at(2026, 1, 1) });
  store.addSleep(nap(9, 0));
  store.ackPending(store.pendingSnapshot());
  store.prepareJoin();
  assert.equal(store.pendingSnapshot().profile, null, 'local profile is not pushed');
  assert.equal(store.pendingSnapshot().sleeps.length, 1);
  store.applyRemote({ profile: { baby: { name: 'Mia', birth: at(2026, 3, 10) }, settings: { bedtime: null }, updatedAt: 1 } });
  assert.equal(store.state.baby.name, 'Mia');
});

test('a save from before the new settings existed loads untouched, with the new settings simply unset', () => {
  const storage = memoryStorage();
  const saved = {
    version: 2,
    baby: { name: 'Mia', birth: at(2026, 7, 25) },
    settings: { bedtime: '22:00' }, // all the app had before
    profileAt: 7,
    sleeps: [
      { id: `s${Math.round(nap(9, 0).start / MIN)}`, ...nap(9, 0), notes: 'keep me', updatedAt: 5, source: 'huckleberry' },
      { id: `s${Math.round(nap(12, 0).start / MIN)}`, ...nap(12, 0), notes: '', updatedAt: 6 },
    ],
    tombstones: { s1: 9 },
    pending: { sleeps: { s1: 1 }, profile: true },
  };
  storage.setItem('napberry:v1', JSON.stringify(saved));
  const store = createStore(storage, { clock: () => T0 });
  assert.equal(store.state.baby.name, 'Mia');
  assert.equal(store.state.settings.bedtime, '22:00', 'the chosen bedtime is kept');
  assert.deepEqual([store.state.settings.bedShift, store.state.settings.wake, store.state.settings.wakeShift, store.state.settings.priority], [null, null, null, null]);
  assert.equal(store.state.sleeps.length, 2);
  assert.equal(store.state.sleeps[0].notes, 'keep me');
  assert.equal(store.state.sleeps[0].source, 'huckleberry');
  assert.deepEqual(store.state.tombstones, { s1: 9 });
  assert.equal(store.state.pending.profile, true);
  assert.equal(store.state.profileAt, 7);
});

test('new settings are saved, validated, and part of the profile that syncs', () => {
  const { store } = mk();
  store.setBaby({ name: 'Mia', birth: at(2026, 7, 25) });
  store.setSettings({ bedtime: '20:30', priority: 'protect', wake: { time: '08:00', range: 30 }, bedShift: { pace: 'steady', startedAt: T0, fromMin: 21 * 60 } });
  const snap = store.pendingSnapshot().profile;
  assert.equal(snap.settings.bedtime, '20:30');
  assert.equal(snap.settings.priority, 'protect');
  assert.deepEqual(snap.settings.wake, { time: '08:00', range: 30 });
  assert.equal(snap.settings.bedShift.pace, 'steady');
  assert.equal(snap.settings.wakeShift, null);
  // Rubbish is refused rather than stored.
  store.setSettings({ priority: 'chaos', wake: { time: 'soon' }, bedShift: { pace: 'warp' }, bedtime: 'late' });
  assert.equal(store.state.settings.priority, null);
  assert.equal(store.state.settings.wake, null);
  assert.equal(store.state.settings.bedShift, null);
  assert.equal(store.state.settings.bedtime, null);
});

test('a profile from an older phone (only bedtime) cannot erase newer settings; a newer profile replaces them', () => {
  const { store } = mk();
  store.setBaby({ name: 'Mia', birth: at(2026, 7, 25) });
  store.setSettings({ bedtime: '20:30', priority: 'wake', wake: { time: '08:00', range: 45 } });
  store.ackPending(store.pendingSnapshot());
  const stamp = store.state.profileAt;
  store.applyRemote({ profile: { baby: { name: 'Mia', birth: at(2026, 7, 25) }, settings: { bedtime: '21:00' }, updatedAt: stamp + 10 } });
  assert.equal(store.state.settings.bedtime, '21:00', 'what it did send is taken');
  assert.equal(store.state.settings.priority, 'wake', 'what it did not know about is kept');
  assert.deepEqual(store.state.settings.wake, { time: '08:00', range: 45 });
  store.applyRemote({ profile: { baby: { name: 'Mia', birth: at(2026, 7, 25) }, settings: { bedtime: '21:00', priority: null, wake: null }, updatedAt: stamp + 20 } });
  assert.equal(store.state.settings.priority, null, 'an explicit clear is honoured');
  assert.equal(store.state.settings.wake, null);
});

test('"fell asleep early" flags are kept on a sleep through edits and ending it, and exported', () => {
  const { t, store } = mk();
  const planned = T0 + 30 * MIN;
  t.now = T0 + 10 * MIN;
  const s = store.startSleep('nap', t.now, { early: true, planned });
  assert.deepEqual(s.flags, { early: true, planned });
  t.now += 40 * MIN;
  store.endSleep();
  store.updateSleep(store.state.sleeps[0].id, { notes: 'rocked' });
  assert.deepEqual(store.state.sleeps[0].flags, { early: true, planned });
  assert.deepEqual(store.pendingSnapshot().sleeps[0].flags, { early: true, planned });
  assert.match(store.exportJSON(), /"early": true/);
  // Junk flags are ignored.
  assert.equal(store.addSleep({ ...nap(15, 0), flags: { early: 'yes', planned: 'x' } }).flags, undefined);
});

test('a server that predates flags does not wipe the flags this phone already has', () => {
  const { t, store } = mk();
  t.now = T0;
  const s = store.startSleep('nap', T0, { early: true, planned: T0 + 20 * MIN });
  t.now += 30 * MIN;
  store.endSleep();
  store.ackPending(store.pendingSnapshot());
  const mine = store.state.sleeps[0];
  // Another phone ends up editing the note; its record (from the old server) has no `flags` key at all.
  store.applyRemote({ sleeps: [{ id: mine.id, start: mine.start, end: mine.end, kind: 'nap', notes: 'edited elsewhere', deleted: false, updatedAt: mine.updatedAt + 5 }] });
  assert.equal(store.state.sleeps[0].notes, 'edited elsewhere');
  assert.deepEqual(store.state.sleeps[0].flags, { early: true, planned: s.flags.planned });
  // A server that supports flags and says "none" does clear them.
  store.applyRemote({ sleeps: [{ id: mine.id, start: mine.start, end: mine.end, kind: 'nap', notes: 'edited elsewhere', flags: null, deleted: false, updatedAt: mine.updatedAt + 9 }] });
  assert.equal(store.state.sleeps[0].flags, undefined);
});
