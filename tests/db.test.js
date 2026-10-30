import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Runs supabase/setup.sql against a real (in-process) Postgres and exercises it the way the
// public API key would: as the `anon` role, through the two functions only.
// Skipped when the dev dependency isn't installed (npm install).
let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  /* optional */
}
const skip = PGlite ? false : 'run `npm install` to enable the database tests (@electric-sql/pglite)';

const SETUP = fs.readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8');
const FAM = 'abcdefghijklmnopqrstuv'; // 22 chars
const OTHER = 'ZYXWVUTSRQPONMLKJIHGFE';
let db;

const pull = async (fam = FAM, cursor = 0) => (await db.query('select public.naps_pull($1, $2) as r', [fam, cursor])).rows[0].r;
const push = async (sleeps, profile = null, fam = FAM) =>
  (await db.query('select public.naps_push($1, $2::jsonb, $3::jsonb) as r', [fam, profile && JSON.stringify(profile), JSON.stringify(sleeps)])).rows[0].r;
const nap = (id, start, end, updatedAt, extra = {}) => ({ id, start, end, kind: 'nap', notes: '', source: null, deleted: false, updatedAt, ...extra });

before(async () => {
  if (skip) return;
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  await db.exec(SETUP);
  await db.exec(SETUP); // idempotent
  await db.exec('set role anon');
});

test('anon cannot touch the tables directly', { skip }, async () => {
  await assert.rejects(db.query('select * from public.naps_sleeps'), /permission denied/);
  await assert.rejects(db.query('insert into public.naps_sleeps(family_id,id,updated_at) values (\'x\',\'y\',1)'), /permission denied/);
  await assert.rejects(db.query('select * from public.naps_profiles'), /permission denied/);
  await assert.rejects(db.query("select nextval('public.naps_seq')"), /permission denied/);
});

test('rejects short or malformed family codes', { skip }, async () => {
  await assert.rejects(pull('short'), /invalid family code/);
  await assert.rejects(push([], null, 'has spaces and is long enough!!'), /invalid family code/);
  await assert.rejects(pull("x'; drop table naps_sleeps; --xxxxxxxxxxxxxxxx"), /invalid family code/);
});

test('empty family: no profile, no sleeps, cursor stays', { skip }, async () => {
  const r = await pull(FAM, 0);
  assert.deepEqual(r, { profile: null, sleeps: [], cursor: 0, version: 2 });
  assert.equal((await pull(FAM, 42)).cursor, 42);
});

test('push then pull round-trips sleeps and profile', { skip }, async () => {
  const profile = { baby: { name: 'Mia', birth: 1773100800000 }, settings: { bedtime: '19:30' }, updatedAt: 1000 };
  const res = await push([nap('s1', 1000000, 1003600000, 10), nap('s2', 2000000, null, 11, { source: 'huckleberry', notes: 'x' })], profile);
  assert.deepEqual(res, { saved: 2, skipped: 0 });
  const r = await pull();
  assert.equal(r.sleeps.length, 2);
  assert.deepEqual(r.sleeps[0], { id: 's1', start: 1000000, end: 1003600000, kind: 'nap', notes: '', source: null, flags: null, deleted: false, updatedAt: 10 });
  assert.equal(r.sleeps[1].end, null);
  assert.equal(r.sleeps[1].source, 'huckleberry');
  assert.deepEqual(r.profile, { baby: { name: 'Mia', birth: 1773100800000 }, settings: { bedtime: '19:30' }, updatedAt: 1000 });
  assert.ok(r.cursor > 0);
});

test('cursor returns only what changed since', { skip }, async () => {
  const first = await pull();
  assert.equal((await pull(FAM, first.cursor)).sleeps.length, 0);
  await push([nap('s3', 3000000, 3600000, 12)]);
  const next = await pull(FAM, first.cursor);
  assert.deepEqual(next.sleeps.map((s) => s.id), ['s3']);
  assert.ok(next.cursor > first.cursor);
});

test('last change wins; an older offline edit cannot overwrite a newer one', { skip }, async () => {
  await push([nap('s1', 1000000, 1003600000, 50, { notes: 'newer' })]);
  const res = await push([nap('s1', 1000000, 1003600000, 20, { notes: 'stale' })]);
  assert.deepEqual(res, { saved: 0, skipped: 0 });
  const s1 = (await pull()).sleeps.find((s) => s.id === 's1');
  assert.equal(s1.notes, 'newer');
  assert.equal(s1.updatedAt, 50);
});

test('an accepted update moves the row forward in the cursor so other devices see it', { skip }, async () => {
  const before = (await pull()).cursor;
  await push([nap('s2', 2000000, 2005000, 99)]);
  const r = await pull(FAM, before);
  assert.deepEqual(r.sleeps.map((s) => [s.id, s.end]), [['s2', 2005000]]);
});

test('deletes are tombstones that also propagate and win only if newer', { skip }, async () => {
  const before = (await pull()).cursor;
  await push([{ id: 's3', deleted: true, updatedAt: 200 }]);
  const r = await pull(FAM, before);
  assert.equal(r.sleeps[0].id, 's3');
  assert.equal(r.sleeps[0].deleted, true);
  // A stale resurrect attempt loses.
  await push([nap('s3', 3000000, 3600000, 150)]);
  assert.equal((await pull()).sleeps.find((s) => s.id === 's3').deleted, true);
});

