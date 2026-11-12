import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts, planAlert, dataBasis, pushSupport, urlBase64ToUint8Array } from '../src/alerts.js';
import { predict } from '../src/predict.js';
import { createStore } from '../src/store.js';
import { createSync, createRemote } from '../src/sync.js';
import { MIN, HOUR } from '../src/time.js';
import { at, generateRhythm } from './helpers.js';

let createBackend;
try {
  ({ createBackend } = await import('./pg-bridge.js'));
  await import('@electric-sql/pglite');
} catch {
  createBackend = null;
}
const skip = createBackend ? false : 'run `npm install` to enable the sync tests (@electric-sql/pglite)';

const PUB = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const PRIV = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const P256DH = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

/* ------------------------------------------------------------------ */
/* What to tell the phones                                             */
/* ------------------------------------------------------------------ */

const D = (h, m = 0) => at(2026, 10, 10, h, m);
const BABY = { name: 'Scottie', birth: at(2026, 7, 30) };
const night = { id: 'n', start: D(7) - 9 * HOUR, end: D(7), kind: 'night', notes: '' };
const history = () => generateRhythm({ endDay: at(2026, 10, 10), days: 14, seed: 11, window: () => 65, napLen: () => 35 });

test('while she is awake and a nap is next, the alert is for when the sweet spot starts', () => {
  const wake = D(11, 5);
  const sleeps = [...history(), night, { id: 'a', start: D(10, 20), end: wake, kind: 'nap', notes: '' }];
  const now = wake + 3 * MIN;
  const p = predict({ sleeps, baby: BABY, now });
  assert.equal(p.mode, 'awake');
  const plan = planAlert({ prediction: p, baby: BABY, now });
  assert.equal(plan.action, 'set');
  assert.equal(plan.fireAt % MIN, 0, 'to the minute');
  assert.ok(Math.abs(plan.fireAt - p.next.earliest) <= 30_000, 'when the sweet spot starts');
  assert.ok(plan.fireAt > now);
  assert.equal(plan.title, "Scottie's nap sweet spot is starting");
  assert.match(plan.body, /^Nap \d: sweet spot \d{1,2}:\d{2} [AP]M–\d{1,2}:\d{2} [AP]M, best around \d{1,2}:\d{2} [AP]M\. Scottie woke at 11:05 AM\.$/);
  assert.ok(plan.body.length < 300);
});

test('no alert while she sleeps, when bedtime is next, or when the sweet spot is already here', () => {
  const wake = D(11, 5);
  const base = [...history(), night, { id: 'a', start: D(10, 20), end: wake, kind: 'nap', notes: '' }];
  const awake = predict({ sleeps: base, baby: BABY, now: wake + 3 * MIN });
  const asleep = predict({ sleeps: [...base, { id: 'b', start: D(12, 15), end: null, kind: 'nap', notes: '' }], baby: BABY, now: D(12, 30) });
  assert.equal(asleep.mode, 'asleep');
  assert.deepEqual(planAlert({ prediction: asleep, baby: BABY, now: D(12, 30) }), { action: 'clear' });

  // The sweet spot has started (or is in the past): Today already shows it, so there is nothing to announce.
  assert.deepEqual(planAlert({ prediction: awake, baby: BABY, now: awake.next.earliest + MIN }), { action: 'clear' });
  assert.deepEqual(planAlert({ prediction: awake, baby: BABY, now: awake.next.earliest - 10_000 }), { action: 'clear' });
  assert.equal(planAlert({ prediction: awake, baby: BABY, now: awake.next.earliest - 5 * MIN }).action, 'set');

  const evening = { ...awake, next: { ...awake.next, kind: 'bedtime' } };
  assert.deepEqual(planAlert({ prediction: evening, baby: BABY, now: wake }), { action: 'clear' });
  assert.deepEqual(planAlert({ prediction: { mode: 'stale' }, baby: BABY, now: wake }), { action: 'clear' });
  assert.deepEqual(planAlert({ prediction: { mode: 'night-awake' }, baby: BABY, now: wake }), { action: 'clear' });
  assert.deepEqual(planAlert({ prediction: awake, baby: BABY, now: awake.next.earliest - 9 * HOUR }), { action: 'clear' }, 'too far ahead to announce');
});

