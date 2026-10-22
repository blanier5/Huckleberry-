// Plans the rest of the day: given when she last woke up and when bedtime should be, which naps
// (as many or as few as it takes), and when.
//
// There is no "number of naps" anywhere in here. For every possible count of naps we ask: if we put
// exactly that many in the gap, how far would we have to stretch or squeeze her usual wake windows
// and nap lengths to land on bedtime? Then we take the count that needs the least bending. A day
// that needs six or seven naps gets six or seven; the last one becomes a short "bridge" nap when
// the alternative is a very long stretch awake before bed.

import { MIN, clamp } from './time.js';
import { napQuality } from './learn.js';

/**
 * What a parent can say matters most. Each one changes how the plan trades things off:
 *   slack     minutes bedtime may land either side of the target
 *   flexW     how freely wake windows bend to hit bedtime
 *   flexL     how freely nap lengths bend (below 1 = naps resist being cut short)
 *   lastHi    longest acceptable final stretch awake, as a multiple of her usual window
 *   windowBias / napBias   offer a bit more or less sleep opportunity than usual
 */
export const PRIORITIES = {
  protect: {
    key: 'protect',
    label: 'Protect bedtime',
    blurb: 'Hold bedtime where you want it. Windows and the late afternoon bend to land on it.',
    slack: 10,
    flexW: 1.25,
    flexL: 1.2,
    lastHi: 1.25,
    windowBias: 1,
    napBias: 1,
    wakeBy: true,
  },
  sleep: {
    key: 'sleep',
    label: 'Maximize total sleep',
    blurb: 'Let naps run their course and offer extra naps early. Bedtime can drift an hour.',
    slack: 60,
    flexW: 0.9,
    flexL: 0.6,
    lastHi: 1.1,
    windowBias: 0.95,
    napBias: 1.1,
    wakeBy: false,
  },
  wake: {
    key: 'wake',
    label: 'Build a consistent morning wake time',
    blurb: 'Anchor the day to your target wake time and nudge her toward it.',
    slack: 25,
    flexW: 1,
    flexL: 1,
    lastHi: 1.25,
    windowBias: 1,
    napBias: 1,
    wakeBy: true,
  },
  cues: {
    key: 'cues',
    label: 'Follow baby cues',
    blurb: 'Stay close to her natural windows. Bedtime lands wherever her day leads, within about an hour of your target.',
    slack: 75,
    flexW: 0.7,
    flexL: 0.7,
    lastHi: 1.35,
    windowBias: 1,
    napBias: 1,
    wakeBy: false,
  },
};

export const DEFAULT_PRIORITY = 'protect';
const MAX_NAPS = 10;
const MIN_NAP = 15;
const BRIDGE_MAX = 40; // a final nap this short or shorter is described as a bridge nap

const lerp = (a, b, t) => a + (b - a) * t;
const hourOf = (ms) => {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
};

/**
 * Minimise sum((x/sigma)^2) subject to sum(a*x) = delta and lo <= x <= hi (a is +1 or -1).
 * Solved by bisection on the Lagrange multiplier; the clamped sum is monotone in it.
 */
function solve(elems, delta) {
  const n = elems.length;
  const a = new Float64Array(n);
  const s2 = new Float64Array(n);
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  elems.forEach((e, i) => {
    a[i] = e.a;
    s2[i] = e.sigma * e.sigma;
    lo[i] = e.lo;
    hi[i] = e.hi;
  });
  const at = (i, lam) => {
    const x = lam * a[i] * s2[i];
    return x < lo[i] ? lo[i] : x > hi[i] ? hi[i] : x;
  };
  const total = (lam) => {
    let t = 0;
    for (let i = 0; i < n; i++) t += a[i] * at(i, lam);
    return t;
  };
  let l = -1e4;
  let h = 1e4;
  for (let i = 0; i < 50; i++) {
    const mid = (l + h) / 2;
    if (total(mid) < delta) l = mid;
    else h = mid;
  }
  const lam = (l + h) / 2;
  return Array.from({ length: n }, (_, i) => at(i, lam));
}

/**
 * ctx (what we know about her):
 *   ordinaryWindow(hour) -> minutes awake before a nap, after an ordinary-length nap
 *   napLength(hour)      -> minutes a nap starting at `hour` usually lasts
 *   spread(hour)         -> how much those windows vary (minutes), for the sweet-spot range
 *   cueAt(hour)          -> multiplier from "fell asleep early" notes (1 = none)
 *   nightFactor          -> multiplier on windows after a rough night (1 = normal night)
 *   napFlex              -> >1 after a rough night: more willing to add naps
 */
