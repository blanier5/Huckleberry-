import { MIN, HOUR, DAY, atTime, clamp, ageInMonths, fmtAge, fmtClock, fmtDuration, minutesOfDay, startOfDay } from './time.js';
import { ageNorms } from './norms.js';
import { learnRhythm, napQuality, windowPrior, napLenPrior } from './learn.js';
import { planDay, latestWake, sweetSpotHalf, PRIORITIES, DEFAULT_PRIORITY } from './planner.js';
import { bedtimeTarget, wakeTarget } from './shift.js';
import { assessDay, relaxPolicy, reasonLabels } from './recovery.js';

const hourOf = (ms) => {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
};
const pct = (x) => `${Math.round(Math.abs(x) * 100)}%`;

/** Blend what we have seen of her with what's typical for her age, trusting her more as data builds. */
function blend(est, prior, k = 4) {
  if (!est) return prior;
  const w = est.n / (est.n + k);
  return w * est.minutes + (1 - w) * prior;
}

function makeCtx(rhythm, norms) {
  const night = rhythm.night;
  // The planner asks about the same times of day again and again; answer each quarter-hour once.
  const memo = (fn) => {
    const cache = new Map();
    return (h) => {
      const key = Math.round(h * 4);
      if (!cache.has(key)) cache.set(key, fn(key / 4));
      return cache.get(key);
    };
  };
  return {
    ordinaryWindow: memo((h) => clamp(blend(rhythm.windowAt(h), windowPrior(norms, h)), 0.5 * windowPrior(norms, h), 1.8 * windowPrior(norms, h))),
    napLength: memo((h) => clamp(blend(rhythm.napLenAt(h), napLenPrior(norms, h)), 15, 120)),
    spread: memo((h) => rhythm.windowAt(h)?.spread ?? windowPrior(norms, h) * 0.25),
    cueAt: memo((h) => rhythm.cueAt(h)),
    nightFactor: night.windowFactor,
    napFlex: night.napFlex,
  };
}

/** Where bedtime should land today: the parents' choice (maybe stepping toward it), else what she's been doing. */
function resolveBedtime({ settings, rhythm, norms, sleeps, now }) {
  const chosen = bedtimeTarget({ settings, sleeps, now });
  if (chosen) {
    return {
      bedMin: chosen.targetMin,
      goalMin: chosen.goalMin,
      shift: chosen.shift,
      source: chosen.shift && !chosen.shift.reached ? 'shift' : 'chosen',
    };
  }
  if (rhythm.bedMin != null) return { bedMin: clamp(Math.round(rhythm.bedMin), 17.5 * 60, 24 * 60), source: 'learned' };
  return { bedMin: norms.bedtimeMin, source: 'age' };
}

/** Naps taken since she last woke from a night sleep. Information only: it never limits the plan. */
function napsSoFar(done, now) {
  let k = 0;
  for (let i = done.length - 1; i >= 0; i--) {
    if (done[i].kind === 'night' || now - done[i].end > 20 * HOUR) break;
    k++;
  }
  return k;
}

function decorate(items, ctx) {
  return items.map((i) => {
    const half = sweetSpotHalf(ctx, i.at);
    const w = i.kind === 'nap' ? half : clamp(half, 5, 15);
    // The sweet spot is the best guess; windows vary, so also say when to start watching for cues.
    const watch = Math.min(40, Math.max(25, 2 * half));
    return { ...i, earliest: i.at - w * MIN, latest: i.at + w * MIN, ...(i.kind === 'nap' ? { watchFrom: i.at - watch * MIN } : {}) };
  });
}

/**
 * Main entry point. A pure function of the log and settings, so it is easy to test.
 *
 *   baby:     { name, birth: epoch ms }
 *   settings: { bedtime, bedShift, wake, wakeShift, priority, recovery } (all optional)
 *
 * What it does not do: use a nap count as a limit or a goal. The next suggestion is built from
 * when she last woke, how good the last nap was, the time of day, how the night went, and where
 * bedtime should land. Naps keep being suggested until another one no longer makes sense.
 *
 * On a rough day (short or interrupted naps, trouble settling, or rough-day mode switched on) it
 * stops asking anyone to wake her to protect bedtime, and lets bedtime move instead (see recovery.js).
 */
