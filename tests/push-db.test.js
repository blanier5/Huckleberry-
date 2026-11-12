import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Runs supabase/push.sql (the optional nap-alerts script) against a real in-process Postgres and
// uses it the way the public key would: as `anon`, through the functions only.
// Skipped when the dev dependency isn't installed (npm install).
let createBackend;
try {
  await import('@electric-sql/pglite');
  ({ createBackend } = await import('./pg-bridge.js'));
} catch {
  /* optional */
}
const skip = createBackend ? false : 'run `npm install` to enable the database tests (@electric-sql/pglite)';

const PUSH = fs.readFileSync(new URL('../supabase/push.sql', import.meta.url), 'utf8');
const FAM = 'abcdefghijklmnopqrstuv';
const OTHER = 'ZYXWVUTSRQPONMLKJIHGFE';
const P256DH = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const PUB = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const PRIV = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const sub = (n = 'a', over = {}) => ({ endpoint: `https://push.example.test/${n}`, keys: { p256dh: P256DH, auth: AUTH }, ...over });

let backend;
let db;
let secret;
const q = async (sql, params) => (await db.query(sql, params)).rows[0].r;
const subscribe = (s, fam = FAM) => q('select public.naps_push_subscribe($1, $2::jsonb) as r', [fam, JSON.stringify(s)]);
const alertSet = (fireAt, { kind = 'nap', title = 'Title', body = 'Body', basis = 1, fam = FAM } = {}) =>
  q('select public.naps_alert_set($1, $2, $3, $4, $5, $6) as r', [fam, kind, fireAt, title, body, basis]);
const alertClear = (basis, { kind = 'nap', fam = FAM } = {}) => q('select public.naps_alert_clear($1, $2, $3) as r', [fam, kind, basis]);
const row = async (kind = 'nap', fam = FAM) =>
  (await backend.admin('select * from public.naps_alerts where family_id = $1 and kind = $2', [fam, kind])).rows[0];
const claim = (s = secret) => backend.service('naps_alerts_claim', { p_secret: s });
const setKeys = () => backend.service('naps_push_keys_set', { p_secret: secret, p_public: PUB, p_private: PRIV });
const now = () => Date.now();

before(async () => {
  if (skip) return;
});

async function fresh() {
  backend = await createBackend({ push: true });
  db = backend.db;
  secret = (await backend.admin('select tick_secret from public.naps_push_config')).rows[0].tick_secret;
}

test('the script can be run again without losing the secret, the key or anyone who signed up', { skip }, async () => {
  await fresh();
  await setKeys();
  await subscribe(sub('a'));
  await alertSet(now() + 60_000);
  await backend.admin(PUSH);
  await backend.admin(PUSH);
  assert.equal((await backend.admin('select tick_secret from public.naps_push_config')).rows[0].tick_secret, secret);
  assert.equal((await q('select public.naps_push_key() as r')), PUB);
  assert.equal((await backend.admin('select count(*)::int as n from public.naps_push_subs')).rows[0].n, 1);
  assert.equal((await row()).active, true);
  assert.equal((await backend.admin('select count(*)::int as n from public.naps_push_config')).rows[0].n, 1);
});

test('the tables and the service-only functions are closed to the public key', { skip }, async () => {
  await fresh();
  for (const t of ['naps_push_config', 'naps_push_subs', 'naps_alerts']) {
    await assert.rejects(db.query(`select * from public.${t}`), /permission denied/, t);
  }
  await assert.rejects(db.query('select public.naps_alerts_claim($1)', [secret]), /permission denied/);
  await assert.rejects(db.query('select public.naps_push_keys_set($1, $2, $3)', [secret, PUB, PRIV]), /permission denied/);
  await assert.rejects(db.query("select public.naps_push_forget($1, '[]'::jsonb)", [secret]), /permission denied/);
  assert.equal(await q('select public.naps_push_key() as r'), null, 'no key until the function has run');
});