function naturalWindow(ctx, policy, t, prevLen, prevKind) {
  const h = hourOf(t);
  const quality = prevKind === 'nap' && prevLen != null ? napQuality(prevLen) : 1;
  return ctx.ordinaryWindow(h) * quality * ctx.cueAt(h) * ctx.nightFactor * policy.windowBias;
}

/** Length of the day if she followed her usual windows and naps exactly, with n naps. */
function naturalTotal({ t0, prevLen, prevKind, ctx, policy }, n) {
  let t = t0;
  let prev = prevLen;
  let kind = prevKind;
  for (let i = 0; i <= n; i++) {
    t += naturalWindow(ctx, policy, t, prev, kind) * MIN;
    if (i < n) {
      const l = ctx.napLength(hourOf(t)) * policy.napBias;
      t += l * MIN;
      prev = l;
      kind = 'nap';
    }
  }
  return (t - t0) / MIN;
}

function candidate({ t0, bed, prevLen, prevKind, ctx, policy }, n) {
  const R = (bed - t0) / MIN;
  const slack = policy.slack;
  let timeline = null; // solved start times from the previous pass
  let sol = null;

  for (let pass = 0; pass < 3; pass++) {
    // Natural (un-bent) windows and lengths, evaluated along the best timeline found so far.
    const nat = { w: [], l: [] };
    let t = t0;
    let prev = prevLen;
    let kind = prevKind;
    for (let i = 0; i <= n; i++) {
      const w = naturalWindow(ctx, policy, timeline ? timeline.w[i] : t, prev, kind);
      nat.w.push(w);
      t += w * MIN;
      if (i < n) {
        const at = timeline ? timeline.n[i] : t;
        const l = ctx.napLength(hourOf(at)) * policy.napBias;
        nat.l.push(l);
        t += l * MIN;
        prev = sol ? sol.l[i] : l;
        kind = 'nap';
      }
    }

    const elems = [];
    nat.w.forEach((w, i) => {
      const p = n === 0 ? 1 : i / n;
      const flex = lerp(0.1, 0.4, p) * policy.flexW;
      const first = i === 0 && n > 0;
      elems.push({ a: 1, sigma: Math.max(4, flex * w), lo: first ? -0.2 * w : -0.45 * w, hi: first ? 0.3 * w : 0.6 * w });
    });
    nat.l.forEach((l, j) => {
      const p = (j + 1) / n;
      const flex = lerp(0.15, 0.5, p) * policy.flexL;
      elems.push({ a: 1, sigma: Math.max(4, flex * l), lo: Math.max(MIN_NAP, 0.3 * l) - l, hi: 0.6 * l });
    });
    elems.push({ a: -1, sigma: Math.max(2, slack / 2), lo: -slack, hi: slack }); // landing within slack of target
    elems.push({ a: -1, sigma: 3, lo: -Infinity, hi: Infinity }); // landing beyond slack: very expensive

    const delta = R - nat.w.reduce((s, v) => s + v, 0) - nat.l.reduce((s, v) => s + v, 0);
    const x = solve(elems, delta);
    const nW = nat.w.length;
    const w = nat.w.map((v, i) => v + x[i]);
    const l = nat.l.map((v, j) => v + x[nW + j]);
    const miss = x[nW + nat.l.length] + x[nW + nat.l.length + 1]; // minutes past the target bedtime
    sol = { w, l, x, nat, elems, miss };

    // Where each nap starts, for the next pass's time-of-day lookups.
    timeline = { w: [], n: [] };
    let at = t0;
    for (let i = 0; i <= n; i++) {
      timeline.w.push(at);
      at += w[i] * MIN;
      if (i < n) {
        timeline.n.push(at);
        at += l[i] * MIN;
      }
    }
  }

  const { w, l, nat, elems, x, miss } = sol;
  let cost = elems.reduce((s, e, i) => s + (x[i] / e.sigma) ** 2, 0);

  // The final stretch awake should be a normal one, not far too long or too short.
  const lastNat = nat.w[n];
  const lastLo = 0.55 * lastNat;
  const lastHi = (policy.lastHi * lastNat) / ctx.napFlex;
  const last = w[n];
  const lastViolation = last < lastLo ? lastLo - last : last > lastHi ? last - lastHi : 0;
  cost += (lastViolation / 6) ** 2;
  for (const len of l) if (len < 20) cost += ((20 - len) / 5) ** 2;
  cost += 1e-3 * n; // a tie goes to fewer naps; there is no preference otherwise

  return { n, cost, w, l, nat, miss, lastViolation, R };
}

