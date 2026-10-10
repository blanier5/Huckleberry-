import { createStore } from './store.js';
import { predict } from './predict.js';
import { groupByDay, classifySleep } from './analysis.js';
import { parseHuckleberryCSV } from './huckleberry.js';
import {
  MIN,
  startOfDay,
  ageInMonths,
  fmtAge,
  fmtClock,
  fmtDuration,
  fmtMinutesAsClock,
  fmtRelative,
  dayLabel,
  toInputValue,
  fromInputValue,
  parseDateOnly,
  parseHHMM,
  toHHMM,
} from './time.js';

const store = createStore();
const ui = { tab: 'today', historyDays: 14, whyOpen: false, quiet: false, preview: null };

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => n.toLocaleString();

const svg = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  today: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  history: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  settings: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
};
const TABS = [
  ['today', 'Today'],
  ['history', 'History'],
  ['settings', 'Settings'],
];

function prediction(now = Date.now()) {
  const { baby, settings, sleeps } = store.state;
  const bedtimeMin = settings.bedtime ? parseHHMM(settings.bedtime) : null;
  return predict({ sleeps, baby, settings: bedtimeMin == null ? {} : { bedtimeMin }, now });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  renderHeader();
  renderMain();
  renderTabs();
}

function renderHeader() {
  const { baby } = store.state;
  $('top').hidden = !baby;
  if (!baby) return;
  $('top').innerHTML = `<h1>${esc(baby.name || 'Baby')}</h1><span class="chip">${fmtAge(ageInMonths(baby.birth, Date.now()))}</span>`;
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.hidden = !store.state.baby;
  tabs.innerHTML = TABS.map(
    ([id, label]) =>
      `<button type="button" data-action="tab" data-tab="${id}" ${ui.tab === id ? 'aria-current="page"' : ''}>${ICONS[id]}${label}</button>`,
  ).join('');
}

function renderMain() {
  const main = $('main');
  if (!store.state.baby) {
    main.innerHTML = viewOnboarding();
    return;
  }
  const view = { today: viewToday, history: viewHistory, settings: viewSettings }[ui.tab];
  main.innerHTML = `<div class="stack">${view()}</div>`;
}

function viewOnboarding() {
  return `
    <div class="welcome stack">
      <div>
        <h1>Napberry</h1>
        <p>Record naps in one tap and get nap and bedtime suggestions that learn your baby's rhythm.</p>
      </div>
      <form id="onboard" class="card">
        <label class="field"><span>Baby's name</span><input type="text" name="name" autocomplete="off" required></label>
        <label class="field"><span>Birth date</span><input type="date" name="birth" max="${toInputValue(Date.now()).slice(0, 10)}" required></label>
        <p class="muted small" style="margin-top:10px">Age sets the starting wake windows. After this you can import your Huckleberry history.</p>
        <button class="btn" style="margin-top:16px">Get started</button>
      </form>
      <p class="muted small">Everything is stored on this device only. Napberry gives general guidance, not medical advice.</p>
    </div>`;
}

function sleepRow(s, now, groupDate) {
  const minutes = ((s.end ?? now) - s.start) / MIN;
  // A night that began the evening before is listed under the morning it ends, so say which evening.
  const prefix = startOfDay(s.start) !== groupDate ? `${new Date(s.start).toLocaleDateString([], { weekday: 'short' })} ` : '';
  const range = `${prefix}${fmtClock(s.start)} – ${s.end == null ? 'now' : fmtClock(s.end)}`;
  return `<li><button type="button" class="row" data-action="edit" data-id="${esc(s.id)}">
    <span class="dot ${s.kind === 'night' ? 'night' : ''}"></span>
    <span class="grow"><span class="title">${s.kind === 'night' ? 'Night sleep' : 'Nap'}</span><br>
    <span class="meta">${range}${s.notes ? ` · ${esc(s.notes)}` : ''}</span></span>
    <span class="end">${fmtDuration(minutes)}</span></button></li>`;
}