test('profile: newer wins, older ignored', { skip }, async () => {
  await push([], { baby: { name: 'Mia B', birth: 1773100800000 }, settings: { bedtime: null }, updatedAt: 2000 });
  assert.equal((await pull()).profile.baby.name, 'Mia B');
  await push([], { baby: { name: 'Old', birth: 1 }, settings: {}, updatedAt: 1500 });
  assert.equal((await pull()).profile.baby.name, 'Mia B');
});

test('invalid rows are skipped, valid ones in the same push are saved', { skip }, async () => {
  const res = await push([
    nap('ok1', 5000000, 5003000, 300),
    nap('bad id!', 5000000, 5003000, 300),
    nap('end-before-start', 6000000, 5000000, 300),
    { id: 'bad-kind', start: 1, end: 2, kind: 'party', updatedAt: 300 },
    { id: 'no-stamp', start: 1, end: 2, kind: 'nap' },
    nap('ok2', 7000000, null, 300),
  ]);
  assert.deepEqual(res, { saved: 2, skipped: 4 });
});

test('families are isolated from each other', { skip }, async () => {
  await push([nap('only-a', 1, 2, 5)], null, OTHER);
  assert.ok((await pull(OTHER)).sleeps.some((s) => s.id === 'only-a'));
  assert.ok(!(await pull(FAM)).sleeps.some((s) => s.id === 'only-a'));
  assert.equal((await pull(OTHER)).profile, null);
});

test('oversized pushes and non-arrays are rejected', { skip }, async () => {
  await assert.rejects(push(Array.from({ length: 1001 }, (_, i) => nap(`b${i}`, 1, 2, 1))), /too many sleeps/);
  await assert.rejects(db.query('select public.naps_push($1, null, \'{"a":1}\'::jsonb)', [FAM]), /must be an array/);
});

test('notes are truncated, not rejected', { skip }, async () => {
  await push([nap('long-note', 8000000, 8003000, 400, { notes: 'x'.repeat(2000) })]);
  assert.equal((await pull()).sleeps.find((s) => s.id === 'long-note').notes.length, 500);
});

test('"fell asleep early" flags are stored, returned, and kept honest', { skip }, async () => {
  await push([nap('f1', 9000000, 9003000, 500, { flags: { early: true, planned: 8990000 } })]);
  const f1 = (await pull()).sleeps.find((s) => s.id === 'f1');
  assert.deepEqual(f1.flags, { early: true, planned: 8990000 });
  // Not an object, or far too big: the sleep is saved, the flags are dropped.
  await push([nap('f2', 9100000, 9103000, 500, { flags: 'early' }), nap('f3', 9200000, 9203000, 500, { flags: { note: 'x'.repeat(500) } })]);
  const rows = (await pull()).sleeps;
  assert.equal(rows.find((s) => s.id === 'f2').flags, null);
  assert.equal(rows.find((s) => s.id === 'f3').flags, null);
  // A newer edit can clear them.
  await push([nap('f1', 9000000, 9003000, 600, { flags: null })]);
  assert.equal((await pull()).sleeps.find((s) => s.id === 'f1').flags, null);
});

test('settling and cut-short notes, and rough-day mode, need no database change: they ride in the existing columns', { skip }, async () => {
  const profile = { baby: { name: 'Mia', birth: 1773100800000 }, settings: { bedtime: '20:30', recovery: { since: 1790000000000, reasons: ['vaccine', 'appointment'] } }, updatedAt: 9000 };
  await push([nap('r1', 9300000, 9303000, 700, { flags: { settle: 2, cut: true } })], profile);
  const r = await pull();
  assert.deepEqual(r.sleeps.find((s) => s.id === 'r1').flags, { settle: 2, cut: true });
  assert.deepEqual(r.profile.settings.recovery, { since: 1790000000000, reasons: ['vaccine', 'appointment'] });
});

test('running setup.sql again on an existing database keeps its data', { skip }, async () => {
  const before = (await pull()).sleeps.length;
  await db.exec('reset role');
  await db.exec(SETUP);
  await db.exec('set role anon');
  assert.equal((await pull()).sleeps.length, before);
});

test('upgrading a database created before the flags column existed keeps every row', { skip }, async () => {
  await db.exec('reset role');
  // Put the database back into its earlier shape: no flags column, and old rows in it.
  await db.exec('drop function public.naps_pull(text, bigint); drop function public.naps_push(text, jsonb, jsonb);');
  await db.exec('alter table public.naps_sleeps drop column flags');
  await db.exec("insert into public.naps_sleeps (family_id, id, start_ms, end_ms, kind, notes, updated_at) values ('legacyfamilylegacyfamily1', 'old1', 1000, 2000, 'nap', 'from before', 5)");
  await db.exec(SETUP);
  await db.exec('set role anon');
  const r = await pull('legacyfamilylegacyfamily1');
  assert.equal(r.sleeps.length, 1);
  assert.equal(r.sleeps[0].notes, 'from before');
  assert.equal(r.sleeps[0].flags, null);
});
