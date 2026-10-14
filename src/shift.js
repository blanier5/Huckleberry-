// Gradual bedtime shifting: move bedtime toward a goal a few minutes at a time, at the pace the
// baby actually keeps up with. Pure functions of the sleep log and the goal settings, so every
// phone that syncs the same log and settings shows the same target and nothing here is stored.

import { buildDays, bedtimeMinutes, median } from './analysis.js';
import { parseHHMM } from './time.js';

export const PACES = {
  gentle: { key: 'gentle', label: 'Gentle', step: 10, hold: 3, blurb: '10 min every 3 nights' },
  steady: { key: 'steady', label: 'Steady', step: 15, hold: 3, blurb: '15 min every 3 nights' },
  quick: { key: 'quick', label: 'Quicker', step: 15, hold: 2, blurb: '15 min every 2 nights' },
};

export const GOAL_MIN = 17 * 60;
export const GOAL_MAX = 23 * 60 + 30;

/** A night counts as "on target" if bedtime was within this many minutes (or already past it toward the goal). */
export const TOLERANCE = 20;
/** After this many nights in a row off target, the target eases back toward what she is actually doing. */
export const EASE_AFTER = 4;

const round5 = (m) => Math.round(m / 5) * 5;
const moveToward = (from, goal, step) => (from < goal ? Math.min(goal, from + step) : Math.max(goal, from - step));

/** Median bedtime over the most recent complete nights, or null with too little data. */
export function recentBedtime(sleeps, now = Date.now(), nights = 7) {
  const days = buildDays(sleeps).days.filter((d) => d.sane && d.bedtime <= now);
  if (days.length < 3) return null;
  return round5(median(days.slice(-nights).map(bedtimeMinutes)));
}

export function validGoal(goal) {
  return Boolean(
    goal &&
      typeof goal === 'object' &&
      parseHHMM(goal.time) != null &&
      parseHHMM(goal.time) >= GOAL_MIN &&
      parseHHMM(goal.time) <= GOAL_MAX &&
      PACES[goal.pace] &&
      Number.isFinite(goal.startedAt) &&
      Number.isFinite(goal.fromMin) &&
      goal.fromMin >= 12 * 60 &&
      goal.fromMin <= 25 * 60,
  );
}

/**
 * Replays every night since the goal began and returns where the target stands.
 *
 *   goal:   { active, time: 'HH:MM', pace, startedAt (ms), fromMin }
 *   sleeps: the log (not modified)
 *
 * Rules, in order, for each night:
 *   - on target (within TOLERANCE, or already past the target toward the goal): count it
 *   - enough on-target nights in a row (pace.hold): move the target one step toward the goal
 *   - off target: the count starts over; after EASE_AFTER misses in a row, re-anchor to the
 *     median of her last three bedtimes, then take at most one step from there, so the target is
 *     never more than a step ahead of what she is really doing
 */
export function bedtimeGoal({ goal, sleeps, now = Date.now() }) {
  if (!goal?.active || !validGoal(goal)) return null;
  const pace = PACES[goal.pace];
  const goalMin = parseHHMM(goal.time);
  const fromMin = round5(goal.fromMin);

  const nights = buildDays(sleeps)
    .days.filter((d) => d.sane && d.bedtime >= goal.startedAt && d.bedtime <= now)
    .map((d) => ({ at: d.bedtime, min: bedtimeMinutes(d) }));

  let target = fromMin;
  let hits = 0;
  let misses = 0;
  let steps = 0;
  let eased = false;
  const history = [];

  for (let i = 0; i < nights.length; i++) {
    const b = nights[i].min;
    if (target === goalMin) {
      history.push({ ...nights[i], target, hit: Math.abs(b - target) <= TOLERANCE });
      continue;
    }
    const toward = goalMin < target ? -1 : 1;
    const hit = toward < 0 ? b <= target + TOLERANCE : b >= target - TOLERANCE;
    history.push({ ...nights[i], target, hit });
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
        const lastThree = nights.slice(Math.max(0, i - 2), i + 1).map((n) => n.min);
        const reality = round5(median(lastThree));
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
  const stepsLeft = reached ? 0 : Math.ceil(Math.abs(goalMin - target) / pace.step);
  const path = [target];
  while (path[path.length - 1] !== goalMin && path.length < 60) path.push(moveToward(path[path.length - 1], goalMin, pace.step));

  const recent = nights.slice(-3).map((n) => n.min);
  return {
    goalMin,
    fromMin,
    targetMin: target,
    direction: reached ? 'reached' : goalMin < target ? 'earlier' : 'later',
    reached,
    step: pace.step,
    hold: pace.hold,
    pace: pace.key,
    steps,
    stepsLeft,
    hits,
    misses,
    eased,
    nights: nights.length,
    recentMin: recent.length ? round5(median(recent)) : null,
    path,
    history,
  };
}
