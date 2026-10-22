import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createSync, createRemote, encodeInvite, parseInvite, newFamilyCode, normalizeUrl, isFamilyCode, SyncError } from '../src/sync.js';
import { MIN } from '../src/time.js';
import { at } from './helpers.js';

let createBackend;
try {
  ({ createBackend } = await import('./pg-bridge.js'));
  await import('@electric-sql/pglite');
} catch {
  createBackend = null;
}
const skip = createBackend ? false : 'run `npm install` to enable the sync tests (@electric-sql/pglite)';

const memoryStorage = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
};

/** A simulated phone: its own storage, its own (settable) clock, and a sync engine pointed at `backend`. */
function phone(backend, startTime) {
  const storage = memoryStorage();
  const p = { storage, clock: { now: startTime } };
  const boot = () => {
    p.store = createStore(storage, { clock: () => p.clock.now });
    p.sync = createSync({
      store: p.store,
      storage,
      clock: () => p.clock.now,
      doc: null,
      win: null,
      pushDelay: null,
      makeRemote: (cfg) => createRemote({ ...cfg, fetch: (u, i) => backend.fetch(u, i) }),
    });
  };
  boot();
  p.reload = boot; // "close and reopen the app": same storage, fresh objects
  p.tick = (min) => (p.clock.now += min * MIN);
  return p;
}

const T0 = at(2026, 10, 10, 8, 0);
const MIA = { name: 'Mia', birth: at(2026, 3, 10) };
const ids = (p) => p.store.state.sleeps.map((s) => s.id);
const nap = (h, m, len = 60, extra = {}) => ({ start: at(2026, 10, 10, h, m), end: at(2026, 10, 10, h, m) + len * MIN, kind: 'nap', ...extra });

let backend;
let setup;
before(async () => {
  if (skip) return;
  setup = { url: 'http://localhost:54321', key: 'sb_publishable_testkey' };
});
const fresh = async (opts) => (backend = await createBackend(opts));

test('invite codes round-trip and reject junk', () => {
  const family = newFamilyCode();
  assert.ok(isFamilyCode(family) && family.length === 22);
  assert.notEqual(newFamilyCode(), family);
  const invite = encodeInvite({ url: 'https://abc.supabase.co', key: 'sb_publishable_x', family });
  assert.deepEqual(parseInvite(invite), { url: 'https://abc.supabase.co', key: 'sb_publishable_x', family });
  assert.deepEqual(parseInvite(`  see https://napberry.example/#join=${invite}\n`), { url: 'https://abc.supabase.co', key: 'sb_publishable_x', family });
  for (const bad of ['', null, 'hello', 'nb1.', 'nb1.!!!', 'nb1.' + Buffer.from('{"u":"http://evil.com","k":"k","f":"x"}').toString('base64url'), 'nb1.' + Buffer.from(JSON.stringify({ u: 'https://a.co', k: '', f: family })).toString('base64url')]) {
    assert.equal(parseInvite(bad), null, String(bad));
  }
});

test('normalizeUrl accepts https (and http only for localhost)', () => {
  assert.equal(normalizeUrl('https://abc.supabase.co/'), 'https://abc.supabase.co');
  assert.equal(normalizeUrl(' https://abc.supabase.co/rest/v1/ '), 'https://abc.supabase.co');
  assert.equal(normalizeUrl('http://localhost:54321'), 'http://localhost:54321');
  assert.equal(normalizeUrl('http://abc.supabase.co'), null);
  assert.equal(normalizeUrl('abc.supabase.co'), null);
  assert.equal(normalizeUrl(''), null);
});

test('first phone turns sync on; a second phone joins and gets the baby and the history', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  a.store.setSettings({ bedtime: '19:30' });
  a.store.mergeSleeps([nap(9, 0), nap(12, 0), nap(15, 0, 40, { source: 'huckleberry' })]);
  const invite = await a.sync.enable(setup);
  assert.ok(invite.startsWith('nb1.'));
  assert.equal(a.sync.status.state, 'ok');
  assert.equal(a.store.hasPending(), false);

  const b = phone(backend, T0 + 5 * MIN);
  assert.equal(b.store.state.baby, null);
  await b.sync.join(invite);
  assert.deepEqual(b.store.state.baby, MIA);
  assert.equal(b.store.state.settings.bedtime, '19:30');
  assert.deepEqual(ids(b), ids(a));
  assert.equal(b.store.state.sleeps[2].source, 'huckleberry');
  assert.equal(b.store.hasPending(), false);
});

