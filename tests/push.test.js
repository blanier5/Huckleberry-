import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

// The Edge Function is one self-contained file that Supabase runs. These tests load that exact file.
const source = fs.readFileSync(new URL('../supabase/functions/napberry-push/index.ts', import.meta.url), 'utf8');
const fn = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

// A phone's push subscription keys, made the way a browser makes them.
function phone() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth), authBytes: auth };
}

/** The receiving side of RFC 8291, written separately from the sender, using Node's own crypto. */
function decrypt(body, { ecdh, authBytes }) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const cipher = body.subarray(21 + idLen);
  const shared = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authBytes, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([decipher.update(cipher.subarray(0, cipher.length - 16)), decipher.final()]);
  assert.equal(recordSize, 4096);
  assert.equal(plain[plain.length - 1], 2, 'ends with the last-record delimiter');
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

test('encryption reproduces the example in RFC 8291 Appendix A byte for byte', async () => {
  // Every value below is from the RFC; with the same salt and sender key, the body must match exactly.
  const asPrivate = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
  const asPublic = unb64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const ephemeral = {
    privateKey: await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', d: asPrivate, x: b64u(asPublic.subarray(1, 33)), y: b64u(asPublic.subarray(33, 65)) },
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    ),
    publicKey: await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
  const body = await fn.encryptPayload({
    payload: 'When I grow up, I want to be a watermelon',
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    salt: unb64u('DGv6ra1nlYgDCS1FRnbzlw'),
    ephemeral,
  });
  const expected =
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
  assert.equal(b64u(body), expected);
});

test('what is sent can be read by the phone it was sent to, and only by that phone', async () => {
  const mine = phone();
  const message = JSON.stringify({ title: "Scottie's nap sweet spot is starting", body: 'Nap 3: sweet spot 12:52–1:28 PM. ✨', tag: 'napberry-nap' });
  const body = await fn.encryptPayload({ payload: message, p256dh: mine.p256dh, auth: mine.auth });
  assert.equal(decrypt(Buffer.from(body), mine), message);
  const other = phone();
  assert.throws(() => decrypt(Buffer.from(body), other), 'another phone cannot read it');
  // Random salt and sender key every time.
  const again = await fn.encryptPayload({ payload: message, p256dh: mine.p256dh, auth: mine.auth });
  assert.notEqual(b64u(body), b64u(again));
});

test('the VAPID header is a valid ES256 token for the push service, signed by our key', async () => {
  const keys = await fn.generateVapidKeys();
  assert.equal(unb64u(keys.publicKey).length, 65);
  assert.equal(unb64u(keys.publicKey)[0], 4, 'uncompressed point');
  assert.equal(unb64u(keys.privateKey).length, 32);

  const now = Date.parse('2026-11-12T12:00:00Z');
  const header = await fn.vapidAuthorization({ endpoint: 'https://web.push.apple.com/QGxyz123', publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:napberry@example.com', now });
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[4], keys.publicKey);
  assert.deepEqual(JSON.parse(unb64u(m[1])), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(unb64u(m[2]));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:napberry@example.com');
  assert.ok(claims.exp > now / 1000 && claims.exp - now / 1000 <= 24 * 3600, 'expires within 24 hours');

  const pub = unb64u(keys.publicKey);
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(m[3]));
  assert.equal(ok, true, 'signature verifies with the public key phones are given');
});

test('sendPush posts an encrypted body with the headers a push service expects', async () => {
  const mine = phone();
  const keys = await fn.generateVapidKeys();
  const seen = [];
  const status = await fn.sendPush({
    sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: mine.p256dh, auth: mine.auth },
    message: { title: 'T', body: 'B' },
    vapid: { public: keys.publicKey, private: keys.privateKey },
    subject: 'mailto:napberry@example.com',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { status: 201 };
    },
  });
  assert.equal(status, 201);
  const { url, init } = seen[0];
  assert.equal(url, 'https://fcm.googleapis.com/fcm/send/abc');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(init.headers.TTL, '900');
  assert.match(init.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.deepEqual(JSON.parse(decrypt(Buffer.from(init.body), mine)), { title: 'T', body: 'B' });
});

/* ------------------------------------------------------------------ */
/* One run of the function, against the real database script           */
/* ------------------------------------------------------------------ */

let createBackend;
try {
  ({ createBackend } = await import('./pg-bridge.js'));
  await import('@electric-sql/pglite');
} catch {
  createBackend = null;
}
const skip = createBackend ? false : 'run `npm install` to enable the database tests (@electric-sql/pglite)';
const FAM = 'abcdefghijklmnopqrstuv';

