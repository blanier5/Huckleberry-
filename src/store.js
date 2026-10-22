import { MIN } from './time.js';
import { classifySleep, sleepId } from './analysis.js';
import { defaultSettings, cleanSettings, cleanSettingsPatch, cleanFlags } from './settings.js';

const KEY = 'napberry:v1';
const VERSION = 2;

const EMPTY = () => ({
  version: VERSION,
  baby: null,
  settings: defaultSettings(),
  profileAt: 0, // when the baby profile / settings last changed (for sync)
  sleeps: [],
  tombstones: {}, // id -> when it was deleted, so a delete can't be undone by a phone that missed it
  pending: { sleeps: {}, profile: false }, // changes not yet confirmed by the sync server
});

/** localStorage, or null where the browser blocks it (some private modes throw just for touching it). */
export function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Last-writer-wins stamp that always moves forward, even if a device clock is behind. */
const stamp = (now, prev = 0) => Math.max(now(), prev + 1);

function cleanSleep(s) {
  if (!s || !Number.isFinite(s.start)) return null;
  const end = s.end == null ? null : Number(s.end);
  if (end != null && (!Number.isFinite(end) || end <= s.start)) return null;
  const flags = cleanFlags(s.flags);
  return {
    id: sleepId(s.start),
    start: s.start,
    end,
    kind: s.kind === 'night' ? 'night' : s.kind === 'nap' ? 'nap' : classifySleep(s.start, end),
    notes: String(s.notes ?? '').slice(0, 500),
    ...(s.source ? { source: String(s.source).slice(0, 40) } : {}),
    ...(flags ? { flags } : {}),
    updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : 0,
  };
}

/** Older saves had random ids and no timestamps. Normalise them once. */
function migrate(saved) {
  const state = { ...EMPTY(), ...saved, version: VERSION };
  state.pending = { sleeps: {}, profile: false, ...(saved.pending ?? {}) };
  state.tombstones = saved.tombstones ?? {};
  const byId = new Map();
  for (const raw of saved.sleeps ?? []) {
    // A sleep nobody has edited since it happened is "as old as" its last moment.
    const s = cleanSleep({ ...raw, updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : (raw.end ?? raw.start) });
    if (!s) continue;
    const other = byId.get(s.id);
    if (!other || (s.end != null && other.end == null) || s.updatedAt > other.updatedAt) byId.set(s.id, s);
  }
  state.sleeps = [...byId.values()];
  return state;
}

/**
 * Local-first store. `storage` can be any localStorage-like object (handy for tests) and
 * `clock` returns the current time in ms. Everything works with no network; the sync layer
 * (sync.js) just reads `pendingSnapshot()` and feeds remote changes to `applyRemote()`.
 */
