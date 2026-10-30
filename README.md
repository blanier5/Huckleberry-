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

Nap count is **never** a goal or a limit. At young ages it swings a lot (4 to 7 naps a day is normal for a 2-month-old), so Napberry shows "5 naps so far" as information only and keeps suggesting naps until another one no longer makes sense before bedtime.

The next suggestion is built from four things:

1. **When she last woke.** Her usual wake window for that time of day, learned from the last three weeks of *every* day (not matched to nap number), blended with what's typical for her age until there's enough history. The sweet spot is the best guess; windows are irregular, so it also says when to start watching for sleepy cues.
2. **How good the last nap was.** A nap under about 30 to 40 minutes isn't restorative, so the next window is shorter (a 20-minute nap leads to roughly a 25% shorter window than a normal one). Once a nap is a normal length the effect levels off.
3. **How the night went.** If last night was rougher than her usual nights (less total sleep, a shorter longest stretch, or more broken up), windows are about 5 to 9% shorter that day and an extra nap is easier to add.
4. **Where bedtime should land.** For every possible number of naps, Napberry asks how much her usual windows and nap lengths would have to bend to land on bedtime, and picks the count that bends them least. The first window stays close to natural; the **late afternoon** is where the bending happens. If the alternative is a long stretch awake before bed, the last nap becomes a short **bridge nap** (about 20 to 40 minutes), even if it is nap #6 or #7.

Every suggestion has a "Why this time?" panel listing exactly what it used.

### Schedule settings (Settings tab)

