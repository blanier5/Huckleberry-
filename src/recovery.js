// Rough days. A day with short or interrupted naps, trouble settling, shots, an appointment or an
// illness leaves a baby needing more sleep, not an exact bedtime. When the day looks like that,
// Napberry stops asking you to wake her to protect bedtime, lets naps run long, offers an extra nap
// when it helps, and lets bedtime slide later instead of cutting sleep short.
//
// Two things switch it on, and either is enough:
//   - what the log shows today: short naps, naps marked "cut short", marked trouble settling, and a
//     rough night, each adding to a 0..1 strain score
//   - rough-day mode, which a parent turns on by hand for vaccinations, appointments, illness, travel
//
// Pure functions of the sleep log and settings: nothing here is stored, so every phone agrees.

import { MIN, HOUR, clamp, minutesOfDay } from './time.js';
import { napQuality } from './learn.js';

/** Reasons a parent can give for a rough day. They are for the family's memory and the explanations. */
export const REASONS = [
  { key: 'vaccine', label: 'Vaccination or shots' },
  { key: 'appointment', label: 'Doctor or other appointment' },
  { key: 'illness', label: 'Not feeling well' },
  { key: 'travel', label: 'Travel or a change of routine' },
  { key: 'naps', label: 'Naps keep getting interrupted' },
  { key: 'settling', label: 'Trouble settling or failed transfers' },
];
export const REASON_KEYS = new Set(REASONS.map((r) => r.key));

/** How she settled for a sleep: 0 easily (nothing saved), 1 it took a while, 2 several failed transfers. */
export const SETTLE_LABELS = { 1: 'took a while to settle', 2: 'several failed transfers' };

/** A strain score at or above this counts as a rough day. */
export const RELAXED_AT = 0.6;
const MANUAL_MAX = 36 * HOUR;
const MORNING = 4.5 * 60; // a night sleep that ends after this is the wake-up that starts the day

const WEIGHT = { short: 0.35, cut: 0.4, slow: 0.2, hard: 0.45, night: 0.5 };

/** What bending is allowed on a rough day; a milder strain moves only part of the way there. */
const REST = { slack: 90, flexW: 0.8, flexL: 0.6, lastHi: 1.35, windowBias: 0.94, napBias: 1.1 };

const isMorningWake = (s) => s.kind === 'night' && s.end != null && minutesOfDay(s.end) >= MORNING;

/**
 * The rough-day mode a parent switched on, if it is still on. It ends when she wakes for the day
 * after the night that follows (or after 36 hours, if the log goes quiet), so it never lingers.
 * recovery: { since: ms, reasons: [keys] }
 */
export function activeRecovery(recovery, sleeps, now) {
  if (!recovery || !Number.isFinite(recovery.since)) return null;
  if (now - recovery.since > MANUAL_MAX) return null;
  const woke = sleeps.some((s) => isMorningWake(s) && s.end >= recovery.since && s.end <= now);
  return woke ? null : recovery;
}

/** The naps that belong to the day being judged: since she last woke for the day (or the day just ended, overnight). */
function daysNaps(sleeps, now) {
  const ongoing = sleeps.find((s) => s.end == null && s.start <= now);
  const done = sleeps.filter((s) => s.end != null && s.end > s.start && s.end <= now).sort((a, b) => a.start - b.start);
  const anchor = ongoing?.kind === 'night' ? ongoing.start : now;
  const morning = [...done].reverse().find((s) => isMorningWake(s) && s.end <= anchor);
  const from = morning && anchor - morning.end < 20 * HOUR ? morning.end : anchor - 16 * HOUR;
  const all = ongoing?.kind === 'nap' ? [...done, ongoing] : done;
  return { naps: all.filter((s) => s.kind === 'nap' && s.start >= from && s.start <= anchor), overnight: ongoing?.kind === 'night' };
}

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How strained today has been, 0 (an ordinary day) to 1.
 *
 *   level      the score
 *   relaxed    level >= RELAXED_AT: be flexible (see relaxPolicy)
 *   manual     a parent turned rough-day mode on
 *   signals    short phrases for the "why" panel, e.g. "2 short naps"
 *
 * `typicalNap(hour)` (optional) is how long her naps usually run then. A nap is only "short" if it is
 * short for her too, so a baby who always catnaps is not called strained every day.
 */