test('a nap started on one phone shows up on the other, which can end it', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  const invite = await a.sync.enable(setup);
  const b = phone(backend, T0);
  await b.sync.join(invite);

  a.tick(10);
  a.store.startSleep('nap');
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.equal(b.store.ongoing?.start, a.store.ongoing?.start);

  b.tick(55); // B's clock started at T0, A's nap began at T0 + 10 min
  b.store.endSleep();
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.equal(a.store.ongoing, null);
  assert.equal(a.store.state.sleeps.length, 1);
  assert.equal(a.store.state.sleeps[0].end - a.store.state.sleeps[0].start, 45 * MIN);
});

test('deleting a sleep removes it everywhere and a stale phone cannot bring it back', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  a.store.mergeSleeps([nap(9, 0), nap(12, 0)]);
  const invite = await a.sync.enable(setup);
  const b = phone(backend, T0);
  await b.sync.join(invite);
  const c = phone(backend, T0);
  await c.sync.join(invite);

  a.tick(30);
  a.store.removeSleep(ids(a)[0]);
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.equal(b.store.state.sleeps.length, 1);

  // C never synced after the delete, and edits that same sleep earlier in time (stale).
  c.clock.now = T0 + 1 * MIN;
  c.store.updateSleep(ids(c)[0], { notes: 'old edit' });
  await c.sync.syncNow();
  assert.equal(c.store.state.sleeps.length, 1, 'the delete reached C; stale edit lost');
  const check = phone(backend, T0 + 90 * MIN);
  await check.sync.join(invite);
  assert.equal(check.store.state.sleeps.length, 1);
});

test('works offline: changes queue up (even across an app restart) and upload later', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  const invite = await a.sync.enable(setup);
  const b = phone(backend, T0);
  await b.sync.join(invite);

  backend.down = true;
  a.tick(5);
  a.store.startSleep('nap');
  a.tick(40);
  a.store.endSleep();
  a.store.addSleep(nap(14, 0));
  assert.equal(await a.sync.syncNow(), false);
  assert.equal(a.sync.status.state, 'offline');
  assert.equal(a.store.hasPending(), true);

  a.reload(); // app closed and reopened while still offline
  assert.equal(a.store.hasPending(), true);
  assert.equal(a.store.state.sleeps.length, 2);
  assert.equal(a.sync.enabled, true, 'sync config survives a restart');

  backend.down = false;
  assert.equal(await a.sync.syncNow(), true);
  assert.equal(a.store.hasPending(), false);
  await b.sync.syncNow();
  assert.deepEqual(ids(b), ids(a));
});

test('simultaneous edits: the most recent edit wins on every phone', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  a.store.mergeSleeps([nap(9, 0)]);
  const invite = await a.sync.enable(setup);
  const b = phone(backend, T0);
  await b.sync.join(invite);
  const id = ids(a)[0];

  a.tick(10);
  a.store.updateSleep(id, { notes: 'from A' });
  b.tick(20);
  b.store.updateSleep(id, { notes: 'from B (later)' });
  await b.sync.syncNow(); // B reaches the server first...
  await a.sync.syncNow(); // ...but A's edit is older, so it doesn't win
  await b.sync.syncNow();
  assert.equal(a.store.state.sleeps[0].notes, 'from B (later)');
  assert.equal(b.store.state.sleeps[0].notes, 'from B (later)');
});

test('a phone with a slow clock still sees changes from a phone with a fast clock (and vice versa)', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  const invite = await a.sync.enable(setup);
  const slow = phone(backend, T0 - 30 * MIN);
  await slow.sync.join(invite);

  // Order of arrival at the server, not device clocks, decides what each phone fetches next.
  a.tick(60);
  a.store.addSleep(nap(9, 0));
  await a.sync.syncNow();
  slow.store.addSleep(nap(12, 0)); // stamped 30 minutes "in the past" compared with A
  await slow.sync.syncNow();
  await a.sync.syncNow();
  assert.equal(a.store.state.sleeps.length, 2);
  assert.equal(slow.store.state.sleeps.length, 2);
});

