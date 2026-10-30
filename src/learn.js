// Learns one baby's rhythm from the log. Everything here is a function of time of day and recent
// history, never of "which nap number is this", because at young ages the number of naps in a day
// swings a lot (4 to 7 is normal for a 2-month-old) and a nap count is not a goal.

import { buildDays, median, bedtimeMinutes } from './analysis.js';
import { MIN, DAY, clamp, minutesOfDay } from './time.js';

const DAYTIME_FROM = 5.5; // hours: wake windows that start in this range count as "daytime"
const DAYTIME_TO = 23;
const LOOKBACK_DAYS = 21;
const HALF_LIFE_DAYS = 8; // newer days count more
const TOD_SIGMA_H = 1.5; // how close in time of day two observations must be to inform each other

const hourOf = (ms) => {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
};

/**
 * How the length of the nap just finished changes the wake window that follows (1 = ordinary).
 * A nap under about 30-40 minutes isn't a restorative nap, so the next window is shorter; once a
 * nap is a normal length the effect levels off.
 */
const QUALITY = [
  [10, 0.62],
  [20, 0.74],
  [30, 0.85],
  [40, 0.93],
  [50, 0.98],
  [60, 1.0],
  [90, 1.03],
  [120, 1.05],
];
export function napQuality(minutes) {
  if (!Number.isFinite(minutes)) return 1;
  if (minutes <= QUALITY[0][0]) return QUALITY[0][1];
  for (let i = 1; i < QUALITY.length; i++) {
    const [x1, y1] = QUALITY[i];
    if (minutes <= x1) {
      const [x0, y0] = QUALITY[i - 1];
      return y0 + ((y1 - y0) * (minutes - x0)) / (x1 - x0);
    }
  }
  return QUALITY[QUALITY.length - 1][1];
}

/** Typical wake window for an age, nudged longer through the day. Used until there is data. */
export const windowPrior = (norms, hour) => norms.ww * (0.92 + 0.2 * clamp((hour - 7) / 13, 0, 1));
/** Typical nap length for an age: naps get shorter toward evening. */
export const napLenPrior = (norms, hour) => norms.napLen * (1 - 0.4 * clamp((hour - 9) / 11, 0, 1));

function weightedQuantile(items, q) {
  const v = items.filter((x) => Number.isFinite(x.v) && x.w > 0).sort((a, b) => a.v - b.v);
  const total = v.reduce((s, x) => s + x.w, 0);
  if (!v.length || total <= 0) return null;
  let acc = 0;
  for (const x of v) {
    acc += x.w;
    if (acc >= total * q) return x.v;
  }
  return v[v.length - 1].v;
}

/** Weighted median and spread (median absolute deviation) of observations near `hour`. */
function localEstimate(obs, hour, now) {
  const items = [];
  let n = 0;
  for (const o of obs) {
    const age = (now - o.at) / DAY;
    const w = Math.pow(0.5, age / HALF_LIFE_DAYS) * Math.exp(-0.5 * ((hour - o.h) / TOD_SIGMA_H) ** 2);
    if (w < 0.01) continue;
    items.push({ v: o.v, w });
    n += w;
  }
  if (n < 0.75) return null;
  const minutes = weightedQuantile(items, 0.5);
  const spread = weightedQuantile(
    items.map((x) => ({ v: Math.abs(x.v - minutes), w: x.w })),
    0.5,
  );
  return { minutes, spread, n };
}

/**
 * Compare last night with her usual nights. Returns severity 0 (a normal night) to 1 (a very rough
 * one), and how much to shorten wake windows and loosen the extra-nap rules today.
 */