test('subscribing: valid phones are saved once; junk, other schemes and floods are refused', { skip }, async () => {
  await fresh();
  assert.deepEqual(await subscribe(sub('a')), { ok: true });
  await subscribe(sub('a')); // the same phone again
  assert.equal((await backend.admin('select count(*)::int as n from public.naps_push_subs')).rows[0].n, 1);

  const bad = [
    sub('b', { endpoint: 'http://push.example.test/b' }),
    sub('b', { endpoint: 'https://x' }),
    sub('b', { endpoint: `https://push.example.test/${'x'.repeat(700)}` }),
    sub('b', { keys: { p256dh: 'short', auth: AUTH } }),
    sub('b', { keys: { p256dh: P256DH, auth: 'x' } }),
    sub('b', { keys: {} }),
    { keys: { p256dh: P256DH, auth: AUTH } },
  ];
  for (const s of bad) await assert.rejects(subscribe(s), /invalid subscription/);
  await assert.rejects(q("select public.naps_push_subscribe($1, '\"text\"'::jsonb) as r", [FAM]), /invalid subscription/);
  await assert.rejects(subscribe(sub('a'), 'short'), /invalid family code/);

  for (let i = 0; i < 9; i++) await subscribe(sub(`phone${i}`));
  await assert.rejects(subscribe(sub('one-too-many')), /too many phones/);
  await subscribe(sub('a')); // an existing phone can still refresh itself
  assert.deepEqual(await q('select public.naps_push_unsubscribe($1, $2) as r', [FAM, 'https://push.example.test/a']), { ok: true });
  await subscribe(sub('one-too-many')); // room again
  await subscribe(sub('elsewhere'), OTHER);
  assert.equal((await backend.admin('select count(*)::int as n from public.naps_push_subs where family_id = $1', [OTHER])).rows[0].n, 1);
});

test('setting an alert: sane times and text only; a stale phone cannot overwrite newer data', { skip }, async () => {
  await fresh();
  const t = now();
  await assert.rejects(alertSet(t - 600_000), /out of range/);
  await assert.rejects(alertSet(t + 13 * 3600_000), /out of range/);
  await assert.rejects(alertSet(t + 60_000, { title: ' ' }), /needs a title/);
  await assert.rejects(alertSet(t + 60_000, { kind: 'bedtime' }), /invalid alert kind/);
  await assert.rejects(alertSet(t + 60_000, { fam: 'short' }), /invalid family code/);

  await alertSet(t + 60_000, { title: 'x'.repeat(500), body: 'y'.repeat(900), basis: 10 });
  const r = await row();
  assert.equal(r.title.length, 100);
  assert.equal(r.body.length, 300);

  await alertSet(t + 120_000, { title: 'newer', basis: 20 });
  assert.equal((await row()).title, 'newer');
  await alertSet(t + 30_000, { title: 'stale', basis: 15 });
  assert.equal((await row()).title, 'newer', 'a phone that has not caught up is ignored');
  await alertSet(t + 150_000, { title: 'same data again', basis: 20 });
  assert.equal((await row()).title, 'same data again', 'equal basis is fine: the same data gives the same answer');
});

test('clearing remembers how new the data was, so an old note cannot come back', { skip }, async () => {
  await fresh();
  const t = now();
  await alertSet(t + 60_000, { basis: 10 });
  await alertClear(20);
  assert.equal((await row()).active, false);
  await alertSet(t + 60_000, { basis: 15 });
  assert.equal((await row()).active, false, 'older than the clear: stays cleared');
  await alertSet(t + 60_000, { basis: 25 });
  assert.equal((await row()).active, true, 'newer data can set it again');
  await alertClear(5);
  assert.equal((await row()).active, true, 'an older clear is ignored');
  await alertClear(1, { fam: OTHER }); // nothing there yet: the basis is still remembered
  await alertSet(t + 60_000, { basis: 0, fam: OTHER });
  assert.equal((await row('nap', OTHER)).active, false);
});