function build(c, { t0, bed, napsDone = 0 }) {
  const items = [];
  let t = t0;
  for (let i = 0; i < c.n; i++) {
    const start = t + c.w[i] * MIN;
    const end = start + c.l[i] * MIN;
    items.push({
      kind: 'nap',
      number: napsDone + i + 1,
      at: start,
      end,
      len: c.l[i],
      window: c.w[i],
      natural: c.nat.w[i],
      bridge: i === c.n - 1 && c.l[i] <= BRIDGE_MAX && c.n > 0,
    });
    t = end;
  }
  const landing = t + c.w[c.n] * MIN;
  items.push({ kind: 'bedtime', at: landing, desired: bed, offset: (landing - bed) / MIN, window: c.w[c.n], natural: c.nat.w[c.n] });
  return items;
}

/**
 * Plan from `t0` (when she woke) to bedtime.
 *
 *   bed       target bedtime (ms)
 *   prevLen   minutes of the nap that just ended (null if she woke from the night)
 *   prevKind  'nap' | 'night'
 *   napsDone  naps already taken today (only used to number the new ones)
 */
export function planDay({ t0, bed, prevLen = null, prevKind = 'night', napsDone = 0, ctx, policy = PRIORITIES.protect }) {
  const args = { t0, bed, prevLen, prevKind, ctx, policy };
  const R = (bed - t0) / MIN;

  // Cheap first pass: with n naps and no bending at all, how long is the day? A count that would need
  // far more stretching or squeezing than is allowed can't win, so don't spend time solving it.
  let counts = [];
  for (let n = 0; n <= MAX_NAPS; n++) {
    const total = naturalTotal(args, n);
    if (total * 1.55 + policy.slack >= R - 20 && total * 0.62 <= R + policy.slack + 20) counts.push(n);
  }
  if (!counts.length) counts = Array.from({ length: MAX_NAPS + 1 }, (_, n) => n); // nothing fits well: look at them all

  let best = null;
  for (const n of counts) {
    const c = candidate(args, n);
    if (!best || c.cost < best.cost - 1e-9) best = c;
  }
  const items = build(best, { ...args, napsDone });
  const windowPct = (() => {
    const nat = best.nat.w.reduce((s, v) => s + v, 0);
    const act = best.w.reduce((s, v) => s + v, 0);
    return nat ? (act - nat) / nat : 0;
  })();
  const factors = best.w.map((v, i) => v / best.nat.w[i]);
  const ok =
    Math.abs(best.miss) <= policy.slack + 5 &&
    best.lastViolation < 1 &&
    factors.every((f) => f > 0.7 && f < 1.4);
  // One-sided: not enough time left, so bedtime would land late or windows would have to be squeezed.
  // (Unlike `ok`, this only gets worse as the start time moves later, which is what wake-by needs.)
  const tooLate = best.miss > policy.slack + 5 || factors.some((f) => f < 0.6) || best.w[best.n] < 0.4 * best.nat.w[best.n];
  return {
    items,
    n: best.n,
    cost: best.cost,
    ok,
    tooLate,
    windowPct,
    landing: items[items.length - 1].at,
    overshoot: best.miss,
    spread: (ms) => ctx.spread(hourOf(ms)),
  };
}

/**
 * The latest she can wake from the sleep she's in and still be able to land on bedtime without
 * the evening being squeezed. Starts from when she would naturally wake (`around`) and walks outward:
 * later while that still works, or earlier until it does. If even waking right now is too late, that
 * is the answer: as soon as she can.
 *
 *   kind 'nap'   she's in a nap that began at `start`
 *   kind 'night' she's asleep overnight; `start` is ignored
 */
export function latestWake({ start, from, bed, ctx, policy, napsDone = 0, kind = 'nap', around }) {
  const step = 10 * MIN;
  const lo = kind === 'nap' ? Math.max(from, start + 10 * MIN) : from;
  const hi = kind === 'nap' ? start + 5 * 60 * MIN : from + 5 * 60 * MIN;
  const ok = (e) =>
    !planDay({ t0: e, bed, prevLen: kind === 'nap' ? (e - start) / MIN : null, prevKind: kind, napsDone, ctx, policy }).tooLate;

  let e = clamp(Math.round((around ?? lo) / step) * step, lo, hi);
  if (ok(e)) {
    let best = e;
    for (let i = 0; i < 5 && best + step <= hi && ok(best + step); i++) best += step;
    return best;
  }
  for (let i = 0; i < 14; i++) {
    e -= step;
    if (e < lo) break;
    if (ok(e)) return e;
  }
  // Nothing earlier works either: the evening is already tight, so the answer is "as soon as she can".
  return lo;
}

/** Half-width of the sweet-spot range around a suggested time. */
export function sweetSpotHalf(ctx, ms) {
  return clamp(0.6 * ctx.spread(hourOf(ms)), 8, 20);
}