async function setup() {
  const backend = await createBackend({ push: true });
  const secret = (await backend.admin('select tick_secret from public.naps_push_config')).rows[0].tick_secret;
  const rpc = (name, args) => backend.service(name, args);
  const sub = (n) => {
    const p = phone();
    return { sub: { endpoint: `https://push.example.test/${n}`, keys: { p256dh: p.p256dh, auth: p.auth } }, phone: p };
  };
  const now = Date.now();
  return { backend, secret, rpc, sub, now };
}

test('first run makes the push key; later runs only send what is due, once', { skip }, async () => {
  const { backend, secret, rpc, sub, now } = await setup();
  const sent = [];
  const send = async ({ sub: s, message }) => {
    sent.push({ endpoint: s.endpoint, message });
    return 201;
  };
  const ping = (extra = {}) => fn.tick({ rpc, secret, subject: 'mailto:x@example.test', send, log: { warn() {} }, ...extra });

  assert.equal((await backend.db.query('select public.naps_push_key() as k')).rows[0].k, null);
  assert.deepEqual(await ping(), { status: 200, sent: 0, failed: 0, removed: 0 });
  const key = (await backend.db.query('select public.naps_push_key() as k')).rows[0].k;
  assert.equal(unb64u(key).length, 65, 'the public key phones will subscribe with');
  await ping();
  assert.equal((await backend.db.query('select public.naps_push_key() as k')).rows[0].k, key, 'made once');

  const a = sub('a');
  const b = sub('b');
  await backend.db.query('select public.naps_push_subscribe($1, $2::jsonb)', [FAM, JSON.stringify(a.sub)]);
  await backend.db.query('select public.naps_push_subscribe($1, $2::jsonb)', [FAM, JSON.stringify(b.sub)]);
  await backend.db.query("select public.naps_alert_set($1, 'nap', $2, 'Scottie''s nap sweet spot is starting', 'Nap 2: sweet spot 12:52–1:28 PM', 5)", [FAM, now + 1500]);
  assert.equal((await ping()).sent, 0, 'not due yet');
  await new Promise((r) => setTimeout(r, 1700));
  const run = await ping();
  assert.deepEqual(run, { status: 200, sent: 2, failed: 0, removed: 0 });
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), ['https://push.example.test/a', 'https://push.example.test/b']);
  assert.deepEqual(sent[0].message, { title: "Scottie's nap sweet spot is starting", body: 'Nap 2: sweet spot 12:52–1:28 PM', tag: 'napberry-nap' });
  assert.equal((await ping()).sent, 0, 'the same alert is never sent twice');
});

test('a wrong secret does nothing, and phones the push service has dropped are forgotten', { skip }, async () => {
  const { backend, secret, rpc, sub, now } = await setup();
  const calls = [];
  const send = async ({ sub: s }) => {
    calls.push(s.endpoint);
    return s.endpoint.endsWith('/gone') ? 410 : s.endpoint.endsWith('/broken') ? 500 : 201;
  };
  assert.deepEqual(await fn.tick({ rpc, secret: 'guess', subject: 's', send }), { status: 401 });
  await fn.tick({ rpc, secret, subject: 's', send }); // makes the key

  for (const n of ['good', 'gone', 'broken']) await backend.db.query('select public.naps_push_subscribe($1, $2::jsonb)', [FAM, JSON.stringify(sub(n).sub)]);
  await backend.db.query("select public.naps_alert_set($1, 'test', $2, 'Napberry test alert', 'hello', $2)", [FAM, now]);
  const run = await fn.tick({ rpc, secret, subject: 's', send, log: { warn() {} } });
  assert.deepEqual(run, { status: 200, sent: 1, failed: 1, removed: 1 });
  const left = (await backend.admin('select endpoint from public.naps_push_subs order by endpoint')).rows.map((r) => r.endpoint);
  assert.deepEqual(left, ['https://push.example.test/broken', 'https://push.example.test/good'], 'only the 410 is removed; a 500 may be temporary');

  // A thrown network error counts as a failure for that phone and does not stop the others.
  await backend.db.query("select public.naps_alert_set($1, 'test', $2, 'Napberry test alert', 'again', $2)", [FAM, now + 1]);
  const flaky = await fn.tick({
    rpc,
    secret,
    subject: 's',
    log: { warn() {} },
    send: async ({ sub: s }) => {
      if (s.endpoint.endsWith('/broken')) throw new Error('network down');
      return 201;
    },
  });
  assert.deepEqual(flaky, { status: 200, sent: 1, failed: 1, removed: 0 });
});
