import { MIN, HOUR, DAY, minutesOfDay, startOfDay } from './time.js';

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Huckleberry (and most trackers) log one kind of "sleep". We separate naps
 * from night sleep by clock time and length. Users can override either.
 */
export function classifySleep(start, end) {
  const minutes = end == null ? 0 : (end - start) / MIN;
  if (minutes >= 300) return 'night';
  const tod = minutesOfDay(start);
  return tod >= 18 * 60 || tod < 5 * 60 + 30 ? 'night' : 'nap';
}

/**
 * A baby can't start two sleeps in the same minute, so the start minute identifies a sleep.
 * Every device derives the same id on its own, which is what lets re-imports and sync
 * merge without creating duplicates.
 */
export function sleepId(start) {
  return `s${Math.round(start / MIN)}`;
}

/**
 * Collapse completed sleeps into "days": morning wake-up -> naps -> bedtime.
 * Night wakings are folded into the night block so they never look like wake
 * windows. Returns { days, open } where `open` is the current, unfinished day.
 */
export function buildDays(sleeps) {
  const done = sleeps
    .filter((s) => s.end != null && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const items = [];
  for (const s of done) {
    const last = items[items.length - 1];
    const continuesNight =
      last &&
      last.kind === 'night' &&
      ((s.kind === 'night' && s.start - last.end < 3 * HOUR) ||
        // A short early-morning "nap" right after a night waking is still night.
        (s.kind === 'nap' && s.start - last.end < 90 * MIN && minutesOfDay(s.start) < 7 * 60));
    if (continuesNight) last.end = Math.max(last.end, s.end);
    else items.push({ kind: s.kind, start: s.start, end: s.end });
  }

  const days = [];
  let cur = null;
  for (const it of items) {
    if (it.kind === 'night') {
      if (cur) {
        cur.bedtime = it.start;
        cur.sane = isSane(cur);
        days.push(cur);
      }
      cur = { date: startOfDay(it.end), wake: it.end, naps: [], bedtime: null, sane: false };
    } else if (cur) {
      cur.naps.push(it);
    }
  }
  return { days, open: cur };
}

/**
 * Bedtime as minutes after the midnight that starts the day, so a bedtime just past midnight
 * is 24:15 (1455) rather than 0:15. Keeps late bedtimes comparable and medians meaningful.
 */
export function bedtimeMinutes(day) {
  const clock = new Date(day.bedtime);
  // Whole days between the two calendar dates (not hours, so a daylight-saving change can't skew it).
  const dayDiff = Math.round((startOfDay(day.bedtime) - startOfDay(day.wake)) / DAY);
  return clock.getHours() * 60 + clock.getMinutes() + dayDiff * 24 * 60;
}

// Guards the learned profile against gaps in logging and odd data.
function isSane(d) {
  const wake = minutesOfDay(d.wake);
  const bed = bedtimeMinutes(d);
  const hours = (d.bedtime - d.wake) / HOUR;
  return (
    wake >= 4 * 60 &&
    wake <= 10.5 * 60 &&
    bed >= 16 * 60 &&
    bed <= 24.5 * 60 &&
    hours >= 6 &&
    hours <= 17 &&
    d.naps.every((n) => n.start > d.wake && n.end < d.bedtime)
  );
}

export function dayMetrics(d) {
  const windows = [];
  let t = d.wake;
  for (const n of d.naps) {
    windows.push((n.start - t) / MIN);
    t = n.end;
  }
  windows.push((d.bedtime - t) / MIN);
  return { windows, napLens: d.naps.map((n) => (n.end - n.start) / MIN) };
}

/**
 * Learn the baby's current rhythm from the most recent complete days.
 * Returns null when there isn't enough recent, sensible data.
 */
export function buildProfile(sleeps, { now = Date.now(), lookbackDays = 14, maxAgeDays = 30 } = {}) {
  const { days } = buildDays(sleeps);
  const recent = days
    .filter((d) => d.sane && d.bedtime <= now && now - d.bedtime <= maxAgeDays * DAY)
    .slice(-lookbackDays);
  if (recent.length < 3) return null;

  const napCount = Math.round(median(recent.map((d) => d.naps.length)));
  // Only days with the same nap count line up slot-for-slot.
  const matching = recent.filter((d) => d.naps.length === napCount).map((d) => dayMetrics(d));

  const windows = [];
  const napLens = [];
  for (let i = 0; i <= napCount; i++) {
    windows.push(matching.length >= 2 ? median(matching.map((m) => m.windows[i])) : null);
    if (i < napCount) napLens.push(matching.length >= 2 ? median(matching.map((m) => m.napLens[i])) : null);
  }

  return {
    days: recent.length,
    matching: matching.length,
    napCount,
    windows,
    napLens,
    bedtimeMin: median(recent.map(bedtimeMinutes)),
    wakeMin: median(recent.map((d) => minutesOfDay(d.wake))),
    // More matching days -> trust the baby's own numbers more.
    weight: matching.length / (matching.length + 3),
  };
}

/**
 * Group a flat sleep list into days, newest first. Naps belong to the day they
 * start; night sleep belongs to the morning it ends, so each day reads as
 * "last night + today's naps" instead of splitting a night across two cards.
 * (An unfinished night is shown under today.)
 */
export function groupByDay(sleeps, now = Date.now()) {
  const map = new Map();
  for (const s of sleeps) {
    const wakeDay = s.end != null ? startOfDay(s.end) : startOfDay(s.start + 12 * HOUR);
    const key = s.kind === 'night' ? Math.min(wakeDay, startOfDay(now)) : startOfDay(s.start);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([date, items]) => {
      items.sort((a, b) => b.start - a.start);
      const done = items.filter((s) => s.end != null);
      const naps = done.filter((s) => s.kind === 'nap');
      const nights = done.filter((s) => s.kind === 'night');
      const total = (list) => list.reduce((sum, s) => sum + (s.end - s.start) / MIN, 0);
      return { date, items, napCount: naps.length, napMinutes: total(naps), nightMinutes: total(nights) };
    });
}