function planRows(items) {
  return items
    .map((i) => {
      if (i.kind === 'bedtime') {
        const note = i.skippedNap ? 'Skips nap ' + i.skippedNap + ' to protect bedtime' : '';
        return `<li><div class="row"><span class="dot bed"></span><span class="grow"><span class="title">Bedtime</span>${note ? `<br><span class="meta">${note}</span>` : ''}</span><span class="end">${fmtClock(i.at)}</span></div></li>`;
      }
      const note = i.capped ? 'Keep it short to protect bedtime' : `about ${fmtDuration(i.len)}`;
      return `<li><div class="row"><span class="dot"></span><span class="grow"><span class="title">Nap ${i.number}</span><br><span class="meta">${note}</span></span><span class="end">${fmtClock(i.at)}</span></div></li>`;
    })
    .join('');
}

function timing(item, now) {
  const word = item.kind === 'bedtime' ? 'ideal bedtime' : 'sweet spot';
  if (now < item.earliest) return { text: fmtRelative(item.at, now), late: false };
  if (now <= item.latest) return { text: item.kind === 'bedtime' ? 'Bedtime is now' : 'Sweet spot is now', late: false };
  return { text: `${fmtDuration((now - item.latest) / MIN)} past the ${word}`, late: true };
}

function basisChip(p) {
  return p.learned
    ? `Learned from your last ${p.learned.days} days. Suggestions get sharper as you log more.`
    : `Based on typical sleep at ${fmtAge(p.ageMonths)}. Import your Huckleberry history or log a few days and it will learn your baby's own rhythm.`;
}

function todayLog(now) {
  const from = startOfDay(now);
  return store.state.sleeps.filter((s) => (s.end ?? now) >= from).sort((a, b) => b.start - a.start);
}