test('a short bridge nap is called that, and a missing name still reads fine', () => {
  const next = { kind: 'nap', number: 6, bridge: true, earliest: D(17, 10), at: D(17, 25), latest: D(17, 40) };
  const plan = planAlert({ prediction: { mode: 'awake', next, awakeSince: D(16, 20) }, baby: { name: '  ' }, now: D(17) });
  assert.equal(plan.title, "Baby's nap sweet spot is starting");
  assert.match(plan.body, /^Short bridge nap: sweet spot 5:10 PM–5:40 PM, best around 5:25 PM\. Baby woke at 4:20 PM\.$/);
});

test('how new the data behind an alert is counts edits, deletes and settings', () => {
  const state = { profileAt: 50, sleeps: [{ updatedAt: 10 }, { updatedAt: 70 }], tombstones: { x: 90 } };
  assert.equal(dataBasis(state), 90);
  assert.equal(dataBasis({ ...state, tombstones: {} }), 70);
  assert.equal(dataBasis({ profileAt: 0, sleeps: [], tombstones: {} }), 0);
});

test('this phone can get push notifications, or the reason it cannot is clear', () => {
  const win = { PushManager: {}, Notification: {}, matchMedia: () => ({ matches: false }) };
  const nav = (over = {}) => ({ serviceWorker: {}, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome', ...over });
  assert.equal(pushSupport({ win, nav: nav() }), 'ok');
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari' };
  assert.equal(pushSupport({ win, nav: nav(iphone) }), 'ios-install', 'a Safari tab on iPhone cannot, only the Home Screen app');
  assert.equal(pushSupport({ win: { ...win, matchMedia: () => ({ matches: true }) }, nav: nav(iphone) }), 'ok');
  assert.equal(pushSupport({ win, nav: nav({ ...iphone, standalone: true }) }), 'ok');
  assert.equal(pushSupport({ win: { matchMedia: win.matchMedia }, nav: nav({ ...iphone, standalone: true }) }), 'ios-old');
  assert.equal(pushSupport({ win: { matchMedia: win.matchMedia }, nav: nav() }), 'unsupported');
  assert.equal(pushSupport({ win, nav: {} }), 'unsupported');
  assert.equal(pushSupport({}), 'unsupported');
  assert.deepEqual([...urlBase64ToUint8Array('AQID')], [1, 2, 3]);
  assert.equal(urlBase64ToUint8Array(PUB).length, 65);
});

/* ------------------------------------------------------------------ */
/* The phone's half, against the real database script                  */
/* ------------------------------------------------------------------ */

const memoryStorage = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
};

/** A phone with sync, an alerts controller and a stand-in for the browser's push API. */
function phone(backend, { clock = at(2026, 10, 10, 8, 0), permission = 'granted', ios = false, standalone = true } = {}) {
  const storage = memoryStorage();
  const p = { clock: { now: clock }, scenario: { mode: 'awake' } };
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

  p.subscription = null;
  p.permission = { value: permission };
  const makeSub = (key) => ({
    endpoint: 'https://push.example.test/this-phone',
    options: { applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) },
    toJSON() {
      return { endpoint: this.endpoint, keys: { p256dh: P256DH, auth: AUTH } };
    },
    async unsubscribe() {
      p.subscription = null;
      return true;
    },
  });
  const reg = {
    pushManager: {
      getSubscription: async () => p.subscription,
      subscribe: async ({ applicationServerKey, userVisibleOnly }) => {
        assert.equal(userVisibleOnly, true, 'browsers only allow pushes that show something');
        return (p.subscription = makeSub(applicationServerKey));
      },
    },
  };
  const win = {
    PushManager: {},
    matchMedia: () => ({ matches: standalone }),
    Notification: {
      get permission() {
        return p.permission.value;
      },
      requestPermission: async () => p.permission.value,
    },
  };
  const nav = { serviceWorker: { ready: Promise.resolve(reg) }, userAgent: ios ? 'iPhone' : 'Chrome', standalone };

  // The prediction is canned here (the predictor has its own tests); this checks the wiring.
  const predictStub = () => {
    const t = Date.now();
    return p.scenario.mode === 'awake'
      ? { mode: 'awake', awakeSince: t - 5 * MIN, next: { kind: 'nap', number: 2, bridge: false, earliest: t + 50 * MIN, at: t + 62 * MIN, latest: t + 74 * MIN } }
      : { mode: 'asleep' };
  };
  p.alerts = createAlerts({ store: p.store, sync: p.sync, predict: predictStub, env: { win, nav }, debounce: 5 });
  return p;
}