test('an alert that was already sent is not sent again unless it changed', { skip }, async () => {
  await fresh();
  await setKeys();
  const t = now();
  await subscribe(sub('a'));
  await alertSet(t + 1, { basis: 1 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await claim()).alerts.length, 1);
  await alertSet(t + 1, { basis: 2 }); // identical note, newer data
  assert.ok((await row()).sent_at, 'still marked sent');
  assert.equal((await claim()).alerts.length, 0);
  await alertSet(t + 2, { basis: 3 }); // a different time is a new note
  assert.equal((await row()).sent_at, null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await claim()).alerts.length, 1);
});

test('claiming: needs the secret, waits for the key, returns only what is due, and only once', { skip }, async () => {
  await fresh();
  const t = now();
  assert.deepEqual(await claim('wrong'), { ok: false });
  assert.deepEqual(await claim(''), { ok: false });
  assert.equal((await claim()).needsKeys, true, 'nothing is sent before the key exists');

  await subscribe(sub('a'));
  await subscribe(sub('b'));
  await subscribe(sub('c'), OTHER);
  await alertSet(t + 1, { title: 'due', basis: 1 });
  await alertSet(t + 1, { title: 'test due', kind: 'test', basis: 1 });
  await alertSet(t + 600_000, { title: 'later', basis: 1, fam: OTHER });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal((await claim()).needsKeys, true, 'still no key, still nothing taken');
  assert.equal((await row()).sent_at, null);

  assert.deepEqual(await setKeys(), { ok: true });
  assert.deepEqual(await backend.service('naps_push_keys_set', { p_secret: secret, p_public: 'A'.repeat(87), p_private: 'B'.repeat(43) }), { ok: false }, 'the key is set once');
  assert.deepEqual(await backend.service('naps_push_keys_set', { p_secret: 'wrong', p_public: PUB, p_private: PRIV }), { ok: false });

  const first = await claim();
  assert.equal(first.ok, true);
  assert.deepEqual(first.vapid, { public: PUB, private: PRIV });
  assert.deepEqual(first.alerts.map((a) => [a.kind, a.title, a.subs.length]).sort(), [['nap', 'due', 2], ['test', 'test due', 2]]);
  assert.equal(first.alerts[0].subs[0].p256dh, P256DH);
  assert.deepEqual((await claim()).alerts, [], 'taken once');
  assert.equal((await row('nap', OTHER)).sent_at, null, 'not due yet: untouched');
});

test('late, cancelled and unwanted alerts are not sent', { skip }, async () => {
  await fresh();
  await setKeys();
  const t = now();
  await subscribe(sub('a'));
  await alertSet(t + 2, { title: 'cancelled', basis: 1 });
  await alertClear(2);
  await alertSet(t + 2, { title: 'old', kind: 'test', basis: 1 });
  await backend.admin("update public.naps_alerts set fire_at = $1 where kind = 'test'", [t - 20 * 60_000]); // 20 minutes late
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual((await claim()).alerts, []);

  await backend.service('naps_push_forget', { p_secret: secret, p_endpoints: ['https://push.example.test/a', 'https://push.example.test/missing'] });
  assert.equal((await backend.admin('select count(*)::int as n from public.naps_push_subs')).rows[0].n, 0);
  assert.deepEqual(await backend.service('naps_push_forget', { p_secret: 'wrong', p_endpoints: ['x'] }), { ok: false });
});

