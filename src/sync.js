import { defaultStorage } from './store.js';

// Optional sync between devices through the owner's own Supabase project (see
// supabase/setup.sql and the README). The app is local-first: it never waits on the network,
// and everything here is "send what changed, fetch what others changed".

export const POLL_MS = 20_000;
const PUSH_DEBOUNCE_MS = 700;
const CHUNK = 500;
/** The newest database script this version of the app expects (supabase/setup.sql reports its own). */
export const REQUIRED_DB_VERSION = 2;
const CONFIG_KEY = 'napberry:sync:v1';
const INVITE_PREFIX = 'nb1.';

/* ------------------------------------------------------------------ */
/* Invites: one string carries the project URL, key and family code    */
/* ------------------------------------------------------------------ */

const b64url = {
  encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  },
  decode(s) {
    const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  },
};

/** 128 random bits as 22 URL-safe characters. This is the "password" for a family's data. */
export function newFamilyCode(random = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export const isFamilyCode = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(s);

/** Accepts "https://abc.supabase.co", with or without a trailing slash or /rest/v1. */
export function normalizeUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  return url.origin;
}

export function encodeInvite({ url, key, family }) {
  return INVITE_PREFIX + b64url.encode(JSON.stringify({ u: url, k: key, f: family }));
}

/** Pulls an invite out of a bare code or a whole pasted link. Returns null if there isn't a valid one. */
export function parseInvite(text) {
  const m = /nb1\.([A-Za-z0-9_-]+)/.exec(String(text ?? ''));
  if (!m) return null;
  try {
    const { u, k, f } = JSON.parse(b64url.decode(m[1]));
    const url = normalizeUrl(u);
    if (!url || typeof k !== 'string' || !k.trim() || !isFamilyCode(f)) return null;
    return { url, key: k.trim(), family: f };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Server calls                                                        */
/* ------------------------------------------------------------------ */

export class SyncError extends Error {
  /** kind: 'network' | 'auth' | 'setup' | 'code' | 'server' */
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export function createRemote({ url, key, fetch = globalThis.fetch.bind(globalThis) }) {
  const headers = { 'Content-Type': 'application/json', apikey: key };
  // Legacy anon keys are JWTs and go in Authorization too. The newer "publishable" keys must not.
  if (/^eyJ/.test(key)) headers.Authorization = `Bearer ${key}`;

  async function rpc(name, body) {
    let res;
    try {
      res = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err) {
      throw new SyncError('network', "Can't reach the sync server.", 0);
    }
    if (res.ok) return res.json();
    let info = {};
    try {
      info = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.status === 401 || res.status === 403) throw new SyncError('auth', 'The sync key was rejected. Check the project URL and key.', res.status);
    if (res.status === 404 || info.code === 'PGRST202') throw new SyncError('setup', "The sync database isn't set up yet. Run supabase/setup.sql in your Supabase project.", res.status);
    if (info.code === '22023') throw new SyncError('code', info.message || 'That family code is not valid.', res.status);
    throw new SyncError('server', info.message || `The sync server returned an error (${res.status}).`, res.status);
  }

  return {
    pull: (family, cursor) => rpc('naps_pull', { p_family: family, p_cursor: cursor }),
    push: (family, profile, sleeps) => rpc('naps_push', { p_family: family, p_profile: profile, p_sleeps: sleeps }),
  };
}

/* ------------------------------------------------------------------ */
/* The sync engine                                                     */
/* ------------------------------------------------------------------ */

/**
 * Connects a store to a remote. Local changes are pushed shortly after they happen, the server
 * is polled while the app is visible, and everything is retried until it gets through.
 *
 *   status.state: 'off' | 'idle' | 'syncing' | 'ok' | 'offline' | 'error'
 */
export function createSync({
  store,
  storage = defaultStorage(),
  makeRemote = createRemote,
  clock = () => Date.now(),
  doc = globalThis.document,
  win = globalThis.window,
  pushDelay = PUSH_DEBOUNCE_MS, // null turns off automatic pushing (tests drive syncNow themselves)
}) {
  let cfg = null; // { url, key, family, cursor }
  let remote = null;
  let status = { state: 'off', lastOk: null, message: '', dbOutdated: false };
  let dbVersion = null; // reported by the server on every pull; a script older than version 2 reports none
  let inFlight = null;
  let rerun = false;
  let pushTimer = null;
  let pollTimer = null;
  const listeners = new Set();

  try {
    const saved = JSON.parse(storage?.getItem(CONFIG_KEY) ?? 'null');
    if (saved && normalizeUrl(saved.url) && saved.key && isFamilyCode(saved.family)) {
      cfg = { url: saved.url, key: saved.key, family: saved.family, cursor: Number(saved.cursor) || 0 };
      remote = makeRemote(cfg);
      status = { state: 'idle', lastOk: saved.lastOk ?? null, message: '' };
    }
  } catch {
    cfg = null;
  }

  const saveCfg = () => {
    try {
      if (cfg) storage?.setItem(CONFIG_KEY, JSON.stringify({ ...cfg, lastOk: status.lastOk }));
      else storage?.removeItem(CONFIG_KEY);
    } catch {
      /* ignore */
    }
  };

  const setStatus = (patch) => {
    status = { ...status, ...patch };
    listeners.forEach((fn) => fn(status));
  };

  async function cycle() {
    for (let pass = 0; pass < 3; pass++) {
      // 1. Send what changed here.
      const snap = store.pendingSnapshot();
      if (snap.profile || snap.sleeps.length) {
        const chunks = [];
        for (let i = 0; i < snap.sleeps.length || (i === 0 && snap.profile); i += CHUNK) chunks.push(snap.sleeps.slice(i, i + CHUNK));
        for (let i = 0; i < chunks.length; i++) {
          const profile = i === 0 ? snap.profile : null;
          await remote.push(cfg.family, profile, chunks[i]);
          store.ackPending({ profile, sleeps: chunks[i] });
        }
      }
      // 2. Fetch what changed elsewhere.
      const res = await remote.pull(cfg.family, cfg.cursor);
      store.applyRemote({ sleeps: res.sleeps, profile: res.profile });
      if (!res.profile && store.state.baby && !store.state.pending.profile && cfg.cursor === 0) {
        // A brand-new family with no profile on the server yet: upload ours.
        store.queueAll({ profile: true });
      }
      cfg.cursor = Math.max(cfg.cursor, Number(res.cursor) || 0);
      dbVersion = Number(res.version) || 1;
      if (!store.hasPending()) break;
    }
    status = { ...status, lastOk: clock(), dbOutdated: dbVersion != null && dbVersion < REQUIRED_DB_VERSION };
    saveCfg();
  }

  /** Run one sync now (or queue one if one is already running). */
  function syncNow() {
    if (!cfg) return Promise.resolve(false);
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    // Background polls stay quiet when all is well, so the header dot doesn't blink every 20 seconds.
    if (status.state !== 'ok') setStatus({ state: 'syncing', message: '' });
    inFlight = (async () => {
      let ok = false;
      try {
        do {
          rerun = false;
          await cycle();
        } while (rerun);
        ok = true;
        setStatus({ state: 'ok', message: '' }); // keeps dbOutdated from the cycle
      } catch (err) {
        const offline = err instanceof SyncError && err.kind === 'network';
        setStatus({ state: offline ? 'offline' : 'error', message: err instanceof SyncError ? err.message : 'Sync failed unexpectedly.' });
      } finally {
        inFlight = null;
      }
      return ok;
    })();
    return inFlight;
  }

  function schedulePush() {
    if (pushDelay == null) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, pushDelay);
    pushTimer.unref?.();
  }

  const visible = () => !doc || !doc.hidden;
  const onVisible = () => visible() && syncNow();

  store.subscribe((_state, meta) => {
    if (cfg && !meta?.remote) schedulePush();
  });
  doc?.addEventListener('visibilitychange', onVisible);
  win?.addEventListener('online', onVisible);

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => visible() && syncNow(), POLL_MS);
    pollTimer.unref?.();
  }

  const sync = {
    get status() {
      return status;
    },
    /** True when the Supabase database script is older than this version of the app expects. */
    get dbOutdated() {
      return Boolean(cfg && status.dbOutdated);
    },
    /** Link to the SQL editor of the connected Supabase project (null for non-Supabase URLs). */
    sqlEditorUrl() {
      try {
        const host = new URL(cfg.url).hostname;
        return host.endsWith('.supabase.co') ? `https://supabase.com/dashboard/project/${host.split('.')[0]}/sql/new` : null;
      } catch {
        return null;
      }
    },
    get enabled() {
      return Boolean(cfg);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      if (!cfg) return;
      startPolling();
      syncNow();
    },
    syncNow,

    /** Invite string for other devices (null when sync is off). */
    invite() {
      return cfg ? encodeInvite(cfg) : null;
    },

    /** First device: check the project works, create a family code, upload everything. */
    async enable({ url, key }) {
      const clean = normalizeUrl(url);
      if (!clean) throw new SyncError('setup', 'The project URL should look like https://abcdxyz.supabase.co');
      if (!String(key ?? '').trim()) throw new SyncError('auth', 'Paste the project key too.');
      const candidate = { url: clean, key: key.trim(), family: newFamilyCode(), cursor: 0 };
      await makeRemote(candidate).pull(candidate.family, 0); // proves the URL, key and database are right
      cfg = candidate;
      remote = makeRemote(cfg);
      saveCfg();
      store.queueAll();
      startPolling();
      await syncNow();
      return sync.invite();
    },

    /** Another device: take the invite, adopt the family's profile and merge sleeps. */
    async join(inviteText) {
      const invite = parseInvite(inviteText);
      if (!invite) throw new SyncError('code', "That doesn't look like a Napberry invite. Paste the whole link or code.");
      const candidate = { ...invite, cursor: 0 };
      await makeRemote(candidate).pull(candidate.family, 0);
      cfg = candidate;
      remote = makeRemote(cfg);
      saveCfg();
      store.prepareJoin();
      startPolling();
      const ok = await syncNow();
      if (!ok) throw new SyncError('network', status.message || 'Joined, but the first sync did not finish.');
    },

    /** Stop syncing on this device. Local data stays; the cloud copy is untouched. */
    leave() {
      clearTimeout(pushTimer);
      clearInterval(pollTimer);
      cfg = null;
      remote = null;
      saveCfg();
      dbVersion = null;
      setStatus({ state: 'off', lastOk: null, message: '', dbOutdated: false });
    },
  };
  return sync;
}