const rows = (backend, sql, params) => backend.admin(sql, params).then((r) => r.rows);
const alertRow = async (backend, kind = 'nap') => (await rows(backend, 'select * from public.naps_alerts where kind = $1', [kind]))[0];
async function installKeys(backend) {
  const secret = (await rows(backend, 'select tick_secret from public.naps_push_config'))[0].tick_secret;
  await backend.service('naps_push_keys_set', { p_secret: secret, p_public: PUB, p_private: PRIV });
}
async function family(backend, opts) {
  const a = phone(backend, opts);
  a.store.setBaby({ name: 'Scottie', birth: at(2026, 7, 30) });
  const invite = await a.sync.enable({ url: 'http://localhost:54321', key: 'sb_publishable_testkey' });
  return { a, invite };
}

test('before the database script is run, the card asks for step 1 and the phone stops asking', { skip }, async () => {
  const backend = await createBackend(); // no push.sql
  const { a } = await family(backend);
  await a.alerts.refresh();
  assert.equal(a.alerts.state.phase, 'needs-db');
  const before = backend.calls.length;
  await a.alerts.run();
  await a.alerts.run();
  assert.equal(backend.calls.length, before, 'no repeated calls to something that is not installed');
});

test('the phone gives the database the project address, so nobody has to type it into SQL', { skip }, async () => {
  const url = 'https://abcdefghijklmnopqrst.supabase.co';
  const backend = await createBackend({ url, push: true });
  const p = phone(backend);
  p.store.setBaby({ name: 'Scottie', birth: at(2026, 7, 30) });
  await p.sync.enable({ url, key: 'sb_publishable_testkey' });
  assert.equal((await rows(backend, 'select project_url from public.naps_push_config'))[0].project_url, null);
  await p.alerts.refresh();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await rows(backend, 'select project_url from public.naps_push_config'))[0].project_url, url);
  assert.equal(p.alerts.state.phase, 'needs-function');
  const calls = backend.calls.filter((c) => c.name === 'naps_push_set_url').length;
  await p.alerts.refresh();
  assert.equal(backend.calls.filter((c) => c.name === 'naps_push_set_url').length, calls, 'once per session');
});

test('with sync off there is nothing to set up yet', { skip }, async () => {
  const backend = await createBackend({ push: true });
  const p = phone(backend);
  await p.alerts.refresh();
  assert.equal(p.alerts.state.phase, 'off');
});

test('after the SQL but before the function has run, the card asks for step 2; once the key exists it is ready', { skip }, async () => {
  const backend = await createBackend({ push: true });
  const { a } = await family(backend);
  await a.alerts.refresh();
  assert.equal(a.alerts.state.phase, 'needs-function');
  await installKeys(backend);
  await a.alerts.refresh();
  assert.equal(a.alerts.state.phase, 'ready');
});

test('turning alerts on: asks permission, subscribes with the server key, tells the database; off undoes it', { skip }, async () => {
  const backend = await createBackend({ push: true });
  await installKeys(backend);
  const { a } = await family(backend);
  await a.alerts.refresh();
  assert.equal(a.alerts.state.phase, 'ready');

  await a.alerts.enable();
  assert.equal(a.alerts.state.phase, 'on');
  assert.deepEqual(new Uint8Array(a.subscription.options.applicationServerKey), urlBase64ToUint8Array(PUB), 'subscribed with the key the function made');
  const subs = await rows(backend, 'select family_id, endpoint, p256dh, auth from public.naps_push_subs');
  assert.deepEqual(subs, [{ family_id: a.sync.family, endpoint: 'https://push.example.test/this-phone', p256dh: P256DH, auth: AUTH }]);

  // Closing and reopening the app keeps it on, and re-registers if the database forgot this phone.
  await backend.admin('delete from public.naps_push_subs');
  await a.alerts.refresh();
  assert.equal(a.alerts.state.phase, 'on');
  assert.equal((await rows(backend, 'select 1 from public.naps_push_subs')).length, 1);

  await a.alerts.disable();
  assert.equal(a.alerts.state.phase, 'ready');
  assert.equal(a.subscription, null);
  assert.equal((await rows(backend, 'select 1 from public.naps_push_subs')).length, 0);
});

test('permission refused: nothing is turned on, and the message says where to fix it', { skip }, async () => {
  const backend = await createBackend({ push: true });
  await installKeys(backend);
  const { a } = await family(backend, { permission: 'denied' });
  await a.alerts.refresh();
  await a.alerts.enable();
  assert.equal(a.alerts.state.phase, 'ready');
  assert.match(a.alerts.state.message, /blocked.*Settings.*Notifications/);
  assert.equal(a.subscription, null);
  assert.equal((await rows(backend, 'select 1 from public.naps_push_subs')).length, 0);
  assert.equal(a.alerts.state.busy, false);
});