function viewToday() {
  const now = Date.now();
  const p = prediction(now);
  const log = todayLog(now);
  const out = [];

  if (p.mode === 'asleep') {
    const night = p.kind === 'night';
    const expect = night
      ? `Usually wakes around ${fmtClock(p.expectedWake)}.`
      : p.wakeBy
        ? `Nap ${p.napNumber} usually runs ${fmtDuration(p.typicalLen)}. Aim to wake by ${fmtClock(p.wakeBy)} to protect bedtime.`
        : `Nap ${p.napNumber} usually runs ${fmtDuration(p.typicalLen)}, so around ${fmtClock(p.expectedWake)}.`;
    out.push(`
      <section class="hero asleep" aria-label="Sleep in progress">
        <div class="eyebrow">${night ? 'Night sleep' : 'Napping'} since ${fmtClock(p.since)}</div>
        <div class="big">${fmtDuration(p.elapsed)}</div>
        <p class="sub">${expect}</p>
        <div class="cta"><button type="button" class="btn on-hero" data-action="wake">Wake up</button></div>
        <div class="links"><button type="button" class="link" data-action="wake-at">Woke up earlier…</button></div>
      </section>`);
    if (p.after?.length) {
      out.push(`<section class="card"><h2>After waking</h2><ul class="rows">${planRows(p.after)}</ul></section>`);
    }
  } else if (p.mode === 'awake') {
    const { next } = p;
    const t = timing(next, now);
    const isNap = next.kind === 'nap';
    out.push(`
      <section class="hero" aria-label="Next sleep">
        <div class="eyebrow">Awake for ${fmtDuration((now - p.awakeSince) / MIN)} · since ${fmtClock(p.awakeSince)}</div>
        <div class="label">${isNap ? `Next nap${p.napsExpected > 1 ? ` (${next.number} of ${p.napsExpected})` : ''}` : 'Bedtime'}</div>
        <div class="big">${fmtClock(next.at)}</div>
        <p class="status ${t.late ? 'late' : ''}">${t.text}</p>
        <p class="sub">Sweet spot ${fmtClock(next.earliest)} – ${fmtClock(next.latest)}</p>
        <div class="cta"><button type="button" class="btn on-hero" data-action="start" data-kind="${isNap ? 'nap' : 'night'}">${isNap ? 'Start nap' : 'Start bedtime'}</button></div>
        <div class="links">
          <button type="button" class="link" data-action="start-at" data-kind="${isNap ? 'nap' : 'night'}">Started earlier…</button>
          <button type="button" class="link" data-action="start" data-kind="${isNap ? 'night' : 'nap'}">${isNap ? 'Log night sleep instead' : 'Log a nap instead'}</button>
        </div>
      </section>
      <details class="card" id="why" ${ui.whyOpen ? 'open' : ''}>
        <summary>Why ${fmtClock(next.at)}?</summary>
        <ul>${p.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        <p class="muted small" style="margin-top:10px">${basisChip(p)}</p>
      </details>
      <section class="card"><h2>Today's plan</h2><ul class="rows">${planRows([next, ...p.later])}</ul></section>`);
  } else if (p.mode === 'night-awake') {
    out.push(`
      <section class="hero" aria-label="Night waking">
        <div class="eyebrow">Awake since ${fmtClock(p.awakeSince)}</div>
        <div class="label">Night waking</div>
        <p class="sub" style="margin-top:8px">Start a sleep when baby goes back down. Day naps are suggested once the morning starts.</p>
        <div class="cta"><button type="button" class="btn on-hero" data-action="start" data-kind="night">Back to sleep</button></div>
        <div class="links"><button type="button" class="link" data-action="start-at" data-kind="night">Started earlier…</button></div>
      </section>`);
  } else {
    const stale = p.mode === 'stale';
    out.push(`
      <section class="card empty">
        <h2>${stale ? 'Catch up the log' : `Welcome, ${esc(store.state.baby.name)}`}</h2>
        <p class="muted">${
          stale
            ? `The last logged sleep ended ${fmtRelative(p.lastEnd, now)}, so there's nothing to predict from yet. Add what you missed, or start a sleep now.`
            : `Bring over your Huckleberry history so suggestions start out personalised, or just start logging.`
        }</p>
        ${stale ? '' : '<button type="button" class="btn" data-action="pick-csv">Import Huckleberry CSV</button>'}
        <button type="button" class="btn ${stale ? '' : 'secondary'}" data-action="start" data-kind="nap">Start nap</button>
        <button type="button" class="btn secondary" data-action="add">Add a past sleep</button>
      </section>`);
  }

  out.push(`
    <section class="card">
      <h2>Today so far<span class="aside">${log.length ? '' : 'nothing logged'}</span></h2>
      ${log.length ? `<ul class="rows">${log.map((s) => sleepRow(s, now, startOfDay(now))).join('')}</ul>` : ''}
      <button type="button" class="link" data-action="add">+ Add a past sleep</button>
    </section>`);
  return out.join('');
}

function viewHistory() {
  const now = Date.now();
  const groups = groupByDay(store.state.sleeps, now);
  if (!groups.length) {
    return `<section class="card empty"><h2>No sleep logged yet</h2><p class="muted">Logged naps show up here, grouped by day.</p>
      <button type="button" class="btn" data-action="pick-csv">Import Huckleberry CSV</button></section>`;
  }
  const shown = groups.slice(0, ui.historyDays);
  const sleepCount = store.state.sleeps.length;
  return `
    <div class="day-head"><span class="muted small">${num(sleepCount)} sleeps logged</span>
      <button type="button" class="link" style="color:var(--accent)" data-action="add">+ Add</button></div>
    ${shown
      .map(
        (g) => `
      <section class="card">
        <div class="day-head"><h2>${dayLabel(g.date, now)}</h2>
          <span class="muted small">${g.napCount} ${g.napCount === 1 ? 'nap' : 'naps'} · ${fmtDuration(g.napMinutes)}${g.nightMinutes ? ` · night ${fmtDuration(g.nightMinutes)}` : ''}</span></div>
        <ul class="rows">${g.items.map((s) => sleepRow(s, now, g.date)).join('')}</ul>
      </section>`,
      )
      .join('')}
    ${groups.length > shown.length ? `<button type="button" class="btn secondary" data-action="more-history">Show earlier days (${groups.length - shown.length} more)</button>` : ''}`;
}

function viewSettings() {
  const { baby, settings, sleeps } = store.state;
  const fixed = Boolean(settings.bedtime);
  const p = prediction();
  const learned = fmtMinutesAsClock(p.bedtimeMin);
  return `
    <section class="card">
      <h2>Baby</h2>
      <label class="field"><span>Name</span><input type="text" data-setting="name" value="${esc(baby.name)}" autocomplete="off"></label>
      <label class="field"><span>Birth date</span><input type="date" data-setting="birth" value="${toInputValue(baby.birth).slice(0, 10)}" max="${toInputValue(Date.now()).slice(0, 10)}"></label>
    </section>

    <section class="card">
      <h2>Bedtime</h2>
      <div class="seg" role="radiogroup" aria-label="Bedtime mode">
        <label><input type="radio" name="bedtime-mode" value="auto" ${fixed ? '' : 'checked'}><span>Learn it</span></label>
        <label><input type="radio" name="bedtime-mode" value="fixed" ${fixed ? 'checked' : ''}><span>Set a time</span></label>
      </div>
      <label class="field"><span>Target bedtime</span><input type="time" data-setting="bedtime-time" value="${settings.bedtime || toHHMM(p.bedtimeMin)}" ${fixed ? '' : 'disabled'}></label>
      <p class="muted small" id="bedtime-hint" style="margin-top:8px">${fixed ? 'Naps are planned around this time.' : `Currently about ${learned}, based on ${p.learned ? 'recent nights' : 'age'}.`}</p>
    </section>

    <section class="card">
      <h2>Import from Huckleberry</h2>
      <p class="muted small" style="margin-bottom:12px">Export your data from Huckleberry as a CSV, then choose the file here. You'll see a summary before anything is added, and re-importing never creates duplicates.</p>
      <button type="button" class="btn" data-action="pick-csv">Choose CSV file…</button>
    </section>

    <section class="card">
      <h2>Backup &amp; sharing</h2>
      <p class="muted small" style="margin-bottom:12px">Data lives on this device. To use another phone, export a backup here and import it there. Importing merges, so nothing is overwritten.</p>
      <div class="dialog-actions" style="margin-top:0">
        <button type="button" class="btn secondary" data-action="export-json">Export</button>
        <button type="button" class="btn secondary" data-action="pick-json">Import backup</button>
      </div>
    </section>

    <section class="card">
      <h2>Erase everything</h2>
      <p class="muted small" style="margin-bottom:12px">Removes ${num(sleeps.length)} logged sleeps and the baby profile from this device.</p>
      <button type="button" class="btn danger" data-action="reset">Erase all data</button>
    </section>

    <p class="muted small">Napberry gives general guidance based on typical wake windows and your baby's own pattern. It isn't medical advice. Always follow your baby's cues and your pediatrician's guidance.</p>`;
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

function showDialog(html, onSubmit) {
  const d = $('dialog');
  d.innerHTML = html;
  d.onsubmit = (e) => {
    e.preventDefault();
    onSubmit?.(new FormData(e.target), e.submitter);
  };
  d.onclick = (e) => {
    if (e.target === d) d.close();
  };
  if (!d.open) d.showModal();
}

function closeDialog() {
  const d = $('dialog');
  if (d.open) d.close();
}

function dialogError(msg) {
  const el = $('dialog').querySelector('.error');
  if (el) {
    el.textContent = msg;
    el.hidden = false;
  }
}

const kindSeg = (kind) => `
  <div class="seg" role="radiogroup" aria-label="Type">
    <label><input type="radio" name="kind" value="nap" ${kind === 'nap' ? 'checked' : ''}><span>Nap</span></label>
    <label><input type="radio" name="kind" value="night" ${kind === 'night' ? 'checked' : ''}><span>Night</span></label>
  </div>`;

function openSleepEditor(id) {
  const existing = id ? store.state.sleeps.find((s) => s.id === id) : null;
  const now = Date.now();
  const s = existing ?? { kind: classifySleep(now - 60 * MIN, now - 1), start: now - 60 * MIN, end: now, notes: '' };
  const ongoing = existing && existing.end == null;
  showDialog(
    `<form>
      <h2>${existing ? 'Edit sleep' : 'Add a past sleep'}</h2>
      <label class="field"><span>Type</span>${kindSeg(s.kind)}</label>
      <label class="field"><span>Fell asleep</span><input type="datetime-local" name="start" value="${toInputValue(s.start)}" required></label>
      <label class="field"><span>Woke up${ongoing ? ' (leave empty while still asleep)' : ''}</span><input type="datetime-local" name="end" value="${s.end ? toInputValue(s.end) : ''}" ${ongoing ? '' : 'required'}></label>
      <label class="field"><span>Notes</span><input type="text" name="notes" value="${esc(s.notes)}" autocomplete="off"></label>
      <p class="error" hidden></p>
      <div class="dialog-actions">
        <button type="button" class="btn secondary" data-action="close">Cancel</button>
        <button class="btn">Save</button>
      </div>
      ${existing ? '<div class="dialog-actions" style="margin-top:10px"><button class="btn danger" name="act" value="delete">Delete this sleep</button></div>' : ''}
    </form>`,
    (form, submitter) => {
      if (existing && submitter?.value === 'delete') {
        if (!confirm('Delete this sleep?')) return;
        store.removeSleep(existing.id);
        closeDialog();
        toast('Deleted');
        return;
      }
      const start = fromInputValue(form.get('start'));
      const endRaw = form.get('end');
      const end = endRaw ? fromInputValue(endRaw) : null;
      if (start == null) return dialogError('Enter when baby fell asleep.');
      if (end == null && !ongoing) return dialogError('Enter when baby woke up.');
      if (end != null && end <= start) return dialogError('Wake-up has to be after the fall-asleep time.');
      if (end != null && end - start > 20 * 60 * MIN) return dialogError('That is longer than 20 hours. Check the dates.');
      if (start > Date.now() + 5 * MIN) return dialogError('That start time is in the future.');
      const patch = { start, end, kind: form.get('kind'), notes: String(form.get('notes') || '').trim() };
      if (existing) store.updateSleep(existing.id, patch);
      else store.addSleep(patch);
      closeDialog();
      toast('Saved');
    },
  );
}

const OFFSETS = [
  ['Now', 0],
  ['5 min ago', 5],
  ['10 min ago', 10],
  ['15 min ago', 15],
  ['30 min ago', 30],
];

function openTimeDialog({ title, hint, kind, onConfirm, validate }) {
  const value = toInputValue(Date.now() - 10 * MIN);
  showDialog(
    `<form>
      <h2>${title}</h2>
      <p class="muted small">${hint}</p>
      ${kind ? `<label class="field"><span>Type</span>${kindSeg(kind)}</label>` : ''}
      <label class="field"><span>Time</span><input type="datetime-local" name="at" value="${value}" required></label>
      <div class="chips">${OFFSETS.map(([label, m]) => `<button type="button" data-action="offset" data-minutes="${m}">${label}</button>`).join('')}</div>
      <p class="error" hidden></p>
      <div class="dialog-actions">
        <button type="button" class="btn secondary" data-action="close">Cancel</button>
        <button class="btn">Confirm</button>
      </div>
    </form>`,
    (form) => {
      const at = fromInputValue(form.get('at'));
      if (at == null) return dialogError('Enter a time.');
      if (at > Date.now() + MIN) return dialogError("That time is in the future.");
      const problem = validate?.(at);
      if (problem) return dialogError(problem);
      closeDialog();
      onConfirm(at, form.get('kind'));
    },
  );
}

function startAt(kind) {
  const sleeps = store.state.sleeps;
  const lastEnd = sleeps.reduce((m, s) => Math.max(m, s.end ?? 0), 0);
  openTimeDialog({
    title: kind === 'night' ? 'Bedtime started earlier' : 'Nap started earlier',
    hint: 'When did baby fall asleep?',
    kind,
    validate: (at) => (at < lastEnd ? `That overlaps the previous sleep, which ended at ${fmtClock(lastEnd)}.` : ''),
    onConfirm: (at, k) => {
      store.startSleep(k, at);
      toast('Sleep started');
    },
  });
}

function wakeAt() {
  const s = store.ongoing;
  if (!s) return;
  openTimeDialog({
    title: 'Woke up earlier',
    hint: 'When did baby wake up?',
    validate: (at) => (at <= s.start ? `That's before the sleep started at ${fmtClock(s.start)}.` : ''),
    onConfirm: (at) => {
      store.endSleep(at);
      toast('Sleep logged');
    },
  });
}