export function createStore(storage = defaultStorage(), { clock = () => Date.now() } = {}) {
  let state = EMPTY();
  let migrated = false;
  const listeners = new Set();

  try {
    const raw = storage?.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved.version === VERSION) {
        state = { ...EMPTY(), ...saved };
      } else {
        state = migrate(saved);
        migrated = true;
      }
    }
  } catch {
    state = EMPTY();
  }
  // Settings added in later versions are absent from older saves: fill them in (nothing is removed).
  state.settings = cleanSettings(state.settings);

  function persist() {
    try {
      storage?.setItem(KEY, JSON.stringify(state));
    } catch {
      // Storage may be full or blocked (private mode); the app keeps working in memory.
    }
  }

  function commit(meta = {}) {
    state.sleeps.sort((a, b) => a.start - b.start);
    persist();
    listeners.forEach((fn) => fn(state, meta));
  }

  if (migrated) persist();

  const find = (id) => state.sleeps.find((s) => s.id === id);

  /** Record a local change to a live sleep. */
  function touch(s) {
    s.updatedAt = stamp(clock, Math.max(s.updatedAt || 0, state.tombstones[s.id] || 0));
    delete state.tombstones[s.id];
    state.pending.sleeps[s.id] = 1;
  }

  function bury(id, prev = 0) {
    state.tombstones[id] = stamp(clock, Math.max(prev, state.tombstones[id] || 0));
    state.pending.sleeps[id] = 1;
  }

  function profileChanged() {
    state.profileAt = stamp(clock, state.profileAt);
    state.pending.profile = true;
  }

  const store = {
    get state() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The sleep in progress (if two somehow exist, the one that started first). */
    get ongoing() {
      return state.sleeps.find((s) => s.end == null) ?? null;
    },
    hasSleepAt(start, exceptId) {
      const id = sleepId(start);
      return id !== exceptId && Boolean(find(id));
    },

    setBaby(baby) {
      state.baby = baby;
      profileChanged();
      commit();
    },
    setSettings(patch) {
      state.settings = { ...state.settings, ...cleanSettingsPatch(patch) };
      profileChanged();
      commit();
    },

    startSleep(kind, at = clock(), flags) {
      if (store.ongoing || store.hasSleepAt(at)) return null;
      const s = cleanSleep({ start: at, end: null, kind, flags });
      if (!s) return null;
      touch(s);
      state.sleeps.push(s);
      commit();
      return s;
    },
    endSleep(at = clock()) {
      const s = store.ongoing;
      if (!s) return null;
      s.end = Math.max(at, s.start + MIN);
      // A "nap" that ran all night was really night sleep.
      if (s.kind === 'nap' && (s.end - s.start) / MIN >= 300) s.kind = 'night';
      touch(s);
      commit();
      return s;
    },
    addSleep(data) {
      const s = cleanSleep(data);
      if (!s || find(s.id)) return null;
      touch(s);
      state.sleeps.push(s);
      commit();
      return s;
    },
    /** Edit a sleep. Returns null if the result is invalid or would collide with another sleep. */
    updateSleep(id, patch) {
      const old = find(id);
      if (!old) return null;
      const next = cleanSleep({ ...old, ...patch });
      if (!next) return null;
      if (next.id !== id) {
        // The start time moved to a different minute, which is a different identity.
        if (find(next.id)) return null;
        state.sleeps = state.sleeps.filter((s) => s.id !== id);
        bury(id, old.updatedAt);
        next.updatedAt = old.updatedAt;
        state.sleeps.push(next);
      } else {
        state.sleeps[state.sleeps.indexOf(old)] = next;
        next.updatedAt = old.updatedAt;
      }
      touch(next);
      commit();
      return next;
    },
    removeSleep(id) {
      const old = find(id);
      if (!old) return;
      state.sleeps = state.sleeps.filter((s) => s.id !== id);
      bury(id, old.updatedAt);
      commit();
    },

    /** Add sleeps, skipping any that start at the same minute as one already logged. */
    mergeSleeps(incoming) {
      let added = 0;
      let duplicates = 0;
      for (const raw of incoming) {
        const s = cleanSleep({ ...raw, updatedAt: 0 });
        if (!s) continue;
        if (find(s.id)) {
          duplicates++;
          continue;
        }
        touch(s);
        state.sleeps.push(s);
        added++;
      }
      if (added) commit();
      return { added, duplicates };
    },
    countDuplicates(incoming) {
      return incoming.filter((s) => find(sleepId(s.start))).length;
    },

    exportJSON() {
      const { baby, settings, sleeps } = state;
      return JSON.stringify({ app: 'napberry', version: 2, exportedAt: clock(), baby, settings, sleeps }, null, 2);
    },
    /** Merge a JSON backup into the current data. Returns merge counts. */
    importJSON(text) {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.sleeps)) throw new Error('Not a Napberry backup file.');
      if (!state.baby && data.baby?.name && Number.isFinite(data.baby.birth)) {
        state.baby = { name: String(data.baby.name), birth: data.baby.birth };
        profileChanged();
      }
      const result = store.mergeSleeps(data.sleeps);
      if (!result.added) commit();
      return result;
    },
    reset() {
      state = EMPTY();
      commit();
    },

    /* ---------------- sync support ---------------- */

    hasPending() {
      return state.pending.profile || Object.keys(state.pending.sleeps).length > 0;
    },

    /** What still needs to be sent to the server. */
    pendingSnapshot() {
      const sleeps = [];
      for (const id of Object.keys(state.pending.sleeps)) {
        const live = find(id);
        if (live) {
          sleeps.push({ id, start: live.start, end: live.end, kind: live.kind, notes: live.notes, source: live.source ?? null, flags: live.flags ?? null, deleted: false, updatedAt: live.updatedAt });
        } else if (state.tombstones[id] != null) {
          sleeps.push({ id, deleted: true, updatedAt: state.tombstones[id] });
        } else {
          delete state.pending.sleeps[id];
        }
      }
      const profile =
        state.pending.profile && state.baby
          ? { baby: state.baby, settings: cleanSettings(state.settings), updatedAt: state.profileAt }
          : null;
      return { profile, sleeps };
    },

    /** Forget pending changes the server confirmed, unless the record changed again meanwhile. */
    ackPending(sent) {
      for (const s of sent.sleeps ?? []) {
        const current = find(s.id)?.updatedAt ?? state.tombstones[s.id];
        if (current === s.updatedAt) delete state.pending.sleeps[s.id];
      }
      if (sent.profile && state.profileAt === sent.profile.updatedAt) state.pending.profile = false;
      persist();
    },

    /** Queue everything for upload (used when sync is first turned on). */
    queueAll({ profile = true } = {}) {
      for (const s of state.sleeps) state.pending.sleeps[s.id] = 1;
      for (const id of Object.keys(state.tombstones)) state.pending.sleeps[id] = 1;
      if (profile && state.baby) {
        state.profileAt = state.profileAt || clock();
        state.pending.profile = true;
      }
      commit({ remote: true });
    },

    /** Joining a family: the family's profile should win over whatever this device had. */
    prepareJoin() {
      state.profileAt = 0;
      state.pending.profile = false;
      store.queueAll({ profile: false });
    },

    /** Merge changes from the server. Newest change per record wins. Returns true if anything changed. */
    applyRemote({ sleeps = [], profile = null } = {}) {
      let changed = false;

      for (const r of sleeps) {
        if (!r || typeof r.id !== 'string' || !Number.isFinite(r.updatedAt)) continue;
        const local = find(r.id);
        const localAt = local ? local.updatedAt : (state.tombstones[r.id] ?? -1);

        if (r.updatedAt <= localAt) {
          // Ours is newer (or identical). Make sure the server hears about it.
          if (r.updatedAt < localAt && !state.pending.sleeps[r.id]) state.pending.sleeps[r.id] = 1;
          continue;
        }

        if (r.deleted) {
          if (local) state.sleeps = state.sleeps.filter((s) => s.id !== r.id);
          state.tombstones[r.id] = r.updatedAt;
        } else {
          // A server that predates the flags column sends none; keep what this phone already knows.
          const s = cleanSleep({ ...r, flags: r.flags !== undefined ? r.flags : local?.flags, updatedAt: r.updatedAt });
          if (!s || s.id !== r.id) continue;
          if (local) state.sleeps[state.sleeps.indexOf(local)] = s;
          else state.sleeps.push(s);
          delete state.tombstones[r.id];
        }
        delete state.pending.sleeps[r.id];
        changed = true;
      }

      // Two phones can each start a nap before they've seen the other's. Keep the first.
      const open = state.sleeps.filter((s) => s.end == null).sort((a, b) => a.start - b.start);
      for (const dup of open.slice(1)) {
        state.sleeps = state.sleeps.filter((s) => s.id !== dup.id);
        bury(dup.id, dup.updatedAt);
        changed = true;
      }

      if (profile && typeof profile.baby?.name === 'string' && Number.isFinite(profile.baby.birth) && Number.isFinite(profile.updatedAt) && profile.updatedAt > state.profileAt) {
        state.baby = { name: profile.baby.name.slice(0, 100), birth: profile.baby.birth };
        // Only settings the other phone actually sent are taken; an older version that doesn't know
        // about newer settings can't erase them.
        state.settings = { ...state.settings, ...cleanSettingsPatch(profile.settings) };
        state.profileAt = profile.updatedAt;
        state.pending.profile = false;
        changed = true;
      }

      if (changed) commit({ remote: true });
      else persist();
      return changed;
    },
  };
  return store;
}
