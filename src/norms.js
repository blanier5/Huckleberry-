// Age-based starting points, used until there is enough history to learn from.
// These are general pediatric-sleep-guide conventions (the same ballpark most
// trackers use), not medical advice. Every baby differs, and the recommender
// shifts toward the child's own logged pattern as data accumulates.
//
// The numbers are chosen so that (naps + wake windows) add up to a ~12h waking
// day, e.g. 7 mo: 4 windows x 140 min + 3 naps x 60 min = 12.3h.

// [ageMonths, typical wake window (min), naps per day, typical nap length (min)]
const ANCHORS = [
  [0, 45, 5, 60],
  [1, 60, 5, 60],
  [2, 80, 4, 60],
  [3, 90, 4, 60],
  [4, 95, 4, 65],
  [5, 130, 3, 65],
  [6, 135, 3, 70],
  [7, 140, 3, 60],
  [8, 170, 2, 75],
  [10, 185, 2, 85],
  [12, 190, 2, 90],
  [15, 190, 2, 90],
  [18, 300, 1, 120],
  [24, 310, 1, 110],
  [36, 330, 1, 90],
  [60, 400, 0, 0],
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function ageNorms(ageMonths) {
  const age = Math.min(Math.max(ageMonths, 0), ANCHORS[ANCHORS.length - 1][0]);
  let i = 0;
  while (i < ANCHORS.length - 2 && age >= ANCHORS[i + 1][0]) i++;
  const [a0, ww0, n0, l0] = ANCHORS[i];
  const [a1, ww1, n1, l1] = ANCHORS[i + 1];
  const t = (age - a0) / (a1 - a0);
  const ww = lerp(ww0, ww1, t);
  return {
    ageMonths,
    ww,
    wwMin: ww * 0.75,
    wwMax: ww * 1.25,
    naps: Math.round(lerp(n0, n1, t)),
    napLen: lerp(l0, l1, t),
    bedtimeMin: defaultBedtime(ageMonths),
  };
}

/** Younger babies go down later; by ~6 months it settles around 7pm. */
export function defaultBedtime(ageMonths) {
  if (ageMonths < 2) return 21 * 60;
  if (ageMonths < 4) return 20 * 60;
  if (ageMonths < 6) return 19 * 60 + 30;
  return 19 * 60;
}

/**
 * Wake windows grow through the day: shortest after the morning wake-up,
 * longest before bedtime. `i` is the window index (0 = wake -> first nap,
 * n = last nap -> bedtime) for a day with `n` naps.
 */
export function slotFactor(i, n) {
  if (n <= 0) return 1;
  if (n === 1) return i === 0 ? 1.05 : 0.95;
  return 0.88 + 0.24 * (i / n);
}
