import { MIN, HOUR, atTime, clamp, ageInMonths, fmtAge, fmtDuration, fmtMinutesAsClock, startOfDay, minutesOfDay } from './time.js';
import { ageNorms, slotFactor } from './norms.js';
import { buildProfile } from './analysis.js';

/**
 * Blend age-based norms with what we've learned about this baby into a concrete
 * plan: how many naps, how long each wake window / nap usually is, and bedtime.
 */
function buildPlan(norms, profile, settings) {
  const N = profile ? profile.napCount : norms.naps;
  const w = profile ? profile.weight : 0;
  const blend = (personal, base) => (personal == null ? base : w * personal + (1 - w) * base);

  const windows = [];
  const baseWindows = [];
  for (let i = 0; i <= N; i++) {
    const base = norms.ww * slotFactor(i, N);
    baseWindows.push(base);
    windows.push(clamp(blend(profile?.windows[i], base), norms.wwMin * 0.8, norms.wwMax * 1.25));
  }
  const napLens = [];
  for (let i = 0; i < N; i++) napLens.push(blend(profile?.napLens[i], norms.napLen));

  const bedtimeMin = clamp(settings.bedtimeMin ?? profile?.bedtimeMin ?? norms.bedtimeMin, 17.5 * 60, 22 * 60);
  // A bedtime the parents chose is a target to build the day around, so let the windows flex more.
  const fixedBedtime = settings.bedtimeMin != null;
  return { N, windows, baseWindows, napLens, bedtimeMin, fixedBedtime, profile, norms };
}

function napItem(number, start, end, window, extra = {}) {
  const half = clamp(window * 0.08, 5, 15) * MIN;
  return { kind: 'nap', number, at: start, end, len: (end - start) / MIN, window, earliest: start - half, latest: start + half, ...extra };
}

function bedtimeItem(at, window, extra = {}) {
  const half = clamp(window * 0.08, 5, 15) * MIN;
  return { kind: 'bedtime', at, window, earliest: at - half, latest: at + half, ...extra };
}

/**
 * Walk forward from `t0` (a wake-up) having already taken `k0` naps today,
 * producing the remaining naps and bedtime.
 *
 * The typical windows are first stretched or trimmed (a little) so that the rest
 * of the day's naps and windows land on bedtime. A nap that still would crowd
 * out bedtime is shortened, or skipped so that bedtime comes next.
 */
function planRest(t0, k0, plan, shortNapFactor = 1) {
  const { N, windows, napLens } = plan;
  const items = [];
  const bed = atTime(t0, plan.bedtimeMin);

  const rawSum = windows.slice(k0).reduce((a, b) => a + b, 0);
  const napSum = napLens.slice(k0).reduce((a, b) => a + b, 0);
  const budget = (bed - t0) / MIN - napSum;
  const [lo, hi] = plan.fixedBedtime ? [0.8, 1.15] : plan.profile ? [0.9, 1.05] : [0.8, 1.1];
  const fit = rawSum > 0 && budget > 0 ? clamp(budget / rawSum, lo, hi) : 1;
  const fitted = windows.map((w) => w * fit);

  const lastWindow = fitted[N];
  const minLast = 0.85 * lastWindow * MIN;
  const bedAt = (t) => Math.max(t, clamp(t + lastWindow * MIN, bed - 60 * MIN, bed + 45 * MIN));

  let t = t0;
  let k = k0;
  for (let guard = 0; guard < 8; guard++) {
    if (k >= N) {
      items.push(bedtimeItem(bedAt(t), lastWindow));
      break;
    }
    const window = fitted[k] * (guard === 0 ? shortNapFactor : 1);
    const start = t + window * MIN;
    const len = napLens[Math.min(k, napLens.length - 1)] ?? 60;
    const end = start + len * MIN;

    if (bed - end < minLast) {
      const capEnd = bed - minLast;
      if (capEnd - start >= 25 * MIN) {
        items.push(napItem(k + 1, start, capEnd, window, { capped: true }));
        items.push(bedtimeItem(bed, lastWindow));
      } else {
        items.push(bedtimeItem(bedAt(t), lastWindow, { skippedNap: k + 1 }));
      }
      break;
    }
    items.push(napItem(k + 1, start, end, window));
    t = end;
    k++;
  }
  return { items, fit };
}

/** Number of naps already taken on the calendar day containing `ref`, walking back from index `from`. */
function napsBefore(done, from, ref) {
  let k = 0;
  for (let i = from; i >= 0; i--) {
    const s = done[i];
    if (s.kind === 'night' || startOfDay(s.start) !== startOfDay(ref)) break;
    k++;
  }
  return k;
}