function nightQuality(days, open, now) {
  const empty = { severity: 0, poor: false, last: null, usual: null, windowFactor: 1, napFlex: 1 };
  const last = open?.night;
  if (!last || now - last.end > 20 * 60 * MIN) return empty;
  const before = days.filter((d) => d.night && d.night.end < last.start).slice(-10).map((d) => d.night);
  if (before.length < 4) return { ...empty, last };
  const usual = {
    asleep: median(before.map((n) => n.asleep)),
    longest: median(before.map((n) => n.longest)),
    chunks: median(before.map((n) => n.chunks)),
  };
  const a = usual.asleep > 0 ? clamp((1 - last.asleep / usual.asleep - 0.1) / 0.3, 0, 1) : 0;
  const b = usual.longest > 0 ? clamp((1 - last.longest / usual.longest - 0.15) / 0.35, 0, 1) : 0;
  const c = clamp((last.chunks - usual.chunks - 1) / 3, 0, 1);
  const severity = Math.max(a, b, 0.8 * c);
  return { severity, poor: severity >= 0.25, last, usual, windowFactor: 1 - 0.09 * severity, napFlex: 1 + 0.3 * severity };
}

/**
 * Build everything the planner needs to know about this baby.
 *
 * sleeps may include `flags: { early, planned }` on a sleep: the parent said she fell asleep earlier
 * than suggested, and `planned` is when the app had suggested. Those are treated as information
 * about her, not as noise. A nap flagged `cut` (woken or disturbed) is left out of her usual nap
 * length, since it says nothing about how long she naps when left alone.
 */
export function learnRhythm(sleeps, { now = Date.now(), maxGapMin = 240 } = {}) {
  const from = now - LOOKBACK_DAYS * DAY;
  const done = sleeps
    .filter((s) => s.end != null && s.end > s.start && s.end <= now && s.end >= from)
    .sort((a, b) => a.start - b.start);

  const windows = [];
  const early = [];
  for (let i = 0; i + 1 < done.length; i++) {
    const a = done[i];
    const b = done[i + 1];
    const gap = (b.start - a.end) / MIN;
    const h = hourOf(a.end);
    if (gap < 15 || gap > maxGapMin || h < DAYTIME_FROM || h >= DAYTIME_TO) continue;
    const len = (a.end - a.start) / MIN;
    const q = a.kind === 'nap' && len <= 180 ? napQuality(len) : 1;
    // Divide out the nap-quality effect so a day of short naps doesn't drag the "normal" window down.
    windows.push({ at: a.end, h, v: gap / q });
    if (b.flags?.early && Number.isFinite(b.flags.planned)) {
      const planned = (b.flags.planned - a.end) / MIN;
      if (planned >= 20) early.push({ at: a.end, h, v: clamp(gap / planned, 0.4, 1) });
    }
  }
  const naps = done
    .filter((s) => s.kind === 'nap' && !s.flags?.cut && (s.end - s.start) / MIN >= 5 && (s.end - s.start) / MIN <= 180)
    .map((s) => ({ at: s.start, h: hourOf(s.start), v: (s.end - s.start) / MIN }));

  const { days, open } = buildDays(sleeps.filter((s) => s.end != null && s.end <= now));
  const sane = days.filter((d) => d.sane).slice(-10);

  return {
    windowCount: windows.length,
    napCount: naps.length,
    /** Typical wake window near `hour` for an ordinary-length previous nap, or null with too little data. */
    windowAt: (hour) => localEstimate(windows, hour, now),
    /** Typical nap length near `hour`, or null. */
    napLenAt: (hour) => localEstimate(naps, hour, now),
    /**
     * Multiplier from "fell asleep early" notes: 1 means no evidence, 0.85 means she has been
     * falling asleep about 15% sooner than the plan near this time of day.
     */
    cueAt(hour) {
      const e = localEstimate(early, hour, now);
      if (!e) return 1;
      return clamp(1 + (e.minutes - 1) * (e.n / (e.n + 2)), 0.7, 1);
    },
    cueCount: early.length,
    night: nightQuality(days, open, now),
    bedMin: sane.length >= 3 ? median(sane.map(bedtimeMinutes)) : null,
    wakeMin: sane.length >= 3 ? median(sane.map((d) => minutesOfDay(d.wake))) : null,
    days: sane.length,
  };
}
