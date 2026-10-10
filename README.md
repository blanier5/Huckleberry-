# Napberry

A small, offline-capable nap tracker with Huckleberry-style **nap and bedtime recommendations**, and an importer for your **Huckleberry history**.

- **One-tap recording.** Start nap / Wake up. Forgot to tap? "Started earlier…" and "Woke up earlier…" take a time. Past sleeps can be added, edited and deleted.
- **Recommendations that learn.** The next nap or bedtime comes with a *sweet spot* window, a countdown, a plan for the rest of the day, and a "Why this time?" explanation.
- **Huckleberry import.** Load a Huckleberry CSV export, see a summary first, and re-importing never creates duplicates.
- **Private and installable.** Plain HTML/JS, no accounts, no server. Data stays in the browser on your device. Add it to your home screen and it works offline.

> General guidance only, not medical advice. Follow your baby's cues and your pediatrician.

## Run it

```sh
npm start        # serves on http://localhost:8080 (any static file server works)
npm test         # unit tests, Node 20+, no dependencies
```

### Put it on your phone (GitHub Pages)

The app is static files at the repo root, so: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)`**. Open the URL on your phone, then *Share → Add to Home Screen* (iOS) or *Install app* (Android/Chrome).

## Importing from Huckleberry

Export your data from Huckleberry as a CSV, then **Settings → Import from Huckleberry → Choose CSV file**. (`samples/huckleberry-sample.csv` is made-up data to try it with.)

The importer expects the usual export columns, `Start, End, Duration, Type, …, Notes`, and is forgiving about the details:

- Only `Sleep` rows are used. Feeds, diapers and the rest are ignored (and counted in the summary).
- If `End` is blank it uses `Start + Duration`. Durations like `01:23`, `1h 23m` and `83` all work.
- Dates may be ISO (`2026-10-10 14:05`), US (`10/10/2026 2:05 PM`) or day-first (detected from the data). Times are read in your device's time zone.
- Huckleberry has one "sleep" type, so naps vs. night sleep are told apart by start time (6pm–5:30am) and length (5h+). You can flip any entry in History.
- If your file uses different column names, the error lists the columns it found; the header aliases at the top of `src/huckleberry.js` are easy to extend.

## How the recommendations work

1. **Start from age.** Typical wake windows, nap counts and nap lengths are interpolated by age in months (`src/norms.js`). Windows grow through the day: shortest after the morning wake-up, longest before bed.
2. **Learn the baby.** From the last ~14 complete days it takes the median wake window for each slot of the day (first nap, second nap, … bedtime), nap lengths, nap count and bedtime. Night wakings are folded into the night so they never look like wake windows, and days with logging gaps are ignored. The more matching days, the more it trusts the baby's own numbers over the age norm.
3. **Adjust for today.** A short last nap pulls the next window in about 15%. The remaining windows are stretched or trimmed a little so the day lands on bedtime (more freely if you set a bedtime yourself). If another nap would run into bedtime it is capped, or skipped so bedtime comes next.
4. **Say why.** Each suggestion lists the numbers it used.

Predictions are most meaningful from about 2 months. History older than 30 days is not used to learn, so a baby who has grown out of an old pattern isn't held to it.

## Your data

Everything is stored in the browser's local storage on **this device**. **Settings → Backup & sharing** exports a JSON file; importing one on another phone *merges* it (it never overwrites). Real-time sync between two parents' phones would need a small backend, which this app deliberately doesn't have.

## Code map

```
index.html, manifest.webmanifest, sw.js   app shell, PWA manifest, offline cache
src/app.js         UI: views, dialogs, events
src/predict.js     recommendation engine (pure function of the log)
src/analysis.js    nap/night classification, day building, learned profile
src/norms.js       age-based wake windows
src/huckleberry.js, src/csv.js   CSV import
src/store.js       local-first storage, merge/dedupe, backup
tests/             node:test suites + a synthetic-history generator
```