test('two phones both start a nap before syncing: keeps the first, both converge', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  const invite = await a.sync.enable(setup);
  const b = phone(backend, T0);
  await b.sync.join(invite);

  a.tick(30);
  a.store.startSleep('nap');
  b.tick(33);
  b.store.startSleep('nap');
  await a.sync.syncNow();
  await b.sync.syncNow();
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.equal(a.store.state.sleeps.length, 1);
  assert.equal(b.store.state.sleeps.length, 1);
  assert.equal(a.store.ongoing.start, T0 + 30 * MIN);
  assert.equal(b.store.ongoing.start, T0 + 30 * MIN);
});

test('renaming the baby on one phone updates the other', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  const invite = await a.sync.enable(setup);
  const b = phone(backend, T0);
  await b.sync.join(invite);
  b.tick(10);
  b.store.setBaby({ ...MIA, name: 'Mia Rose' });
  b.store.setSettings({ bedtime: '20:00' });
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.equal(a.store.state.baby.name, 'Mia Rose');
  assert.equal(a.store.state.settings.bedtime, '20:00');
});

test('joining with data already on the phone merges it in; the family profile wins', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  a.store.mergeSleeps([nap(9, 0), nap(12, 0)]);
  const invite = await a.sync.enable(setup);

  const b = phone(backend, T0 + 60 * MIN);
  b.store.setBaby({ name: 'Typed again', birth: at(2026, 1, 1) });
  b.store.mergeSleeps([nap(12, 0), nap(15, 0)]); // one overlaps with A's, one is new
  await b.sync.join(invite);
  assert.equal(b.store.state.baby.name, 'Mia');
  assert.equal(b.store.state.sleeps.length, 3);
  await a.sync.syncNow();
  assert.equal(a.store.state.sleeps.length, 3);
});

test('re-importing the same Huckleberry file on a second phone does not duplicate', { skip }, async () => {
  await fresh();
  const rows = [nap(9, 0), nap(12, 0), nap(15, 0)].map((s) => ({ ...s, source: 'huckleberry' }));
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  const invite = await a.sync.enable(setup);
  const b = phone(backend, T0);
  await b.sync.join(invite);
  a.store.mergeSleeps(rows);
  b.store.mergeSleeps(rows);
  await a.sync.syncNow();
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.equal(a.store.state.sleeps.length, 3);
  assert.equal(b.store.state.sleeps.length, 3);
});

test('editing a start time moves the sleep without leaving a copy behind', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  a.store.mergeSleeps([nap(9, 0)]);
  const invite = await a.sync.enable(setup);
  const b = phone(backend, T0);
  await b.sync.join(invite);

  a.tick(5);
  const moved = a.store.updateSleep(ids(a)[0], { start: at(2026, 10, 10, 9, 20), end: at(2026, 10, 10, 10, 20) });
  assert.ok(moved);
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.equal(b.store.state.sleeps.length, 1);
  assert.equal(b.store.state.sleeps[0].start, at(2026, 10, 10, 9, 20));
});

test('bad keys, unset-up databases and bad invites give clear errors and change nothing', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  a.store.mergeSleeps([nap(9, 0)]);

  await assert.rejects(a.sync.enable({ url: setup.url, key: 'sb_publishable_wrong' }), (e) => e instanceof SyncError && e.kind === 'auth');
  await assert.rejects(a.sync.enable({ url: 'not a url', key: setup.key }), (e) => e.kind === 'setup');
  await assert.rejects(a.sync.enable({ url: setup.url, key: '' }), (e) => e.kind === 'auth');
  await assert.rejects(a.sync.join('hello'), (e) => e.kind === 'code');
  assert.equal(a.sync.enabled, false);

  // A Supabase project where setup.sql has not been run yet.
  await fresh({ install: false });
  await assert.rejects(a.sync.enable(setup), (e) => e.kind === 'setup' && /setup\.sql/.test(e.message));
  assert.equal(a.sync.enabled, false);

  // No connection at all: a failed join leaves nothing half-configured.
  backend.down = true;
  const b = phone(backend, T0);
  await assert.rejects(b.sync.join(encodeInvite({ url: setup.url, key: setup.key, family: newFamilyCode() })), (e) => e.kind === 'network');
  assert.equal(b.sync.enabled, false);
  assert.equal(a.store.state.sleeps.length, 1, 'local data untouched');
});

