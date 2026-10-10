import { MIN } from './time.js';
import { classifySleep, sleepKey } from './analysis.js';

const KEY = 'napberry:v1';

const EMPTY = () => ({ baby: null, settings: { bedtime: null }, sleeps: [] });

function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanSleep(s) {
  if (!s || !Number.isFinite(s.start)) return null;
  const end = s.end == null ? null : Number(s.end);
  if (end != null && (!Number.isFinite(end) || end <= s.start)) return null;
  return {
    id: String(s.id || uid()),
    start: s.start,
    end,
    kind: s.kind === 'night' ? 'night' : s.kind === 'nap' ? 'nap' : classifySleep(s.start, end),
    notes: String(s.notes ?? ''),
    ...(s.source ? { source: String(s.source) } : {}),
  };
}

/** Local-first store. `storage` can be any localStorage-like object (handy for tests). */
export function createStore(storage = globalThis.localStorage) {
  let state = EMPTY();
  const listeners = new Set();

  try {
    const raw = storage?.getItem(KEY);
    if (raw) state = { ...EMPTY(), ...JSON.parse(raw) };
  } catch {
    state = EMPTY();
  }

  function commit() {
    state.sleeps.sort((a, b) => a.start - b.start);
    try {
      storage?.setItem(KEY, JSON.stringify(state));
    } catch {
      // Storage may be full or blocked (private mode); the app keeps working in memory.
    }
    listeners.forEach((fn) => fn(state));
  }

  const store = {
    get state() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get ongoing() {
      return state.sleeps.find((s) => s.end == null) ?? null;
    },

    setBaby(baby) {
      state.baby = baby;
      commit();
    },
    setSettings(patch) {
      state.settings = { ...state.settings, ...patch };
      commit();
    },

    startSleep(kind, at = Date.now()) {
      if (store.ongoing) return null;
      const s = cleanSleep({ start: at, end: null, kind, notes: '' });
      state.sleeps.push(s);
      commit();
      return s;
    },
    endSleep(at = Date.now()) {
      const s = store.ongoing;
      if (!s) return null;
      s.end = Math.max(at, s.start + MIN);
      // A "nap" that ran all night was really night sleep.
      if (s.kind === 'nap' && (s.end - s.start) / MIN >= 300) s.kind = 'night';
      commit();
      return s;
    },
    addSleep(data) {
      const s = cleanSleep({ ...data, id: undefined });
      if (!s) return null;
      state.sleeps.push(s);
      commit();
      return s;
    },
    updateSleep(id, patch) {
      const i = state.sleeps.findIndex((s) => s.id === id);
      if (i === -1) return null;
      const next = cleanSleep({ ...state.sleeps[i], ...patch, id });
      if (!next) return null;
      state.sleeps[i] = next;
      commit();
      return next;
    },
    removeSleep(id) {
      state.sleeps = state.sleeps.filter((s) => s.id !== id);
      commit();
    },

    /** Add sleeps, skipping any whose start/end already exist. */
    mergeSleeps(incoming) {
      const have = new Set(state.sleeps.map(sleepKey));
      let added = 0;
      let duplicates = 0;
      for (const raw of incoming) {
        const s = cleanSleep(raw);
        if (!s) continue;
        const key = sleepKey(s);
        if (have.has(key)) {
          duplicates++;
          continue;
        }
        have.add(key);
        state.sleeps.push(s);
        added++;
      }
      if (added) commit();
      return { added, duplicates };
    },
    countDuplicates(incoming) {
      const have = new Set(state.sleeps.map(sleepKey));
      return incoming.filter((s) => have.has(sleepKey(s))).length;
    },

    exportJSON() {
      return JSON.stringify({ app: 'napberry', version: 1, exportedAt: Date.now(), ...state }, null, 2);
    },
    /** Merge a JSON backup into the current data. Returns merge counts. */
    importJSON(text) {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.sleeps)) throw new Error('Not a Napberry backup file.');
      if (!state.baby && data.baby) state.baby = data.baby;
      const result = store.mergeSleeps(data.sleeps);
      if (!result.added) commit();
      return result;
    },
    reset() {
      state = EMPTY();
      commit();
    },
  };
  return store;
}