export function assessDay({ sleeps, settings = {}, rhythm = null, typicalNap = null, now }) {
  const manual = activeRecovery(settings.recovery, sleeps, now);
  const { naps, overnight } = daysNaps(sleeps, now);

  let level = 0;
  let short = 0;
  let cut = 0;
  let hard = 0;
  let slow = 0;
  for (const nap of naps) {
    const minutes = ((nap.end ?? now) - nap.start) / MIN;
    // The same curve that shortens the next window after a short nap says how short is too short,
    // unless short is how her naps usually are.
    let shortness = nap.end == null ? 0 : clamp((0.93 - napQuality(minutes)) / 0.25, 0, 1);
    const typical = nap.end == null ? null : typicalNap?.(new Date(nap.start).getHours() + new Date(nap.start).getMinutes() / 60);
    if (typical) shortness = Math.min(shortness, clamp((0.85 * typical - minutes) / (0.5 * typical), 0, 1));
    if (shortness >= 0.3) short++;
    level += WEIGHT.short * shortness;
    if (nap.flags?.cut) {
      cut++;
      level += WEIGHT.cut;
    }
    if (nap.flags?.settle === 2) {
      hard++;
      level += WEIGHT.hard;
    } else if (nap.flags?.settle === 1) {
      slow++;
      level += WEIGHT.slow;
    }
  }
  const night = !overnight && rhythm?.night?.poor ? rhythm.night.severity : 0;
  level += WEIGHT.night * night;

  const signals = [];
  if (short) signals.push(count(short, 'short nap'));
  if (cut) signals.push(count(cut, 'interrupted nap'));
  if (hard) signals.push('several failed transfers');
  if (slow) signals.push(slow === 1 ? 'a slow settle' : `${slow} slow settles`);
  if (night) signals.push('a rough night');

  level = manual ? 1 : Math.min(1, level);
  return {
    level,
    relaxed: level >= RELAXED_AT,
    manual: Boolean(manual),
    since: manual ? manual.since : null,
    manualReasons: manual ? (manual.reasons ?? []).filter((k) => REASON_KEYS.has(k)) : [],
    signals,
  };
}

/** The reasons as words, for the rough-day card and the "why" panel. */
export const reasonLabels = (keys) => REASONS.filter((r) => keys.includes(r.key)).map((r) => r.label.toLowerCase());

/**
 * The planning policy for a strained day: a blend from the family's priority toward "protect rest".
 * Wake-by prompts stop on a rough day, and the more strained the day the more bedtime may move,
 * windows shorten a little, naps resist being cut short, and a longer last stretch is acceptable.
 */
export function relaxPolicy(policy, strain) {
  const f = clamp((strain.level - 0.3) / 0.4, 0, 1);
  if (f <= 0) return policy;
  const mix = (a, b) => a + (b - a) * f;
  return {
    ...policy,
    slack: mix(policy.slack, Math.max(policy.slack, REST.slack)),
    flexW: mix(policy.flexW, Math.min(policy.flexW, REST.flexW)),
    flexL: mix(policy.flexL, Math.min(policy.flexL, REST.flexL)),
    lastHi: mix(policy.lastHi, Math.max(policy.lastHi, REST.lastHi)),
    windowBias: mix(policy.windowBias, Math.min(policy.windowBias, REST.windowBias)),
    napBias: mix(policy.napBias, Math.max(policy.napBias, REST.napBias)),
    wakeBy: policy.wakeBy && !strain.relaxed,
  };
}