- **What matters most.** *Protect bedtime* holds bedtime tightly and bends the day to it. *Maximize total sleep* lets naps run their course and offers extra naps, with bedtime free to drift about an hour. *Build a consistent morning wake time* anchors the day to your wake target. *Follow baby cues* stays close to her natural windows and lets bedtime land within about an hour of the target.
- **Desired bedtime.** For example 8:30 PM. The late afternoon is shaped to land on it instead of wherever her windows happen to lead. Leave it unset to use where bedtime has been lately.
- **Move bedtime gradually.** Instead of one jump, the target moves toward your desired bedtime in small steps: *10 min every 3 days*, *15 min every 3 days* or *15 min every 2 days*. A step only happens once she has actually gone down near the current target for that many days; if she can't keep up, the target eases back instead of racing ahead. Works for earlier or later. "Starting from" is filled in for you and can be changed.
- **Morning wake target with a range.** For example 8:00 AM &plusmn; 30 minutes, meaning 7:30 to 8:30 is fine. While she is asleep past the range, Napberry says *"Wake by 8:30 AM to protect tonight's bedtime"* instead of pushing the whole day later (unless it's a [rough day](#rough-days), when she can sleep on). If she wakes late, the day is compressed and bedtime stays put. You can also work toward the wake time gradually.
- **Fell asleep early.** If she drops off before the suggested time, tap **Fell asleep early** instead of just *Start nap*. Napberry records when it had suggested, and learns that her windows around that time of day run shorter, instead of treating it as a one-off.

### Rough days

A day with short or interrupted naps, trouble settling, shots, an appointment or an illness leaves a baby needing more sleep, not an exact bedtime. When a day counts as rough, Napberry:

- **never asks you to wake her to protect bedtime** (no "wake by" prompts, tonight or in the morning),
- plans windows a little shorter, lets naps run long, and is quicker to add an extra nap, with no nap-count limit either way,
- lets bedtime move earlier or later instead of cutting sleep short, and says where it expects it to land,
- recalculates the rest of the day when a nap runs past its usual length: fewer naps, shorter ones, or a later bedtime, never a nap cut off in the plan.

Two things make it a rough day, and either is enough:

1. **What the log shows.** Short naps (short for her, so a baby who always catnaps isn't flagged), naps marked *cut short*, naps marked *took a while to settle* or *several failed transfers*, and a rough night add up to a strain score. Two short naps, or one interrupted short nap, or failed transfers plus a short nap, is a rough day; a single short nap only nudges. Say how a sleep went with **How did she settle?** while she's asleep, or in the sleep editor (**Settling**, **Cut short**).
2. **Rough-day mode, by hand.** On Today, tap **Rough day? Be flexible today** and tick what's going on: vaccination or shots, an appointment, not feeling well, travel, naps getting interrupted, trouble settling. It syncs to the other phone, and switches off by itself once she wakes for the day after the night that follows (or after 36 hours).

On an ordinary day, waking her is a last resort: it is mentioned only when letting her sleep on would push bedtime 20 or more minutes past your target even after dropping naps and shortening the evening, and it says what sleeping on would cost ("bedtime lands about 9:40 PM, 40 minutes after your target") so the choice is yours. These notes sync like everything else and need no database update.

Napberry gives general guidance, not medical advice. Predictions are most meaningful from about 2 months, and at young ages windows vary a lot from day to day, which is why suggestions come with a range and a "watch for cues" time.

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

**Updating the database (one paste, only when a release says so).** Newer versions add the "fell asleep early" notes, which need one extra column. Open Supabase, go to SQL Editor, paste the current `supabase/setup.sql` and Run it again. It's safe to repeat and keeps all your data. Until you do, everything still works; those notes just stay on the phone that recorded them. You won't have to remember: while the database is a version behind, Settings shows a **One-time database update** notice (with a **Copy the SQL** button and a link to your project's SQL editor) and a dot on the Settings tab. It disappears by itself once the script has been run.

**How it behaves.** Napberry always works offline: changes save on the phone first and upload when there's a connection (the little dot by the age shows green, grey while syncing, or orange when offline). If two phones edit the same sleep, the most recent edit wins. If both start a nap before seeing each other's, the first one is kept. Deleting a sleep deletes it everywhere.

**Who can see the data.** Only people who have the invite. It holds the project URL, the public key and a long random family code (128 bits). The database tables are locked so the public key can't read them directly; the only way in is the two functions in `setup.sql`, and each needs the family code. Anyone with the invite can read and edit your baby's name, birth date, sleep times and notes, so share it like a password. It's stored in *your* Supabase project, not mine. To cut off a phone or rotate the code: tap **Turn off here** on every phone, turn sync on again on one (it makes a new family code), re-invite the others, then delete the old rows in the Supabase table editor.

**Costs and limits.** Everything fits easily within Supabase's free plan, and no card is needed. Supabase has paused inactive free projects after a period of no use; if sync ever reports an error after a long break, open the project in the Supabase dashboard and restore it. **Erase all data** only erases the phone you're holding, and turns sync off there. The synced copy stays, and you can rejoin with the invite.

## Your data

Everything is stored in the browser's local storage on **this device**, plus your Supabase project if you turn on sync. **Settings → Backup & sharing** exports a JSON file; importing one *merges* it (it never overwrites), which is a no-account way to move data between phones.

## Code map

```
index.html, manifest.webmanifest, sw.js   app shell, PWA manifest, offline cache
src/app.js         UI: views, dialogs, events
src/predict.js     builds a prediction from the log and settings (pure function)
src/recovery.js    rough days: how strained today has been, rough-day mode, relaxed planning
src/planner.js     fits naps and a bridge nap between her last wake and bedtime
src/learn.js       her rhythm by time of day, nap quality, rough nights, early notes
src/shift.js       gradual bedtime / wake-time shifting and the wake range
src/settings.js    the schedule settings and their validation
src/analysis.js    nap/night classification, day building
src/norms.js       age-based wake windows
src/huckleberry.js, src/csv.js   CSV import
src/store.js       local-first storage: merge/dedupe, change tracking, backup
src/sync.js        optional sync: Supabase client, invites, sync engine
supabase/setup.sql the database for sync (tables locked down; two functions)
tests/             node:test suites, a synthetic-history generator, and a
                   Postgres-backed stand-in for Supabase (needs `npm install`)
```