test('turning sync off keeps local data and stops talking to the server', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  a.store.mergeSleeps([nap(9, 0)]);
  await a.sync.enable(setup);
  const calls = backend.calls.length;
  a.sync.leave();
  assert.equal(a.sync.enabled, false);
  assert.equal(a.sync.invite(), null);
  await a.sync.syncNow();
  assert.equal(backend.calls.length, calls);
  assert.equal(a.store.state.sleeps.length, 1);
  a.reload();
  assert.equal(a.sync.enabled, false);
});

test('an idle sync costs one small request and does not re-download everything', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  a.store.mergeSleeps([nap(9, 0), nap(12, 0)]);
  await a.sync.enable(setup);
  const before = backend.calls.length;
  await a.sync.syncNow();
  const calls = backend.calls.slice(before);
  assert.deepEqual(calls.map((c) => c.name), ['naps_pull']);
  assert.ok(calls[0].body.p_cursor > 0, 'asks only for changes since the last cursor');
});

test('large uploads are split into several requests', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  const many = Array.from({ length: 1200 }, (_, i) => ({ start: at(2026, 1, 1) + i * 3 * 60 * MIN, end: at(2026, 1, 1) + i * 3 * 60 * MIN + 30 * MIN, kind: 'nap' }));
  a.store.mergeSleeps(many);
  await a.sync.enable(setup);
  const pushes = backend.calls.filter((c) => c.name === 'naps_push');
  assert.deepEqual(pushes.map((p) => p.body.p_sleeps.length), [500, 500, 200]);
  const b = phone(backend, T0);
  await b.sync.join(a.sync.invite());
  assert.equal(b.store.state.sleeps.length, 1200);
});

test('data saved by the first version of the app is upgraded and syncs', { skip }, async () => {
  await fresh();
  const storage = memoryStorage();
  // Shape written by v1: random ids, no timestamps.
  storage.setItem(
    'napberry:v1',
    JSON.stringify({
      baby: MIA,
      settings: { bedtime: null },
      sleeps: [
        { id: 'imp-1-2', start: at(2026, 10, 9, 9, 0), end: at(2026, 10, 9, 10, 0), kind: 'nap', notes: '', source: 'huckleberry' },
        { id: 'c0ffee-uuid', start: at(2026, 10, 9, 12, 0), end: at(2026, 10, 9, 13, 0), kind: 'nap', notes: 'mine' },
        { id: 'dupe', start: at(2026, 10, 9, 12, 0), end: at(2026, 10, 9, 13, 0), kind: 'nap', notes: '' },
      ],
    }),
  );
  const store = createStore(storage, { clock: () => T0 });
  assert.equal(store.state.version, 2);
  assert.equal(store.state.sleeps.length, 2);
  assert.ok(store.state.sleeps.every((s) => /^s\d+$/.test(s.id) && s.updatedAt > 0));
  assert.equal(JSON.parse(storage.getItem('napberry:v1')).version, 2, 'upgrade is saved');
});

test('schedule settings and "fell asleep early" notes travel between phones', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  a.store.setSettings({ bedtime: '20:30', priority: 'protect', wake: { time: '08:00', range: 30 }, bedShift: { pace: 'steady', startedAt: T0, fromMin: 21 * 60 } });
  const invite = await a.sync.enable(setup);
  const b = phone(backend, T0);
  await b.sync.join(invite);
  assert.equal(b.store.state.settings.bedtime, '20:30');
  assert.equal(b.store.state.settings.priority, 'protect');
  assert.deepEqual(b.store.state.settings.wake, { time: '08:00', range: 30 });
  assert.equal(b.store.state.settings.bedShift.fromMin, 21 * 60);

  a.tick(10);
  a.store.startSleep('nap', a.clock.now, { early: true, planned: a.clock.now + 25 * MIN });
  a.tick(40);
  a.store.endSleep();
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.deepEqual(b.store.state.sleeps[0].flags, { early: true, planned: T0 + 35 * MIN });
});

