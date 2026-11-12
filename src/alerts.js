// Nap alerts: a push notification when the nap sweet spot starts, even with Napberry closed.
//
// A phone can't wake itself, so there are two halves. This file is the phone's half: it works out
// when the next sweet spot starts (the same prediction you see on Today) and leaves one note about
// it in the family's Supabase project, and it turns alerts on or off for this phone. The other half
// (supabase/push.sql and supabase/functions/napberry-push) delivers the note at the right minute
// to every phone that turned alerts on.
//
// Every phone that logs something recomputes the note, so it always follows the latest wake-up,
// and a phone that hasn't caught up yet can't overwrite a newer note (see `dataBasis`).

import { HOUR, MIN, fmtClock } from './time.js';
import { SyncError } from './sync.js';

/** How far ahead a sweet spot is worth announcing; the database refuses anything beyond 12 hours. */
const HORIZON = 8 * HOUR;
const RECHECK_MS = 5 * MIN;
const SETUP_RETRY_MS = 10 * MIN;

/**
 * What to tell the family's phones. { action: 'set', fireAt, title, body } while she is awake and the
 * next thing is a nap whose sweet spot hasn't started; { action: 'clear' } otherwise (she is asleep,
 * bedtime is next, or the sweet spot is already here, which Today shows without an alert).
 */
export function planAlert({ prediction: p, baby, now }) {
  const next = p?.mode === 'awake' ? p.next : null;
  if (!next || next.kind !== 'nap') return { action: 'clear' };
  const fireAt = Math.round(next.earliest / MIN) * MIN;
  if (fireAt <= now + 30_000 || fireAt - now > HORIZON) return { action: 'clear' };
  const name = String(baby?.name ?? '').trim() || 'Baby';
  const which = next.bridge ? 'Short bridge nap' : `Nap ${next.number}`;
  return {
    action: 'set',
    fireAt,
    title: `${name}'s nap sweet spot is starting`,
    body: `${which}: sweet spot ${fmtClock(next.earliest)}–${fmtClock(next.latest)}, best around ${fmtClock(next.at)}. ${name} woke at ${fmtClock(p.awakeSince)}.`,
  };
}

/** How new the data behind a note is: the latest change to any sleep, delete or the profile. */
export function dataBasis(state) {
  let basis = state.profileAt || 0;
  for (const s of state.sleeps) if (s.updatedAt > basis) basis = s.updatedAt;
  for (const at of Object.values(state.tombstones ?? {})) if (at > basis) basis = at;
  return basis;
}