/* ------------------------------------------------------------------ */
/* Import / export                                                     */
/* ------------------------------------------------------------------ */

async function onCsvChosen(file) {
  let result;
  try {
    result = parseHuckleberryCSV(await file.text());
  } catch (err) {
    result = { ok: false, error: `Couldn't read that file (${err.message}).` };
  }
  if (!result.ok) return showMessage('Import failed', result.error);
  const { sleeps, stats } = result;
  if (!sleeps.length) {
    const types = Object.entries(stats.types).map(([t, n]) => `${t} (${n})`).join(', ');
    return showMessage(
      'No sleeps found',
      `Read ${num(stats.rows)} rows but none were readable sleep entries. Entry types in the file: ${types || 'none'}.`,
    );
  }
  const dupes = store.countDuplicates(sleeps);
  const fresh = sleeps.length - dupes;
  ui.preview = sleeps;
  const day = (ms) => new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  const types = Object.entries(stats.types)
    .filter(([t]) => !/sleep|nap/i.test(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([t, n]) => `${esc(t)} ${num(n)}`)
    .join(' · ');
  showDialog(
    `<form>
      <h2>Import ${num(fresh)} ${fresh === 1 ? 'sleep' : 'sleeps'}?</h2>
      <p class="muted small">${day(stats.first)} to ${day(stats.last)}</p>
      <div class="stats">
        <div><b>${num(stats.naps)}</b><span class="muted small">naps</span></div>
        <div><b>${num(stats.nights)}</b><span class="muted small">night sleeps</span></div>
      </div>
      <p class="small muted" style="margin-top:10px">${
        dupes ? `${num(dupes)} already in the app will be skipped. ` : ''
      }${stats.skippedNonSleep ? `Ignored ${num(stats.skippedNonSleep)} other entries (${types}). ` : ''}${
        stats.skippedInvalid ? `${num(stats.skippedInvalid)} sleep rows couldn't be read${stats.invalid[0] ? ` (e.g. line ${stats.invalid[0].line}: ${esc(stats.invalid[0].reason)})` : ''}. ` : ''
      }${stats.noTypeColumn ? 'No "Type" column found, so every row was treated as sleep. ' : ''}Times are read in this device's time zone. Naps and night sleep are told apart by time of day; you can fix any entry afterwards.</p>
      <div class="dialog-actions">
        <button type="button" class="btn secondary" data-action="close">Cancel</button>
        <button class="btn" ${fresh ? '' : 'disabled'}>Import</button>
      </div>
    </form>`,
    () => {
      const { added } = store.mergeSleeps(ui.preview);
      ui.preview = null;
      closeDialog();
      ui.tab = 'today';
      render();
      toast(`Imported ${num(added)} ${added === 1 ? 'sleep' : 'sleeps'}`);
    },
  );
}

function showMessage(title, text) {
  showDialog(`<form><h2>${esc(title)}</h2><p class="muted" style="margin-top:6px">${esc(text)}</p>
    <div class="dialog-actions"><button type="button" class="btn" data-action="close">OK</button></div></form>`);
}

function exportBackup() {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `napberry-backup-${toInputValue(Date.now()).slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function onJsonChosen(file) {
  try {
    const { added, duplicates } = store.importJSON(await file.text());
    toast(`Backup merged: ${num(added)} added${duplicates ? `, ${num(duplicates)} already there` : ''}`);
  } catch (err) {
    showMessage('Import failed', err.message || 'That file could not be read.');
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const actions = {
  tab: (el) => {
    ui.tab = el.dataset.tab;
    render();
    window.scrollTo(0, 0);
  },
  start: (el) => {
    store.startSleep(el.dataset.kind);
  },
  'start-at': (el) => startAt(el.dataset.kind),
  wake: () => {
    store.endSleep();
    toast('Sleep logged');
  },
  'wake-at': wakeAt,
  edit: (el) => openSleepEditor(el.dataset.id),
  add: () => openSleepEditor(null),
  close: closeDialog,
  offset: (el) => {
    const input = $('dialog').querySelector('input[name="at"]');
    input.value = toInputValue(Date.now() - Number(el.dataset.minutes) * MIN);
  },
  'more-history': () => {
    ui.historyDays += 14;
    renderMain();
  },
  'pick-csv': () => $('csv-input').click(),
  'pick-json': () => $('json-input').click(),
  'export-json': exportBackup,
  reset: () => {
    if (confirm('Erase all sleep data and the baby profile from this device? This cannot be undone.')) {
      store.reset();
      ui.tab = 'today';
      toast('All data erased');
    }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el) actions[el.dataset.action]?.(el);
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'onboard') return;
  e.preventDefault();
  const form = new FormData(e.target);
  const birth = parseDateOnly(form.get('birth'));
  if (birth == null) return;
  store.setBaby({ name: String(form.get('name')).trim(), birth });
});

document.addEventListener('change', (e) => {
  const t = e.target;
  const quiet = (fn) => {
    ui.quiet = true;
    try {
      fn();
    } finally {
      ui.quiet = false;
    }
  };
  if (t.matches('[data-setting="name"]')) {
    quiet(() => store.setBaby({ ...store.state.baby, name: t.value.trim() }));
  } else if (t.matches('[data-setting="birth"]')) {
    const birth = parseDateOnly(t.value);
    if (birth != null) quiet(() => store.setBaby({ ...store.state.baby, birth }));
  } else if (t.name === 'bedtime-mode' || t.matches('[data-setting="bedtime-time"]')) {
    const mode = document.querySelector('input[name="bedtime-mode"]:checked')?.value;
    const time = document.querySelector('[data-setting="bedtime-time"]');
    time.disabled = mode !== 'fixed';
    quiet(() => store.setSettings({ bedtime: mode === 'fixed' && time.value ? time.value : null }));
    $('bedtime-hint').textContent = mode === 'fixed' ? 'Naps are planned around this time.' : 'Learned from recent nights.';
  } else if (t.id === 'csv-input' && t.files[0]) {
    onCsvChosen(t.files[0]);
    t.value = '';
  } else if (t.id === 'json-input' && t.files[0]) {
    onJsonChosen(t.files[0]);
    t.value = '';
  }
});

document.addEventListener('toggle', (e) => {
  if (e.target.id === 'why') ui.whyOpen = e.target.open;
}, true);

store.subscribe(() => {
  if (ui.quiet) renderHeader();
  else render();
});

function tick() {
  if (document.hidden || !store.state.baby || ui.tab !== 'today' || $('dialog').open) return;
  renderMain();
}
setInterval(tick, 15_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    renderHeader();
    tick();
  }
});

render();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