test('the profile already on a server (only a bedtime) joins a phone with no data loss', { skip }, async () => {
  await fresh();
  const old = phone(backend, T0);
  old.store.setBaby(MIA);
  old.store.setSettings({ bedtime: '22:00' });
  old.store.mergeSleeps([nap(9, 0), nap(12, 0)]);
  const invite = await old.sync.enable(setup);
  const fresh2 = phone(backend, T0 + 60 * MIN);
  await fresh2.sync.join(invite);
  assert.equal(fresh2.store.state.settings.bedtime, '22:00');
  assert.equal(fresh2.store.state.settings.priority, null);
  assert.equal(fresh2.store.state.sleeps.length, 2);
  assert.equal(old.store.state.sleeps.length, 2);
});

/** A phone whose server answers like the earlier database script: no `version` in pull responses. */
function phoneOnOldDatabase(be, startTime, state) {
  const storage = memoryStorage();
  const clock = { now: startTime };
  const store = createStore(storage, { clock: () => clock.now });
  const sync = createSync({
    store,
    storage,
    clock: () => clock.now,
    doc: null,
    win: null,
    pushDelay: null,
    makeRemote: (cfg) =>
      createRemote({
        ...cfg,
        fetch: async (u, i) => {
          const res = await be.fetch(u, i);
          if (state.old && String(u).endsWith('naps_pull') && res.ok) {
            const body = await res.json();
            delete body.version;
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return res;
        },
      }),
  });
  return { store, sync, storage };
}

test('the app notices when the Supabase script is older than it needs, and stops once it is updated', { skip }, async () => {
  await fresh();
  const state = { old: true };
  const a = phoneOnOldDatabase(backend, T0, state);
  a.store.setBaby(MIA);
  assert.equal(a.sync.dbOutdated, false, 'unknown until the first sync');
  await a.sync.enable(setup);
  assert.equal(a.sync.dbOutdated, true);
  assert.equal(a.sync.status.dbOutdated, true);

  // Still works, and keeps being flagged on later syncs.
  a.store.mergeSleeps([nap(9, 0)]);
  await a.sync.syncNow();
  assert.equal(a.sync.dbOutdated, true);
  assert.equal(a.sync.status.state, 'ok');

  // The script is re-run: the server now reports its version.
  state.old = false;
  await a.sync.syncNow();
  assert.equal(a.sync.dbOutdated, false);
  assert.equal(a.sync.status.dbOutdated, false);
  assert.equal(a.store.state.sleeps.length, 1);
});

test('an up-to-date database is never flagged; turning sync off clears the flag', { skip }, async () => {
  await fresh();
  const a = phone(backend, T0);
  a.store.setBaby(MIA);
  await a.sync.enable(setup);
  assert.equal(a.sync.dbOutdated, false);

  const state = { old: true };
  const b = phoneOnOldDatabase(backend, T0, state);
  b.store.setBaby(MIA);
  await b.sync.join(a.sync.invite());
  assert.equal(b.sync.dbOutdated, true);
  b.sync.leave();
  assert.equal(b.sync.dbOutdated, false);
});

test('the SQL editor link points at the connected Supabase project', () => {
  const storage = memoryStorage();
  const family = newFamilyCode();
  storage.setItem('napberry:sync:v1', JSON.stringify({ url: 'https://abcdefghijklmnop.supabase.co', key: 'sb_publishable_x', family, cursor: 0 }));
  const store = createStore(memoryStorage());
  const sync = createSync({ store, storage, doc: null, win: null, pushDelay: null });
  assert.equal(sync.sqlEditorUrl(), 'https://supabase.com/dashboard/project/abcdefghijklmnop/sql/new');
  const other = memoryStorage();
  other.setItem('napberry:sync:v1', JSON.stringify({ url: 'http://localhost:54321', key: 'k', family, cursor: 0 }));
  assert.equal(createSync({ store, storage: other, doc: null, win: null, pushDelay: null }).sqlEditorUrl(), null);
});