export function urlBase64ToUint8Array(str) {
  const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** 'ok', or why this phone can't receive pushes: 'ios-install' (needs the Home Screen app), 'ios-old', 'unsupported'. */
export function pushSupport({ win, nav }) {
  if (!win || !nav || !('serviceWorker' in nav)) return 'unsupported';
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const standalone = nav.standalone === true || Boolean(win.matchMedia?.('(display-mode: standalone)')?.matches);
  if (ios && !standalone) return 'ios-install';
  if (!('PushManager' in win) || !('Notification' in win)) return ios ? 'ios-old' : 'unsupported';
  return 'ok';
}

/**
 * The alerts controller. `predict()` returns today's prediction; `env` is { win, nav } (the browser's).
 *
 *   state.phase: 'off'            sync is off, so there's no family to send alerts for
 *                'checking'       asking the database what is set up
 *                'needs-db'       supabase/push.sql hasn't been run
 *                'needs-function' the database is ready, but the napberry-push function has not run yet
 *                'ready'          everything is set up; this phone hasn't turned alerts on
 *                'on'             this phone gets alerts
 */
export function createAlerts({ store, sync, predict, env = { win: globalThis.window, nav: globalThis.navigator }, now = () => Date.now(), debounce = 2000 }) {
  const { win, nav } = env;
  let state = { phase: 'checking', support: pushSupport(env), permission: win?.Notification?.permission ?? 'default', busy: false, message: '' };
  const listeners = new Set();
  const set = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn(state));
  };

  let timer = null;
  let last = null; // what was last sent for this data, so an unchanged note isn't sent again
  let blockedUntil = 0; // the database script isn't installed: don't keep asking
  let started = false;

  async function registration() {
    if (!nav?.serviceWorker) return null;
    let timer;
    try {
      const giveUp = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 5000);
      });
      return await Promise.race([nav.serviceWorker.ready, giveUp]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const explain = (err) => (err instanceof SyncError ? err.message : err?.message ? `Couldn't do that: ${err.message}` : "Couldn't do that.");

  /** Look at what is set up, and whether this phone already has alerts on. */
  async function refresh() {
    if (!sync.enabled) return set({ phase: 'off', message: '' });
    set({ support: pushSupport(env), permission: win?.Notification?.permission ?? 'default' });
    let key;
    try {
      key = await sync.remote.pushKey();
    } catch (err) {
      if (err instanceof SyncError && err.kind === 'setup') {
        blockedUntil = now() + SETUP_RETRY_MS;
        return set({ phase: 'needs-db', message: '' });
      }
      return set({ message: explain(err) });
    }
    blockedUntil = 0;
    if (!key) return set({ phase: 'needs-function', message: '' });
    const reg = state.support === 'ok' ? await registration() : null;
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    if (sub && win.Notification.permission === 'granted') {
      // The database may have lost this phone (cleaned up, or the project was reset): say hello again.
      await sync.remote.pushSubscribe(sync.family, sub.toJSON()).catch(() => {});
      set({ phase: 'on', message: '' });
      scheduleSoon();
    } else {
      set({ phase: 'ready', message: '' });
    }
  }

  async function enable() {
    if (state.busy) return;
    set({ busy: true, message: '' });
    try {
      // Asking for permission has to happen straight from the tap, before anything else is awaited.
      const permission = await win.Notification.requestPermission();
      if (permission !== 'granted') {
        return set({
          phase: 'ready',
          permission,
          message:
            permission === 'denied'
              ? "Notifications are blocked for Napberry. Turn them on in your phone's Settings, under Notifications, then try again."
              : 'Permission was not given, so nothing was turned on.',
        });
      }
      const key = await sync.remote.pushKey();
      if (!key) return await refresh();
      const reg = await registration();
      if (!reg) throw new Error('The app is not ready for notifications yet. Close it, open it again, and retry.');
      let sub = await reg.pushManager.getSubscription();
      const wanted = urlBase64ToUint8Array(key);
      const have = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      if (sub && have && (have.length !== wanted.length || have.some((b, i) => b !== wanted[i]))) {
        await sub.unsubscribe(); // made for an older key
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
      await sync.remote.pushSubscribe(sync.family, sub.toJSON());
      set({ phase: 'on', permission: 'granted', message: '' });
      last = null;
      scheduleSoon();
    } catch (err) {
      set({ message: explain(err) });
    } finally {
      set({ busy: false });
    }
  }

  async function disable() {
    if (state.busy) return;
    set({ busy: true, message: '' });
    try {
      const reg = await registration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const { endpoint } = sub;
        await sub.unsubscribe();
        await sync.remote.pushUnsubscribe(sync.family, endpoint).catch(() => {});
      }
      set({ phase: 'ready', message: '' });
    } catch (err) {
      set({ message: explain(err) });
    } finally {
      set({ busy: false });
    }
  }

  /** A notification right now, to every phone with alerts on, so you can see it works. */
  async function test() {
    if (state.busy) return;
    set({ busy: true, message: '' });
    try {
      const t = now();
      await sync.remote.alertSet(sync.family, 'test', t, 'Napberry test alert', 'If you can read this, nap alerts are working on every phone that has them on.', t);
      set({ message: 'Test sent. It should arrive within a minute.' });
    } catch (err) {
      set({ message: explain(err) });
    } finally {
      set({ busy: false });
    }
  }

  /** Work out the note for the current data and send it if it changed. */
  async function run() {
    if (!sync.enabled || !store.state.baby || now() < blockedUntil) return;
    // Wait until this phone has caught up, so an out-of-date phone never speaks for the family.
    if (store.hasPending() || sync.status.state !== 'ok') return;
    const t = now();
    const plan = planAlert({ prediction: predict(t), baby: store.state.baby, now: t });
    const basis = dataBasis(store.state);
    const signature = JSON.stringify([plan, basis]);
    if (signature === last) return;
    try {
      if (plan.action === 'set') await sync.remote.alertSet(sync.family, 'nap', plan.fireAt, plan.title, plan.body, basis);
      else await sync.remote.alertClear(sync.family, 'nap', basis);
      last = signature;
    } catch (err) {
      if (err instanceof SyncError && err.kind === 'setup') blockedUntil = t + SETUP_RETRY_MS; // alerts aren't installed
    }
  }

  function scheduleSoon() {
    clearTimeout(timer);
    timer = setTimeout(run, debounce);
    timer.unref?.();
  }

  const controller = {
    get state() {
      return state;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    refresh,
    enable,
    disable,
    test,
    /** Recompute the note now (tests); normally it happens by itself after changes. */
    run,
    scheduleSoon,
    start() {
      if (started) return;
      started = true;
      store.subscribe(() => scheduleSoon());
      let wasEnabled = sync.enabled;
      sync.onChange(() => {
        // Sync was just turned on, joined or left: look at what is set up for this family.
        if (sync.enabled !== wasEnabled) {
          wasEnabled = sync.enabled;
          last = null;
          refresh();
        }
        scheduleSoon();
      });
      const every = setInterval(scheduleSoon, RECHECK_MS);
      every.unref?.();
      refresh();
    },
  };
  return controller;
}
