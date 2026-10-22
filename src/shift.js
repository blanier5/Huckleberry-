// Gradual shifting: move bedtime (or the morning wake time) toward a target a few minutes at a
// time, at the pace the baby actually keeps up with, instead of one sudden jump.
//
// Pure functions of the sleep log and the settings, so every phone that syncs the same log and
// settings shows the same target, and nothing here is stored or modifies the log.

import { buildDays, bedtimeMinutes, median } from './analysis.js';
import { parseHHMM, clamp, minutesOfDay } from './time.js';

export const PACES = {
  gentle: { key: 'gentle', label: 'Gentle', step: 10, hold: 3, blurb: '10 min every 3 days' },
  steady: { key: 'steady', label: 'Steady', step: 15, hold: 3, blurb: '15 min every 3 days' },
  quick: { key: 'quick', label: 'Quicker', step: 15, hold: 2, blurb: '15 min every 2 days' },
};
export const DEFAULT_PACE = 'steady';

export const BED_MIN = 17 * 60;
export const BED_MAX = 23 * 60 + 45;
export const WAKE_MIN = 4 * 60;
export const WAKE_MAX = 11 * 60;
export const DEFAULT_RANGE = 30;
export const RANGES = [15, 30, 45, 60];

/** A day counts as "on target" if it landed within this many minutes (or already past it toward the goal). */
export const TOLERANCE = 20;
/** After this many misses in a row, the target eases back toward what she is actually doing. */
export const EASE_AFTER = 4;

const round5 = (m) => Math.round(m / 5) * 5;
const moveToward = (from, goal, step) => (from < goal ? Math.min(goal, from + step) : Math.max(goal, from - step));

export function validShift(shift) {
  return Boolean(
    shift &&
      typeof shift === 'object' &&
      PACES[shift.pace] &&
      Number.isFinite(shift.startedAt) &&
      Number.isFinite(shift.fromMin) &&
      shift.fromMin >= 0 &&
      shift.fromMin <= 26 * 60,
  );
}

/**
 * Replay the observations since the shift began and say where the target stands.
 *
 * Rules, for each observation in order:
 *   - on target (within TOLERANCE, or already past it toward the goal): count it
 *   - enough in a row (pace.hold): move the target one step toward the goal
 *   - off target: start counting again; after EASE_AFTER misses in a row, re-anchor to the median
 *     of the last three, then take at most one step from there, so the target is never more than
 *     one step ahead of what she is really doing
 */
export function stageTarget({ fromMin, goalMin, pace: paceKey, obs }) {
  const pace = PACES[paceKey] ?? PACES[DEFAULT_PACE];
  let target = round5(fromMin);
  let hits = 0;
  let misses = 0;
  let steps = 0;
  let eased = false;
  const history = [];

  for (let i = 0; i < obs.length; i++) {
    const v = obs[i].min;
    if (target === goalMin) {
      history.push({ ...obs[i], target, hit: Math.abs(v - target) <= TOLERANCE });
      continue;
    }
    const toward = goalMin < target ? -1 : 1;
    const hit = toward < 0 ? v <= target + TOLERANCE : v >= target - TOLERANCE;
    history.push({ ...obs[i], target, hit });
    eased = false;
    if (hit) {
      misses = 0;
      if (++hits >= pace.hold) {
        target = moveToward(target, goalMin, pace.step);
        steps++;
        hits = 0;
      }
    } else {
      hits = 0;
      if (++misses >= EASE_AFTER) {
        const reality = round5(median(obs.slice(Math.max(0, i - 2), i + 1).map((o) => o.min)));
        const candidate = moveToward(reality, goalMin, pace.step);
        // Only ever ease back (away from the goal); never jump ahead.
        if (toward < 0 ? candidate > target : candidate < target) {
          target = candidate;
          eased = true;
        }
        misses = 0;
      }
    }
  }

  const reached = target === goalMin;
  const path = [target];
  while (path[path.length - 1] !== goalMin && path.length < 60) path.push(moveToward(path[path.length - 1], goalMin, pace.step));
  const recent = obs.slice(-3).map((o) => o.min);
  return {
    goalMin,
    fromMin: round5(fromMin),
    targetMin: target,
    direction: reached ? 'reached' : goalMin < target ? 'earlier' : 'later',
    reached,
    step: pace.step,
    hold: pace.hold,
    pace: pace.key,
    steps,
    stepsLeft: reached ? 0 : path.length - 1,
    hits,
    misses,
    eased,
    count: obs.length,
    recentMin: recent.length ? round5(median(recent)) : null,
    path,
    history,
  };
}

/** Median bedtime over the most recent complete days, or null with too little data. */
export function recentBedtime(sleeps, now = Date.now(), n = 7) {
  const days = buildDays(sleeps).days.filter((d) => d.sane && d.bedtime <= now);
  return days.length < 3 ? null : round5(median(days.slice(-n).map(bedtimeMinutes)));
}

/** Median morning wake time over the most recent days, or null with too little data. */
export function recentWake(sleeps, now = Date.now(), n = 7) {
  const days = buildDays(sleeps).days.filter((d) => d.sane && d.wake <= now);
  return days.length < 3 ? null : round5(median(days.slice(-n).map((d) => minutesOfDay(d.wake))));
}

/**
 * Tonight's bedtime target. `settings.bedtime` is the bedtime she should end up at. With a
 * `bedShift` the target moves toward it step by step; without one it is simply that time.
 * Returns null if no bedtime has been chosen.
 */
export function bedtimeTarget({ settings, sleeps, now = Date.now() }) {
  const goalMin = parseHHMM(settings?.bedtime);
  if (goalMin == null || goalMin < BED_MIN || goalMin > BED_MAX) return null;
  if (!validShift(settings.bedShift)) return { goalMin, targetMin: goalMin, shift: null };
  const obs = buildDays(sleeps)
    .days.filter((d) => d.sane && d.bedtime >= settings.bedShift.startedAt && d.bedtime <= now)
    .map((d) => ({ at: d.bedtime, min: bedtimeMinutes(d) }));
  const shift = stageTarget({ fromMin: settings.bedShift.fromMin, goalMin, pace: settings.bedShift.pace, obs });
  return { goalMin, targetMin: shift.targetMin, shift };
}

/**
 * The morning wake target and its range: "8:00 AM, plus or minus 30 minutes" is 7:30 to 8:30.
 * With a `wakeShift` the target works toward it gradually. Null if no wake time has been chosen.
 */
export function wakeTarget({ settings, sleeps, now = Date.now() }) {
  const goalMin = parseHHMM(settings?.wake?.time);
  if (goalMin == null || goalMin < WAKE_MIN || goalMin > WAKE_MAX) return null;
  const range = clamp(Number(settings.wake.range) || DEFAULT_RANGE, 10, 90);
  let targetMin = goalMin;
  let shift = null;
  if (validShift(settings.wakeShift)) {
    const { days, open } = buildDays(sleeps);
    const mornings = [...days, ...(open ? [open] : [])]
      .filter((d) => d.wake >= settings.wakeShift.startedAt && d.wake <= now && minutesOfDay(d.wake) >= WAKE_MIN && minutesOfDay(d.wake) <= WAKE_MAX + 120)
      .map((d) => ({ at: d.wake, min: minutesOfDay(d.wake) }));
    shift = stageTarget({ fromMin: settings.wakeShift.fromMin, goalMin, pace: settings.wakeShift.pace, obs: mornings });
    targetMin = shift.targetMin;
  }
  return { goalMin, targetMin, range, lowMin: targetMin - range, highMin: targetMin + range, shift };
}