export function predict({ sleeps, baby, settings = {}, now = Date.now() }) {
  const ageMonths = ageInMonths(baby.birth, now);
  const norms = ageNorms(ageMonths);
  const rhythm = learnRhythm(sleeps, { now, maxGapMin: Math.max(240, norms.ww * 2) });
  const ctx = makeCtx(rhythm, norms);
  const strain = assessDay({ sleeps, settings, rhythm, typicalNap: ctx.napLength, now });
  const policy = relaxPolicy(PRIORITIES[settings.priority] ?? PRIORITIES[DEFAULT_PRIORITY], strain);
  const bed = resolveBedtime({ settings, rhythm, norms, sleeps, now });
  const wake = wakeTarget({ settings, sleeps, now });

  const base = {
    ageMonths,
    priority: policy.key,
    learned: rhythm.windowCount >= 12 ? { days: Math.max(rhythm.days, Math.round(rhythm.windowCount / 6)), windows: rhythm.windowCount } : null,
    bedtimeMin: bed.bedMin,
    bedtime: bed,
    wake,
    night: rhythm.night,
    cues: rhythm.cueCount,
    strain,
  };

  const done = sleeps.filter((s) => s.end != null && s.end > s.start).sort((a, b) => a.start - b.start);
  const ongoing = sleeps.filter((s) => s.end == null).sort((a, b) => a.start - b.start)[0];
  const env = { now, norms, rhythm, policy, ctx, bed, wake, done, strain };

  if (ongoing) return { ...base, ...predictAsleep(ongoing, env) };
  if (!done.length) return { ...base, mode: 'empty', napsSoFar: 0 };

  const last = done[done.length - 1];
  if (now - last.end > 14 * HOUR) return { ...base, mode: 'stale', lastEnd: last.end, napsSoFar: 0 };
  if (last.kind === 'night' && minutesOfDay(last.end) < 4.5 * 60) {
    return { ...base, mode: 'night-awake', awakeSince: last.end, napsSoFar: 0 };
  }
  return { ...base, ...predictAwake(last, env) };
}

function predictAwake(last, { now, norms, rhythm, policy, ctx, bed, wake, done, strain }) {
  const t0 = last.end;
  const prevKind = last.kind === 'night' ? 'night' : 'nap';
  const prevLen = prevKind === 'nap' ? (last.end - last.start) / MIN : null;
  const k = napsSoFar(done, now);
  const bedMs = atTime(t0, bed.bedMin);

  const plan = planDay({ t0, bed: bedMs, prevLen, prevKind, napsDone: k, ctx, policy });
  const items = decorate(plan.items, ctx);
  const next = items[0];
  const h = hourOf(t0);
  const reasons = [];

  if (next.kind === 'nap') {
    const ordinary = ctx.ordinaryWindow(h);
    const learned = rhythm.windowAt(h);
    reasons.push(
      `Next nap about ${fmtDuration(next.window)} after waking at ${fmtClock(t0)}. Her usual window around now is ${fmtDuration(ordinary)} ` +
        (learned ? `(from ${rhythm.windowCount} recent windows).` : `(typical at ${fmtAge(norms.ageMonths)}; it adapts as you log more).`),
    );
    if (prevKind === 'nap') {
      const q = napQuality(prevLen);
      if (q < 0.95) reasons.push(`The last nap was short (${fmtDuration(prevLen)}), so the window is about ${pct(1 - q)} shorter than usual.`);
      else if (prevLen >= 75) reasons.push(`The last nap was a long one (${fmtDuration(prevLen)}), so the window isn't shortened.`);
    }
  } else {
    reasons.push(`Bedtime is next: another nap wouldn't leave a sensible stretch before ${fmtClock(next.desired)}.`);
  }

  if (rhythm.night.poor) {
    const n = rhythm.night;
    reasons.push(
      `Rough night (longest stretch ${fmtDuration(n.last.longest)}${n.usual ? `, usually ${fmtDuration(n.usual.longest)}` : ''}): windows are about ${pct(1 - n.windowFactor)} shorter today, and an extra nap is easier to add.`,
    );
  }
  if (rhythm.cueCount >= 2 && ctx.cueAt(h) < 0.97) {
    reasons.push(`She has fallen asleep early ${rhythm.cueCount} times lately, so windows around now are about ${pct(1 - ctx.cueAt(h))} shorter.`);
  }

  if (strain.relaxed) {
    const why = strain.manual
      ? `Rough-day mode is on${strain.manualReasons.length ? ` (${reasonLabels(strain.manualReasons).join(', ')})` : ''}`
      : `Today has been rough (${strain.signals.join(', ')})`;
    reasons.push(`${why}, so Napberry is being flexible: windows are a little shorter, naps can run long, an extra nap is fine, and bedtime may land later rather than cutting sleep short.`);
  } else if (strain.signals.length) {
    reasons.push(`Today has had ${strain.signals.join(' and ')}. Not enough yet to call it a rough day, but it counts toward one.`);
  }

  const bedItem = items[items.length - 1];
  reasons.push(
    bed.source === 'shift'
      ? `Bedtime target today is ${fmtClock(bedMs)}, a step on the way to ${fmtClock(atTime(t0, bed.goalMin))} (${bed.shift.step} min every ${bed.shift.hold} days, once she's settling near each target).`
      : bed.source === 'chosen'
        ? `Bedtime target is ${fmtClock(bedMs)}.`
        : bed.source === 'learned'
          ? `Bedtime is about ${fmtClock(bedMs)}, where it has been lately. Choose a bedtime in Settings to steer it.`
          : `Bedtime is about ${fmtClock(bedMs)}, typical for her age. Choose a bedtime in Settings to steer it.`,
  );
  if (Math.abs(plan.windowPct) >= 0.04) {
    reasons.push(`The rest of the day is ${plan.windowPct > 0 ? 'stretched' : 'trimmed'} about ${pct(plan.windowPct)}, mostly in the late afternoon, to land on bedtime.`);
  }
  const bridge = items.find((i) => i.bridge);
  if (bridge) reasons.push(`A short bridge nap (about ${fmtDuration(bridge.len)}) keeps the last stretch awake before bed from running too long.`);
  if (Math.abs(bedItem.offset) >= 15) {
    reasons.push(`With ${policy.label.toLowerCase()} as the priority, bedtime is expected to land about ${fmtDuration(Math.abs(bedItem.offset))} ${bedItem.offset > 0 ? 'after' : 'before'} the target.`);
  }
  if (wake && prevKind === 'night') {
    const morning = startOfDay(t0);
    const high = morning + wake.highMin * MIN;
    if (t0 > high) {
      reasons.push(`She woke ${fmtDuration((t0 - high) / MIN)} after the end of the ${fmtClock(morning + wake.lowMin * MIN)}–${fmtClock(high)} wake range. The day is compressed rather than moved later, so bedtime stays put.`);
    }
  }

  return {
    mode: 'awake',
    awakeSince: t0,
    prevLen,
    prevKind,
    napsSoFar: k,
    next,
    later: items.slice(1),
    reasons,
    plan: { ok: plan.ok, windowPct: plan.windowPct, landing: plan.landing },
  };
}

