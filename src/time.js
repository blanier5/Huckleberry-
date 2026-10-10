export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function minutesOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** Timestamp of `minutes` past local midnight on the day containing `ms`. */
export function atTime(ms, minutes) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d.getTime();
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** "YYYY-MM-DD" -> local midnight timestamp. */
export function parseDateOnly(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
}

export function ageInMonths(birthMs, nowMs) {
  return Math.max(0, (nowMs - birthMs) / DAY / 30.4375);
}

export function fmtAge(months) {
  if (months < 1) {
    const weeks = Math.floor(months * 4.345);
    return weeks <= 0 ? 'newborn' : `${weeks} wk`;
  }
  if (months < 24) return `${Math.floor(months)} mo`;
  const y = Math.floor(months / 12);
  const mo = Math.floor(months % 12);
  return mo ? `${y} yr ${mo} mo` : `${y} yr`;
}

export function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtMinutesAsClock(minutes) {
  return fmtClock(atTime(Date.now(), minutes));
}

/** 80 -> "1h 20m", 45 -> "45m", 120 -> "2h". */
export function fmtDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** "in 12 min", "5 min ago", "now" */
export function fmtRelative(ms, now) {
  const diff = Math.round((ms - now) / MIN);
  if (Math.abs(diff) < 1) return 'now';
  const abs = Math.abs(diff);
  const label = abs < 60 ? `${abs} min` : fmtDuration(abs);
  return diff > 0 ? `in ${label}` : `${label} ago`;
}

export function dayLabel(ms, now = Date.now()) {
  const diff = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

const pad = (n) => String(n).padStart(2, '0');

/** Timestamp -> value for <input type="datetime-local">. */
export function toInputValue(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromInputValue(str) {
  const ms = new Date(str).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** "19:00" -> 1140 */
export function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str || '');
  if (!m) return null;
  return +m[1] * 60 + +m[2];
}

export function toHHMM(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
