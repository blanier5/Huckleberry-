import { parseCSV } from './csv.js';
import { classifySleep, sleepId } from './analysis.js';
import { MIN } from './time.js';

// Huckleberry's CSV export has one row per tracked event with columns like
//   Start, End, Duration, Type, Start Condition, Start Location, End Condition, Notes
// We only need the Sleep rows. The parser is deliberately forgiving about
// header names, date formats and duration formats, because exports vary a bit
// by app version and locale.

const ALIASES = {
  start: ['start', 'starttime', 'startdatetime', 'begin', 'begintime'],
  end: ['end', 'endtime', 'enddatetime'],
  duration: ['duration', 'length', 'totaltime'],
  type: ['type', 'activity', 'event', 'category', 'entrytype'],
  notes: ['notes', 'note', 'comment', 'comments'],
  date: ['date', 'day'],
};

const normHeader = (s) => s.toLowerCase().replace(/[^a-z]/g, '');

function findColumns(header) {
  const norm = header.map(normHeader);
  const cols = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const idx = norm.findIndex((h) => names.includes(h));
    if (idx !== -1) cols[key] = idx;
  }
  return cols;
}

const pad2 = (n) => String(n).padStart(2, '0');

function to24h(h, ap) {
  h = +h;
  if (!ap) return h;
  const pm = ap.toLowerCase() === 'pm';
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

function localDate(y, mo, d, h = 0, mi = 0, s = 0) {
  const date = new Date(y, mo - 1, d, h, mi, s);
  // Reject overflowed values such as month 13 or Feb 31.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

const ISO = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([AaPp][Mm])?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const SLASH = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[T\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;

/** Returns epoch ms (device-local time unless the string carries a zone), or null. */
export function parseDateTime(str, order = 'mdy') {
  const s = String(str ?? '').trim();
  if (!s) return null;
  let m = ISO.exec(s);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0', ap, tz] = m;
    const hour = to24h(h, ap);
    if (tz) {
      const zone = tz === 'Z' ? 'Z' : tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz;
      const t = Date.parse(`${y}-${pad2(mo)}-${pad2(d)}T${pad2(hour)}:${pad2(mi)}:${pad2(sec)}${zone}`);
      return Number.isFinite(t) ? t : null;
    }
    return localDate(+y, +mo, +d, hour, +mi, +sec);
  }
  m = SLASH.exec(s);
  if (m) {
    const [, a, b, yr, h = '0', mi = '0', sec = '0', ap] = m;
    const [mo, d] = order === 'dmy' ? [+b, +a] : [+a, +b];
    const y = yr.length === 2 ? 2000 + +yr : +yr;
    return localDate(y, mo, d, to24h(h, ap), +mi, +sec);
  }
  // Textual formats like "Oct 10, 2026 2:30 PM".
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** "14:05" or "2:05 PM" -> minutes after midnight, or null. */
export function parseTimeOfDay(str) {
  const m = TIME_ONLY.exec(String(str ?? '').trim());
  if (!m) return null;
  return to24h(m[1], m[4]) * 60 + +m[2];
}

/** "01:23", "1:23:45", "1h 23m", "83 min", "83" -> minutes, or null. */
export function parseDuration(str) {
  const s = String(str ?? '').trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return +m[1] * 60 + +m[2] + (m[3] ? +m[3] / 60 : 0);
  m = /^(?:(\d+(?:\.\d+)?)\s*h(?:rs?|ours?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:ins?|inutes?)?)?$/.exec(s);
  if (m && (m[1] || m[2])) return (m[1] ? +m[1] * 60 : 0) + (m[2] ? +m[2] : 0);
  m = /^\d+(?:\.\d+)?$/.exec(s);
  return m ? +s : null;
}

function detectDateOrder(rows, col) {
  if (col == null) return 'mdy';
  for (const r of rows) {
    const m = SLASH.exec((r[col] ?? '').trim());
    if (!m) continue;
    if (+m[1] > 12) return 'dmy';
    if (+m[2] > 12) return 'mdy';
  }
  return 'mdy';
}

/**
 * Parse a Huckleberry CSV export into sleeps.
 *
 * Returns { ok, error?, sleeps, stats } where each sleep is
 *   { id, start, end, kind: 'nap' | 'night', notes, source: 'huckleberry' }
 */
export function parseHuckleberryCSV(text) {
  const rows = parseCSV(text);
  const headerIdx = rows.slice(0, 10).findIndex((r) => findColumns(r).start != null);
  if (headerIdx === -1) {
    return {
      ok: false,
      error: `Couldn't find a "Start" column. Columns seen: ${(rows[0] ?? []).join(', ') || '(none)'}.`,
      sleeps: [],
      stats: null,
    };
  }
  const cols = findColumns(rows[headerIdx]);
  if (cols.end == null && cols.duration == null) {
    return { ok: false, error: 'Found a Start column but no End or Duration column.', sleeps: [], stats: null };
  }

  const body = rows.slice(headerIdx + 1);
  const order = detectDateOrder(body, cols.start);
  const stats = {
    rows: body.length,
    sleepRows: 0,
    skippedNonSleep: 0,
    skippedInvalid: 0,
    invalid: [],
    types: {},
    noTypeColumn: cols.type == null,
    first: null,
    last: null,
    naps: 0,
    nights: 0,
  };
  const sleeps = [];
  const seen = new Set();

  body.forEach((r, i) => {
    const line = headerIdx + i + 2;
    const type = cols.type != null ? (r[cols.type] ?? '').trim() : 'Sleep';
    stats.types[type || '(blank)'] = (stats.types[type || '(blank)'] ?? 0) + 1;
    if (!/sleep|nap/i.test(type)) {
      stats.skippedNonSleep++;
      return;
    }
    stats.sleepRows++;
    const invalid = (reason) => {
      stats.skippedInvalid++;
      if (stats.invalid.length < 5) stats.invalid.push({ line, reason });
    };

    const startRaw = (r[cols.start] ?? '').trim();
    const endRaw = cols.end != null ? (r[cols.end] ?? '').trim() : '';
    const dateRaw = cols.date != null ? (r[cols.date] ?? '').trim() : '';

    let start = parseDateTime(startRaw, order);
    let end = endRaw ? parseDateTime(endRaw, order) : null;

    // Separate Date + time-only Start/End columns.
    if (start == null && dateRaw) {
      const tod = parseTimeOfDay(startRaw);
      const day = parseDateTime(dateRaw, order);
      if (tod != null && day != null) {
        start = day + tod * MIN;
        const endTod = parseTimeOfDay(endRaw);
        if (endTod != null) {
          end = day + endTod * MIN;
          if (end <= start) end += 24 * 60 * MIN;
        }
      }
    }
    if (start == null) return invalid(`unreadable start "${startRaw}"`);

    if (end == null) {
      const dur = cols.duration != null ? parseDuration(r[cols.duration]) : null;
      if (dur == null) return invalid('no end time or duration');
      end = start + dur * MIN;
    }

    const minutes = (end - start) / MIN;
    if (minutes < 1) return invalid('shorter than a minute or ends before it starts');
    if (minutes > 20 * 60) return invalid('longer than 20 hours');

    const id = sleepId(start);
    if (seen.has(id)) {
      stats.skippedInvalid++;
      if (stats.invalid.length < 5) stats.invalid.push({ line, reason: 'another sleep in this file starts at the same time' });
      return;
    }
    seen.add(id);

    const kind = classifySleep(start, end);
    sleeps.push({
      id,
      start,
      end,
      kind,
      notes: cols.notes != null ? (r[cols.notes] ?? '').trim() : '',
      source: 'huckleberry',
    });
    if (kind === 'nap') stats.naps++;
    else stats.nights++;
    stats.first = stats.first == null ? start : Math.min(stats.first, start);
    stats.last = stats.last == null ? end : Math.max(stats.last, end);
  });

  sleeps.sort((a, b) => a.start - b.start);
  return { ok: true, sleeps, stats };
}
