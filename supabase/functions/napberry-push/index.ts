// Napberry nap alerts: the one small function that sends the push notifications.
//
// Deploy it once in your Supabase project: Edge Functions -> Deploy a new function -> Via Editor,
// name it exactly  napberry-push , paste this whole file, Deploy, then turn OFF "Verify JWT" for it
// (the schedule in supabase/push.sql calls it with a secret instead of a login). Napberry's
// Settings -> Nap alerts walks through it.
//
// What it does each time the schedule wakes it:
//   1. asks the database for alerts that are due (the database also checks a secret, so calling
//      this URL from anywhere else does nothing)
//   2. the very first time, makes the push key pair and saves it in the database
//   3. sends each due alert to every phone that turned alerts on, and forgets phones the push
//      service says are gone
//
// No libraries: the encryption (RFC 8291) and signing (RFC 8292) use the standard Web Crypto API.

const text = new TextEncoder();

const b64u = {
  enc(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  },
  dec(str) {
    const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/**
 * Encrypts a push message for one phone (RFC 8291, "aes128gcm"). `p256dh` and `auth` come from the
 * phone's push subscription. `salt` and `ephemeral` (an ECDH key pair) are random unless a test
 * pins them. Returns the request body.
 */
export async function encryptPayload({ payload, p256dh, auth, salt, ephemeral }) {
  const message = typeof payload === 'string' ? text.encode(payload) : payload;
  const uaPublic = b64u.dec(p256dh);
  const authSecret = b64u.dec(auth);
  salt = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const pair = ephemeral ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, pair.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(text.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text.encode('Content-Encoding: nonce\0'), 12);

  const record = concat(message, new Uint8Array([2])); // 0x02 marks the last (only) record
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, record));

  const recordSize = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** The Authorization header that proves the message comes from the owner of the push key (RFC 8292). */
export async function vapidAuthorization({ endpoint, publicKey, privateKey, subject, now = Date.now() }) {
  const header = b64u.enc(text.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(
    text.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })),
  );
  const pub = b64u.dec(publicKey);
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), d: privateKey },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, text.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64u.enc(signature)}, k=${publicKey}`;
}

/** A new push key pair: the public half goes to phones, the private half stays in the database. */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: b64u.enc(raw), privateKey: jwk.d };
}

/** Sends one message to one phone. Returns the push service's HTTP status (201 = accepted). */
export async function sendPush({ sub, message, vapid, subject, fetchImpl = fetch, ttl = 900 }) {
  const body = await encryptPayload({ payload: JSON.stringify(message), p256dh: sub.p256dh, auth: sub.auth });
  const authorization = await vapidAuthorization({ endpoint: sub.endpoint, publicKey: vapid.public, privateKey: vapid.private, subject });
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl), // an alert that is 15 minutes old is no longer worth showing
      Urgency: 'high',
    },
    body,
  });
  return res.status;
}

/**
 * One run. `rpc(name, args)` calls a database function. Returns { status, sent, failed, removed }.
 * `send` is injectable so tests don't need a push service.
 */
export async function tick({ rpc, secret, subject, send = sendPush, log = console }) {
  let claim = await rpc('naps_alerts_claim', { p_secret: secret });
  if (!claim.ok) return { status: 401 };
  if (claim.needsKeys) {
    const keys = await generateVapidKeys();
    await rpc('naps_push_keys_set', { p_secret: secret, p_public: keys.publicKey, p_private: keys.privateKey });
    claim = await rpc('naps_alerts_claim', { p_secret: secret });
    if (!claim.ok) return { status: 401 };
  }

  const gone = [];
  let sent = 0;
  let failed = 0;
  for (const alert of claim.alerts ?? []) {
    const message = { title: alert.title, body: alert.body, tag: alert.kind === 'test' ? 'napberry-test' : 'napberry-nap' };
    await Promise.all(
      (alert.subs ?? []).map(async (sub) => {
        try {
          const status = await send({ sub, message, vapid: claim.vapid, subject });
          if (status >= 200 && status < 300) sent++;
          else if (status === 404 || status === 410) gone.push(sub.endpoint);
          else {
            failed++;
            log.warn(`push service answered ${status} for ${new URL(sub.endpoint).origin}`);
          }
        } catch (err) {
          failed++;
          log.warn(`push failed: ${err?.message ?? err}`);
        }
      }),
    );
  }
  if (gone.length) await rpc('naps_push_forget', { p_secret: secret, p_endpoints: gone });
  return { status: 200, sent, failed, removed: gone.length };
}

if (typeof Deno !== 'undefined' && Deno.serve) {
  Deno.serve(async (req) => {
    const base = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const rpc = async (name, args) => {
      const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
        body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error(`${name} failed (${res.status}): ${await res.text()}`);
      return res.json();
    };
    try {
      const result = await tick({
        rpc,
        secret: req.headers.get('x-napberry-secret') ?? '',
        subject: Deno.env.get('VAPID_SUBJECT') ?? 'mailto:napberry@example.com',
      });
      return new Response(JSON.stringify(result), { status: result.status, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: String(err?.message ?? err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  });
}
