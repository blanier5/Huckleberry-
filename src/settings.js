// The schedule settings a family can choose, and the checks that keep stored or synced values
// sane. Every key is optional, and a missing key means "not chosen", so settings saved by older
// versions of the app (which only had `bedtime`) stay valid.

import { PRIORITIES } from './planner.js';
import { validShift } from './shift.js';
import { REASON_KEYS } from './recovery.js';

export const defaultSettings = () => ({
  bedtime: null, // desired bedtime 'HH:MM' (null = learn it from recent days)
  bedShift: null, // { pace, startedAt, fromMin }: move toward `bedtime` gradually instead of at once
  wake: null, // { time: 'HH:MM', range: minutes }: target morning wake time and how far either side is fine
  wakeShift: null, // same shape as bedShift, for the wake time
  priority: null, // 'protect' | 'sleep' | 'wake' | 'cues' (null = protect bedtime)
  recovery: null, // { since: ms, reasons: [keys] }: rough-day mode, switched on by hand (null = off)
});

const HHMM = /^\d{2}:\d{2}$/;

/** Keep only the valid settings among those present in `raw`. A key that is absent stays absent. */
export function cleanSettingsPatch(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if ('bedtime' in raw) out.bedtime = typeof raw.bedtime === 'string' && HHMM.test(raw.bedtime) ? raw.bedtime : null;
  if ('bedShift' in raw) out.bedShift = validShift(raw.bedShift) ? { pace: raw.bedShift.pace, startedAt: raw.bedShift.startedAt, fromMin: raw.bedShift.fromMin } : null;
  if ('wake' in raw) {
    const w = raw.wake;
    out.wake = w && typeof w.time === 'string' && HHMM.test(w.time) ? { time: w.time, range: Math.min(90, Math.max(10, Number(w.range) || 30)) } : null;
  }
  if ('wakeShift' in raw) out.wakeShift = validShift(raw.wakeShift) ? { pace: raw.wakeShift.pace, startedAt: raw.wakeShift.startedAt, fromMin: raw.wakeShift.fromMin } : null;
  if ('priority' in raw) out.priority = typeof raw.priority === 'string' && PRIORITIES[raw.priority] ? raw.priority : null;
  if ('recovery' in raw) {
    const r = raw.recovery;
    out.recovery =
      r && typeof r === 'object' && Number.isFinite(r.since) && r.since > 0
        ? { since: Math.round(r.since), reasons: [...new Set(Array.isArray(r.reasons) ? r.reasons : [])].filter((k) => REASON_KEYS.has(k)) }
        : null;
  }
  return out;
}

export const cleanSettings = (raw) => ({ ...defaultSettings(), ...cleanSettingsPatch(raw) });

/**
 * Notes a parent can put on a sleep:
 *   early    she fell asleep earlier than suggested; `planned` is when the app had suggested
 *   settle   how she went down: 1 it took a while, 2 several failed transfers (absent = easily)
 *   cut      the nap was cut short (woken or disturbed), so its length isn't her natural nap
 */
export function cleanFlags(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const flags = {};
  if (raw.early === true) flags.early = true;
  if (Number.isFinite(raw.planned) && raw.planned > 0) flags.planned = Math.round(raw.planned);
  if (raw.settle === 1 || raw.settle === 2) flags.settle = raw.settle;
  if (raw.cut === true) flags.cut = true;
  return Object.keys(flags).length ? flags : undefined;
}