function explainWindow(plan, k, used, fit, shortNap) {
  const { profile, norms } = plan;
  const lines = [];
  const age = fmtAge(norms.ageMonths);
  if (profile?.windows[k] != null) {
    lines.push(
      `Wake window of ${fmtDuration(used)}. Your last ${profile.matching} similar days average ${fmtDuration(profile.windows[k])} here; ` +
        `typical at ${age} is ${fmtDuration(plan.baseWindows[k])}. The more days you log, the more it leans on your baby's own pattern.`,
    );
  } else {
    lines.push(`Wake window of ${fmtDuration(used)}, typical at ${age}. It adapts as you log more days or import history.`);
  }
  if (Math.abs(fit - 1) > 0.03) {
    const pct = Math.round(Math.abs(fit - 1) * 100);
    lines.push(`${fit < 1 ? 'Trimmed' : 'Stretched'} about ${pct}% to fit the rest of today around a ${fmtMinutesAsClock(plan.bedtimeMin)} bedtime.`);
  }
  if (shortNap) {
    lines.push(`The last nap was short (${fmtDuration(shortNap)}), so the window is shortened by about 15%.`);
  }
  return lines;
}

/**
 * Main entry point. Pure function of the log, so it is easy to test.
 *
 *   baby:     { name, birth: epoch ms }
 *   settings: { bedtimeMin?: minutes after midnight } (omit to learn it)
 */
export function predict({ sleeps, baby, settings = {}, now = Date.now() }) {
  const done = sleeps.filter((s) => s.end != null).sort((a, b) => a.start - b.start);
  const ongoing = sleeps.find((s) => s.end == null);
  const ageMonths = ageInMonths(baby.birth, now);
  const norms = ageNorms(ageMonths);
  const profile = buildProfile(sleeps, { now });
  const plan = buildPlan(norms, profile, settings);
  const base = {
    ageMonths,
    plan,
    learned: profile ? { days: profile.days, matching: profile.matching } : null,
    napsExpected: plan.N,
    bedtimeMin: plan.bedtimeMin,
  };

  if (ongoing) return { ...base, ...predictAsleep(ongoing, done, plan, now) };
  if (!done.length) return { ...base, mode: 'empty' };

  const last = done[done.length - 1];
  if (now - last.end > 14 * HOUR) return { ...base, mode: 'stale', lastEnd: last.end };
  if (last.kind === 'night' && minutesOfDay(last.end) < 4.5 * 60) {
    return { ...base, mode: 'night-awake', awakeSince: last.end };
  }

  const napsToday = last.kind === 'nap' ? napsBefore(done, done.length - 1, last.start) : 0;

  // A short nap means baby is tired sooner.
  let factor = 1;
  let shortNap = 0;
  if (last.kind === 'nap') {
    const len = (last.end - last.start) / MIN;
    const expected = plan.napLens[Math.min(napsToday - 1, plan.napLens.length - 1)] ?? 60;
    if (len < Math.min(45, 0.7 * expected)) {
      factor = 0.85;
      shortNap = len;
    }
  }

  const { items, fit } = planRest(last.end, napsToday, plan, factor);
  const next = items[0];
  const reasons = [];
  if (next.kind === 'nap') {
    reasons.push(...explainWindow(plan, napsToday, next.window, fit, shortNap));
    if (next.capped) {
      reasons.push(`This nap is capped at ${fmtDuration(next.len)} so the last stretch before bedtime isn't squeezed.`);
    }
  } else {
    if (next.skippedNap) {
      reasons.push(`There isn't room for another nap before bedtime without pushing it too late, so bedtime is next.`);
    } else if (napsToday >= plan.N) {
      reasons.push(`That's ${napsToday} ${napsToday === 1 ? 'nap' : 'naps'} today, which is what's typical, so bedtime is next.`);
    }
    reasons.push(...explainWindow(plan, plan.N, next.window, fit, 0));
  }

  return {
    ...base,
    mode: 'awake',
    awakeSince: last.end,
    napsToday,
    next,
    later: items.slice(1),
    reasons,
  };
}

function predictAsleep(ongoing, done, plan, now) {
  const elapsed = (now - ongoing.start) / MIN;
  const out = { mode: 'asleep', kind: ongoing.kind, since: ongoing.start, elapsed };

  if (ongoing.kind === 'night') {
    const wakeMin = plan.profile?.wakeMin ?? 7 * 60;
    let wake = atTime(ongoing.start, wakeMin);
    while (wake < ongoing.start + 4 * HOUR) wake += 24 * HOUR;
    return { ...out, expectedWake: wake, after: planRest(wake, 0, plan).items };
  }

  const before = done.filter((s) => s.end <= ongoing.start);
  const k = napsBefore(before, before.length - 1, ongoing.start);
  const len = plan.napLens[Math.min(k, plan.napLens.length - 1)] ?? 60;
  let expectedWake = ongoing.start + len * MIN;

  // Protect bedtime: suggest waking by a cap if the nap would otherwise crowd it out.
  const bed = atTime(ongoing.start, plan.bedtimeMin);
  const cap = bed - 0.85 * plan.windows[plan.N] * MIN;
  let wakeBy = null;
  if (cap < expectedWake && cap > ongoing.start + 25 * MIN) {
    wakeBy = cap;
    expectedWake = cap;
  }

  const resume = Math.max(expectedWake, now);
  return {
    ...out,
    napNumber: k + 1,
    typicalLen: len,
    expectedWake,
    wakeBy,
    after: planRest(resume, k + 1, plan).items,
  };
}