test('an iPhone that has not been added to the Home Screen is told how', { skip }, async () => {
  const backend = await createBackend({ push: true });
  await installKeys(backend);
  const { a } = await family(backend, { ios: true, standalone: false });
  await a.alerts.refresh();
  assert.equal(a.alerts.state.phase, 'ready');
  assert.equal(a.alerts.state.support, 'ios-install');
});

test('a subscription made for an older key is replaced', { skip }, async () => {
  const backend = await createBackend({ push: true });
  await installKeys(backend);
  const { a } = await family(backend);
  a.subscription = { endpoint: 'https://push.example.test/old', options: { applicationServerKey: new Uint8Array(65).buffer }, toJSON: () => ({}), unsubscribe: async () => { a.subscription = null; } };
  await a.alerts.refresh();
  await a.alerts.enable();
  assert.equal(a.alerts.state.phase, 'on');
  assert.equal(a.subscription.endpoint, 'https://push.example.test/this-phone');
  assert.deepEqual(new Uint8Array(a.subscription.options.applicationServerKey), urlBase64ToUint8Array(PUB));
});

test('logging a wake-up leaves a note for the family; falling asleep cancels it; the same news is not sent twice', { skip }, async () => {
  const backend = await createBackend({ push: true });
  const { a } = await family(backend);

  await a.sync.syncNow();
  await a.alerts.run();
  const set = await alertRow(backend);
  assert.equal(set.active, true);
  assert.ok(Math.abs(set.fire_at - (Date.now() + 50 * MIN)) < 5 * MIN, 'when the sweet spot starts');
  assert.equal(set.title, "Scottie's nap sweet spot is starting");
  assert.equal(Number(set.basis), dataBasis(a.store.state));

  const calls = backend.calls.length;
  await a.alerts.run();
  assert.equal(backend.calls.length, calls, 'nothing new, nothing sent');

  // A nap starts on this phone: the note is cancelled for everyone.
  a.clock.now += MIN;
  a.store.startSleep('nap', a.clock.now);
  a.scenario.mode = 'asleep';
  await a.sync.syncNow();
  await a.alerts.run();
  assert.equal((await alertRow(backend)).active, false);
});

test('a phone that has not caught up cannot bring back an alert that was cancelled', { skip }, async () => {
  const backend = await createBackend({ push: true });
  const { a, invite } = await family(backend);
  const b = phone(backend);
  await b.sync.join(invite);
  await b.sync.syncNow();

  // A logs a nap start and cancels the alert; B has not heard yet and still thinks she is awake.
  a.clock.now += 10 * MIN;
  a.store.startSleep('nap', a.clock.now);
  a.scenario.mode = 'asleep';
  await a.sync.syncNow();
  await a.alerts.run();
  assert.equal((await alertRow(backend)).active, false);

  await b.alerts.run(); // B: scenario awake, older data
  assert.equal((await alertRow(backend)).active, false, 'the older note is refused');

  // Once B has caught up it agrees with A.
  await b.sync.syncNow();
  assert.ok(b.store.ongoing);
  b.scenario.mode = 'asleep';
  await b.alerts.run();
  assert.equal((await alertRow(backend)).active, false);
});

test('a phone with unsynced changes stays quiet until they are saved', { skip }, async () => {
  const backend = await createBackend({ push: true });
  const { a } = await family(backend);
  a.store.addSleep({ start: at(2026, 10, 10, 6, 0), end: at(2026, 10, 10, 6, 40), kind: 'nap' });
  assert.ok(a.store.hasPending());
  await a.alerts.run();
  assert.equal(await alertRow(backend), undefined);
  await a.sync.syncNow();
  await a.alerts.run();
  assert.equal((await alertRow(backend)).active, true);
});

test('a test alert goes out to every phone with alerts on, without disturbing the real schedule', { skip }, async () => {
  const backend = await createBackend({ push: true });
  await installKeys(backend);
  const { a } = await family(backend);
  await a.sync.syncNow();
  await a.alerts.refresh();
  await a.alerts.run();
  await a.alerts.test();
  assert.match(a.alerts.state.message, /Test sent/);
  const test = await alertRow(backend, 'test');
  assert.equal(test.title, 'Napberry test alert');
  assert.ok(Math.abs(test.fire_at - Date.now()) < 10_000);
  assert.equal((await alertRow(backend, 'nap')).active, true, 'the real schedule is untouched');
});