const LATE_BEDTIME = 20; // minutes past the target before waking her is even mentioned
const HOLDS = 15; // "holds bedtime" means landing within this many minutes of the target
const napCount = (items) => items.filter((i) => i.kind === 'nap').length;

function predictAsleep(ongoing, { now, norms, rhythm, policy, ctx, bed, wake, done, strain }) {
  const elapsed = (now - ongoing.start) / MIN;
  const out = { mode: 'asleep', kind: ongoing.kind, since: ongoing.start, elapsed };
  const before = done.filter((s) => s.end <= ongoing.start);

  if (ongoing.kind === 'night') {
    const wakeMin = wake?.targetMin ?? rhythm.wakeMin ?? 7 * 60;
    let expectedWake = atTime(ongoing.start, wakeMin);
    while (expectedWake < ongoing.start + 3 * HOUR) expectedWake += DAY;
    const bedMs = atTime(expectedWake, bed.bedMin);

    let range = null;
    let wakeBy = null;
    if (wake) {
      const day = startOfDay(expectedWake);
      range = { targetMs: day + wake.targetMin * MIN, lowMs: day + wake.lowMin * MIN, highMs: day + wake.highMin * MIN };
      // After a rough day she can sleep on; nobody is asked to wake her to protect bedtime.
      wakeBy = strain.relaxed ? null : range.highMs;
    } else if (policy.wakeBy) {
      wakeBy = latestWake({ kind: 'night', from: Math.max(now, expectedWake - 90 * MIN), around: expectedWake, bed: bedMs, ctx, policy });
    }
    const resume = Math.max(expectedWake, now);
    const after = decorate(planDay({ t0: resume, bed: bedMs, prevKind: 'night', napsDone: 0, ctx, policy }).items, ctx);
    const notes = [];
    if (strain.relaxed && now >= (range ? range.lowMs : expectedWake) - 30 * MIN) {
      notes.push("Let her sleep in if she needs it. After a rough day Napberry won't ask you to wake her; it plans the day from whenever she wakes.");
    } else if (range) {
      if (now > range.highMs) notes.push(`Past the ${fmtClock(range.lowMs)}–${fmtClock(range.highMs)} target. Waking her now protects tonight's ${fmtClock(bedMs)} bedtime.`);
      else if (now >= range.lowMs) notes.push(`In the target wake range. Wake by ${fmtClock(range.highMs)} to protect tonight's bedtime.`);
      else notes.push(`Target wake ${fmtClock(range.targetMs)} (${fmtClock(range.lowMs)}–${fmtClock(range.highMs)}). Let her sleep until then.`);
    } else if (wakeBy) {
      notes.push(`Wake by ${fmtClock(wakeBy)} to keep tonight's bedtime near ${fmtClock(bedMs)}.`);
    }
    return {
      ...out,
      napsSoFar: 0,
      expectedWake,
      wakeBy,
      wakeRange: range,
      pastTarget: Boolean(range && now > range.highMs && !strain.relaxed),
      after,
      notes,
    };
  }

  const k = napsSoFar(before, ongoing.start);
  const typicalLen = ctx.napLength(hourOf(ongoing.start)) * policy.napBias;
  const typicalEnd = ongoing.start + typicalLen * MIN;
  // The nap is never cut short in the plan. If she sleeps past the usual length, the rest of the day
  // is recalculated from when she wakes: fewer naps, shorter ones, or a later bedtime.
  const naturalWake = Math.max(typicalEnd, now);
  const bedMs = atTime(ongoing.start, bed.bedMin);
  const planFrom = (t0) =>
    planDay({ t0, bed: bedMs, prevLen: (t0 - ongoing.start) / MIN, prevKind: 'nap', napsDone: k + 1, ctx, policy });
  const natural = planFrom(naturalWake);
  const after = decorate(natural.items, ctx);
  const bedItem = after[after.length - 1];

  // Waking her is only ever a suggestion, and the last resort: it is offered only when letting her sleep
  // on would push bedtime well past the target even after dropping naps and shortening the evening,
  // she isn't having a rough day, and the family asked to protect bedtime. It says what sleeping on costs.
  const late = bedItem.offset;
  let wakeBy = null;
  if (policy.wakeBy && late >= LATE_BEDTIME) {
    const lo = Math.max(now, ongoing.start + 10 * MIN);
    wakeBy = lo;
    for (let e = Math.floor(naturalWake / (5 * MIN)) * 5 * MIN; e >= lo; e -= 5 * MIN) {
      if (planFrom(e).landing - bedMs <= HOLDS * MIN) {
        wakeBy = e;
        break;
      }
    }
  }

  const notes = [];
  if (wakeBy != null) {
    notes.push(
      `If she sleeps on, bedtime lands about ${fmtClock(bedItem.at)}, ${fmtDuration(late)} after your ${fmtClock(bedMs)} target. To hold ${fmtClock(bedMs)}, wake her by ${fmtClock(wakeBy)}.`,
    );
  } else if (strain.relaxed) {
    notes.push(`Let her sleep. Rough day, so Napberry won't ask you to wake her to hold bedtime${late >= 15 ? `; it may land around ${fmtClock(bedItem.at)}` : ''}.`);
  }
  if (now > typicalEnd + 10 * MIN) {
    const usual = planFrom(typicalEnd);
    const fewer = napCount(usual.items) - napCount(after);
    const later = (natural.landing - usual.landing) / MIN;
    const changes = [];
    if (fewer > 0) changes.push(fewer === 1 ? 'one fewer nap' : `${fewer} fewer naps`);
    if (later >= 15) {
      if (wakeBy == null) changes.push(`bedtime about ${fmtDuration(later)} later`); // the wake-by note above already says so
    } else if (fewer <= 0) {
      const usualNaps = usual.items.filter((i) => i.kind === 'nap').reduce((sum, i) => sum + i.len, 0);
      const nowNaps = after.filter((i) => i.kind === 'nap').reduce((sum, i) => sum + i.len, 0);
      if (usualNaps - nowNaps >= 10) changes.push('later naps a bit shorter');
    }
    if (changes.length) notes.push(`She's sleeping past the usual ${fmtDuration(typicalLen)}, so the rest of the day adjusts: ${changes.join(' and ')}.`);
  }
  return { ...out, napsSoFar: k, napNumber: k + 1, typicalLen, expectedWake: naturalWake, wakeBy, after, notes };
}
