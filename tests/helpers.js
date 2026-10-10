import { MIN } from '../src/time.js';
import { classifySleep } from '../src/analysis.js';

export const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

// Small deterministic PRNG so fixtures are stable.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic history for `days` complete days ending the evening before `endDay`
 * (a local midnight timestamp). Defaults sketch a ~7-month-old on three naps.
 */
export function generateHistory({
  endDay,
  days = 21,
  seed = 1,
  wakeMin = 6 * 60 + 45,
  windows = [115, 130, 145, 165],
  napLens = [60, 75, 35],
  jitter = 10,
  nightWaking = true,
} = {}) {
  const rand = rng(seed);
  const j = (v, spread = jitter) => v + (rand() * 2 - 1) * spread;
  const sleeps = [];
  const dayMs = 24 * 60 * MIN;
  for (let d = days; d >= 1; d--) {
    const midnight = endDay - d * dayMs;
    let t = midnight + j(wakeMin, 10) * MIN;
    napLens.forEach((len, i) => {
      const start = t + j(windows[i]) * MIN;
      const end = start + j(len, 12) * MIN;
      sleeps.push({ start: Math.round(start), end: Math.round(end) });
      t = end;
    });
    const bedtime = Math.round(t + j(windows[napLens.length]) * MIN);
    const wake = Math.round(midnight + dayMs + j(wakeMin, 10) * MIN);
    if (nightWaking && rand() < 0.5) {
      const split = bedtime + Math.round(j(6.5 * 60, 30) * MIN);
      sleeps.push({ start: bedtime, end: split });
      sleeps.push({ start: split + 25 * MIN, end: wake });
    } else {
      sleeps.push({ start: bedtime, end: wake });
    }
  }
  return sleeps.map((s) => ({ ...s, kind: classifySleep(s.start, s.end), notes: '' }));
}

const p2 = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/** Render sleeps (plus a few unrelated rows) in the shape of a Huckleberry export. */
export function toHuckleberryCSV(sleeps) {
  const lines = ['Start,End,Duration,Type,Start Condition,Start Location,End Condition,Notes'];
  sleeps.forEach((s, i) => {
    const mins = Math.round((s.end - s.start) / MIN);
    lines.push(
      [stamp(s.start), stamp(s.end), `${p2(Math.floor(mins / 60))}:${p2(mins % 60)}`, 'Sleep', 'Rocked', 'Crib', 'Happy', i % 17 === 0 ? '"Teething, fussy"' : ''].join(','),
    );
    if (i % 3 === 0) lines.push([stamp(s.end + 5 * MIN), '', '', 'Feed', 'Bottle', '', '', ''].join(','));
    if (i % 5 === 0) lines.push([stamp(s.end + 10 * MIN), '', '', 'Diaper', 'Pee', '', '', ''].join(','));
  });
  return lines.join('\n') + '\n';
}