test('the app tells the database which project this is, and only a supabase.co address is accepted', { skip }, async () => {
  await fresh();
  const setUrl = (url, fam = FAM) => q('select public.naps_push_set_url($1, $2) as r', [fam, url]);
  const stored = async () => (await backend.admin('select project_url from public.naps_push_config')).rows[0].project_url;
  assert.equal(await stored(), null);
  assert.deepEqual(await setUrl('https://ipwwbfllwsczdhjyqtlq.supabase.co'), { ok: true });
  assert.equal(await stored(), 'https://ipwwbfllwsczdhjyqtlq.supabase.co');
  await setUrl('https://ipwwbfllwsczdhjyqtlq.supabase.co'); // again: nothing changes
  for (const bad of ['http://ipwwbfllwsczdhjyqtlq.supabase.co', 'https://ipwwbfllwsczdhjyqtlq.supabase.co/', 'https://ipwwbfllwsczdhjyqtlq.supabase.co/functions', 'https://evil.example.com', 'https://abc.supabase.co', 'https://ipwwbfllwsczdhjyqtlq.supabase.co.evil.com', 'https://IPWWBFLLWSCZDHJYQTLQ.supabase.co', null]) {
    await assert.rejects(setUrl(bad), /invalid project url/, String(bad));
  }
  await assert.rejects(setUrl('https://ipwwbfllwsczdhjyqtlq.supabase.co', 'short'), /invalid family code/);
  assert.equal(await stored(), 'https://ipwwbfllwsczdhjyqtlq.supabase.co', 'rejected values change nothing');
});

test('the schedule: needs no editing, survives missing extensions, waits for the project address, and only calls out when something is due', { skip }, async () => {
  await fresh();
  // The script as it stands, with no pg_cron or pg_net on this database: it still completes.
  await backend.admin(PUSH);

  // Stand-ins for pg_cron and pg_net, to see what the schedule would do every minute.
  await backend.admin(`
    create schema if not exists cron;
    create schema if not exists net;
    create table public.sched (name text, schedule text, command text);
    create table public.hits (url text, headers jsonb, body jsonb, timeout int);
    create function cron.schedule(job text, sched text, cmd text) returns bigint language sql as $$ insert into public.sched values (job, sched, cmd) returning 1::bigint $$;
    create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) returns bigint language sql as $$ insert into public.hits values (url, headers, body, timeout_milliseconds) returning 1::bigint $$;
  `);
  await backend.admin(PUSH);
  await backend.admin(PUSH);
  const jobs = (await backend.admin('select * from public.sched')).rows;
  assert.equal(jobs.length, 2, 'cron.schedule is called each run (pg_cron replaces a job of the same name)');
  assert.equal(jobs[0].name, 'napberry-alerts');
  assert.equal(jobs[0].schedule, '* * * * *');
  const command = jobs[0].command;

  const hits = async () => (await backend.admin('select * from public.hits')).rows;
  await backend.admin(command);
  assert.equal((await hits()).length, 0, 'the app has not said where the function lives yet');

  await q('select public.naps_push_set_url($1, $2) as r', [FAM, 'https://abcdefghijklmnopqrst.supabase.co']);
  await backend.admin(command);
  const boot = await hits();
  assert.equal(boot.length, 1, 'before the push key exists it wakes the function so it can make one');
  assert.equal(boot[0].url, 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/napberry-push');
  assert.equal(boot[0].headers['x-napberry-secret'], secret);
  assert.equal(boot[0].timeout, 30000);

  await setKeys();
  await backend.admin('delete from public.hits');
  await backend.admin(command);
  assert.equal((await hits()).length, 0, 'nothing due: the function is not woken');

  await alertSet(now() + 1);
  await new Promise((r) => setTimeout(r, 20));
  await backend.admin(command);
  assert.equal((await hits()).length, 1, 'an alert is due: wake it');

  await claim();
  await backend.admin('delete from public.hits');
  await backend.admin(command);
  assert.equal((await hits()).length, 0, 'sent: quiet again');
});

test('a database that already has the first version of the script is upgraded in place', { skip }, async () => {
  await fresh();
  // The first version had no project_url column. Put it back to that shape, with data in it.
  await setKeys();
  await subscribe(sub('a'));
  await backend.admin('alter table public.naps_push_config drop column project_url');
  await backend.admin(PUSH);
  assert.equal((await backend.admin('select project_url from public.naps_push_config')).rows[0].project_url, null);
  assert.equal(await q('select public.naps_push_key() as r'), PUB, 'the key survived');
  assert.equal((await backend.admin('select count(*)::int as n from public.naps_push_subs')).rows[0].n, 1);
});
