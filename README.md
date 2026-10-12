# Napberry

A small, offline-capable nap tracker with Huckleberry-style **nap and bedtime recommendations**, and an importer for your **Huckleberry history**.

- **One-tap recording.** Start nap / Wake up. Forgot to tap? "Started earlier…" and "Woke up earlier…" take a time. Past sleeps can be added, edited and deleted.
- **Recommendations that learn.** The next nap or bedtime comes with a *sweet spot* window, a countdown, a plan for the rest of the day, and a "Why this time?" explanation.
- **Huckleberry import.** Load a Huckleberry CSV export, see a summary first, and re-importing never creates duplicates.
- **Private and installable.** Plain HTML/JS. Data stays in the browser on your device. Add it to your home screen and it works offline.
- **Optional sync between phones.** Both parents share one baby profile and sleep log, with nothing to re-type on a new phone. See [Sync between phones](#sync-between-phones-optional).

> General guidance only, not medical advice. Follow your baby's cues and your pediatrician.

## Run it

```sh
npm start        # serves on http://localhost:8080 (any static file server works)
npm test         # unit tests (Node 20+). `npm install` first to include the database/sync tests
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

## Sync between phones (optional)

Without sync, each phone keeps its own log. With sync, every phone you invite shares the baby profile and all sleeps: a nap started on one phone appears on the other (it refreshes when you open the app and about every 20 seconds while it's open), either parent can tap Wake up, and a newly joined phone gets the whole history with nothing to type.

It uses **your own free Supabase project** as the shared memory (Napberry has no server of its own). Setup takes about 10 minutes, once, ideally on a computer:

1. Go to [supabase.com](https://supabase.com), click **Start your project**, and sign in (GitHub works).
2. **New project**: any name, a database password (you won't need it again), the region nearest you, the **Free** plan. Wait a couple of minutes while it's created.
3. Open **SQL Editor → New query**, paste the whole contents of [`supabase/setup.sql`](supabase/setup.sql), and press **Run**. It should report success. (Running it twice is harmless.)
4. Open **Project Settings → API Keys** (the wording moves around; you want the **Project URL** and the **publishable** key, which starts `sb_publishable_`; an older project may call it the `anon` key). **Never use the `secret` or `service_role` key.**
5. In Napberry, **Settings → Sync between phones**, paste the Project URL and key, and tap **Turn on sync**. Napberry checks that the database is set up and tells you if something's off.
6. Tap **Share invite** and send the link to the other parent. Opening it sets up their phone. If their phone opens Napberry from the Home Screen instead (below), they can paste the invite on the welcome screen.

**iPhone note.** A Home Screen app on iOS does not share storage with Safari, so one added from Safari starts empty. That's fine with sync: open it, paste the invite on the welcome screen, and everything appears.

**How it behaves.** Napberry always works offline: changes save on the phone first and upload when there's a connection (the little dot by the age shows green, grey while syncing, or orange when offline). If two phones edit the same sleep, the most recent edit wins. If both start a nap before seeing each other's, the first one is kept. Deleting a sleep deletes it everywhere.

**Who can see the data.** Only people who have the invite. It holds the project URL, the public key and a long random family code (128 bits). The database tables are locked so the public key can't read them directly; the only way in is the two functions in `setup.sql`, and each needs the family code. Anyone with the invite can read and edit your baby's name, birth date, sleep times and notes, so share it like a password. It's stored in *your* Supabase project, not mine. To cut off a phone or rotate the code: tap **Turn off here** on every phone, turn sync on again on one (it makes a new family code), re-invite the others, then delete the old rows in the Supabase table editor.

**Costs and limits.** Everything fits easily within Supabase's free plan, and no card is needed. Supabase has paused inactive free projects after a period of no use; if sync ever reports an error after a long break, open the project in the Supabase dashboard and restore it. **Erase all data** only erases the phone you're holding, and turns sync off there. The synced copy stays, and you can rejoin with the invite.

## Your data

Everything is stored in the browser's local storage on **this device**, plus your Supabase project if you turn on sync. **Settings → Backup & sharing** exports a JSON file; importing one *merges* it (it never overwrites), which is a no-account way to move data between phones.

## Code map

```
index.html, manifest.webmanifest, sw.js   app shell, PWA manifest, offline cache
src/app.js         UI: views, dialogs, events
src/predict.js     recommendation engine (pure function of the log)
src/analysis.js    nap/night classification, day building, learned profile
src/norms.js       age-based wake windows
src/huckleberry.js, src/csv.js   CSV import
src/store.js       local-first storage: merge/dedupe, change tracking, backup
src/sync.js        optional sync: Supabase client, invites, sync engine
supabase/setup.sql the database for sync (tables locked down; two functions)
tests/             node:test suites, a synthetic-history generator, and a
                   Postgres-backed stand-in for Supabase (needs `npm install`)
```
