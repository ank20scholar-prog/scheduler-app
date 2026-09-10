/* app.js — wiring.
 *
 * The other modules each own one thing (store = data, timeline = day view,
 * tasks = list, priority = ranking). This file connects them to the buttons
 * and forms in index.html, and owns the once-per-second heartbeat.
 */

import {
  state, load, save, id, COLORS, sanitize, applyState,
  toISODate, fromISODate, addDays, fmt12, toMinutes, toHHMM,
  entriesForDate, autoEntriesForDate, encodeForTransfer, decodeTransfer
} from './store.js';
import { renderDay, tick, scrollToNow } from './timeline.js';
import { renderTasks } from './tasks.js';
import { rankTasks } from './priority.js';
import { showMap, refreshMap, initMapModule } from './map.js';

// ------------------------------------------------------------
// Transient UI state (not saved — it resets when the app restarts)
// ------------------------------------------------------------
let selectedDate = toISODate(new Date());
let draftPriority = 'medium';         // which segment is selected on the task form
let draftClassDays = [];              // which weekday circles are lit
let draftClassColor = COLORS[0];
let draftGapColor = COLORS[1];
let justChangedTask = null;           // task id to play the tick animation on
const reminderTimers = new Map();     // task id -> setTimeout handle

const $ = (sel) => document.querySelector(sel);

// ============================================================
// Redraw everything from current data
// ============================================================
function refresh() {
  renderHeader();
  renderDay(selectedDate, openGapSheet, handleBlockTap);
  renderTasks(toggleTask, deleteTask, justChangedTask);
  renderClassList();
  renderSleepSummary();
  refreshMap();
  scheduleReminders();

  // An app with no data at all should say so, rather than showing an empty
  // grid that looks like a bug.
  $('#today-empty').hidden = state.classes.length > 0 || state.blocks.length > 0;
}

function renderHeader() {
  const today = toISODate(new Date());
  const date = fromISODate(selectedDate);

  let label;
  if (selectedDate === today) label = 'Today';
  else if (selectedDate === addDays(today, 1)) label = 'Tomorrow';
  else if (selectedDate === addDays(today, -1)) label = 'Yesterday';
  else label = date.toLocaleDateString(undefined, { weekday: 'long' });

  $('#day-label').textContent = label;
  $('#day-date').textContent = date.toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric'
  });
}

// ============================================================
// Navigation
// ============================================================

// Bottom tabs swap which <main> is visible.
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
    tab.classList.add('is-active');

    for (const view of ['today', 'tasks', 'map', 'schedule']) {
      $(`#view-${view}`).hidden = view !== tab.dataset.view;
    }
    if (tab.dataset.view === 'map') showMap(selectedDate);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

/* Move the day view forward or back, with a slide in the direction of travel
   so it feels like moving along a timeline rather than the content blinking. */
function changeDay(delta) {
  selectedDate = addDays(selectedDate, delta);
  refresh();

  const view = $('#view-today');
  view.classList.remove('slide-next', 'slide-prev');
  // Reading offsetWidth forces a reflow, which is what makes the animation
  // restart when the same class is re-added in quick succession.
  void view.offsetWidth;
  view.classList.add(delta > 0 ? 'slide-next' : 'slide-prev');
}

$('#prev-day').addEventListener('click', () => changeDay(-1));
$('#next-day').addEventListener('click', () => changeDay(1));

/* Swipe left/right anywhere on the day view to change days — the natural
   gesture on a phone, where reaching the small arrows is awkward. */
(() => {
  const view = $('#view-today');
  let startX = 0, startY = 0, tracking = false;

  view.addEventListener('pointerdown', (e) => {
    // Ignore while the gap sheet is open, so its own interactions are safe.
    if (!$('#gap-sheet').hidden) return;
    tracking = true;
    startX = e.clientX;
    startY = e.clientY;
  });

  view.addEventListener('pointerup', (e) => {
    if (!tracking) return;
    tracking = false;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // Require a decisive horizontal movement, so ordinary vertical scrolling
    // and taps on blocks are never mistaken for a swipe.
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    changeDay(dx < 0 ? 1 : -1);   // swipe left = forward
  });

  view.addEventListener('pointercancel', () => { tracking = false; });
})();

// Tapping the date itself jumps back to today.
$('.header-center').addEventListener('click', () => {
  selectedDate = toISODate(new Date());
  refresh();
  setTimeout(() => scrollToNow(selectedDate), 60);
  toast('Back to today');
});

// ============================================================
// Tasks
// ============================================================

// Priority segmented control
document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', () => {
    document.querySelectorAll('.seg').forEach((s) => {
      s.classList.remove('is-active');
      s.setAttribute('aria-checked', 'false');
    });
    seg.classList.add('is-active');
    seg.setAttribute('aria-checked', 'true');
    draftPriority = seg.dataset.priority;
  });
});

$('#task-form').addEventListener('submit', (e) => {
  e.preventDefault();

  const title = $('#task-title').value.trim();
  const date = $('#task-date').value;
  const time = $('#task-time').value;
  if (!title || !date || !time) return;

  state.tasks.push({
    id: id(),
    title,
    priority: draftPriority,
    // Stored as a local datetime string; `new Date()` parses it in local time.
    due: `${date}T${time}`,
    done: false
  });

  save();
  $('#task-title').value = '';
  refresh();
  toast('Task added');
});

function toggleTask(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  task.done = !task.done;
  save();

  // Play the celebration on this row only, not on every completed task.
  justChangedTask = taskId;
  refresh();
  justChangedTask = null;
}

function deleteTask(taskId) {
  state.tasks = state.tasks.filter((t) => t.id !== taskId);
  save();
  refresh();
  toast('Task deleted');
}

// ============================================================
// Classes (recurring weekly)
// ============================================================

// Weekday circles toggle on and off.
document.querySelectorAll('#daypicker button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const day = Number(btn.dataset.day);
    btn.classList.toggle('is-on');

    if (draftClassDays.includes(day)) {
      draftClassDays = draftClassDays.filter((d) => d !== day);
    } else {
      draftClassDays.push(day);
    }
  });
});

$('#class-form').addEventListener('submit', (e) => {
  e.preventDefault();

  const title = $('#class-title').value.trim();
  const start = $('#class-start').value;
  const end = $('#class-end').value;

  if (!title || !start || !end) return;

  if (!draftClassDays.length) {
    toast('Pick at least one day');
    return;
  }
  // Guard against an end time before the start, which would draw a
  // negative-height block.
  if (toMinutes(end) <= toMinutes(start)) {
    toast('End time must be after the start');
    return;
  }

  state.classes.push({
    id: id(),
    title,
    location: $('#class-location').value.trim(),
    days: [...draftClassDays],
    start,
    end,
    color: draftClassColor
  });

  save();

  // Reset the form for the next class.
  $('#class-title').value = '';
  $('#class-location').value = '';
  draftClassDays = [];
  document.querySelectorAll('#daypicker button').forEach((b) => b.classList.remove('is-on'));

  refresh();
  toast('Class added');
});

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function renderClassList() {
  const list = $('#class-list');
  list.innerHTML = '';
  $('#classes-empty').hidden = state.classes.length > 0;

  // Sorted by start time so the list reads like a day.
  const sorted = [...state.classes].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

  for (const cls of sorted) {
    const li = document.createElement('li');
    li.className = 'class-row';
    li.style.setProperty('--blk', cls.color);

    // Solid colour dot, so this list doubles as the legend for the timeline.
    const dot = document.createElement('span');
    dot.className = 'class-dot';

    const main = document.createElement('div');
    main.className = 'class-main';

    const name = document.createElement('div');
    name.className = 'class-name';
    name.textContent = cls.title;

    const when = document.createElement('div');
    when.className = 'class-when';
    // Days listed in week order rather than the order they were tapped.
    const days = [...cls.days].sort().map((d) => DAY_NAMES[d]).join(' ');
    when.textContent = `${days} · ${fmt12(cls.start)} – ${fmt12(cls.end)}` +
                       (cls.location ? ` · ${cls.location}` : '');

    main.append(name, when);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', `Delete ${cls.title}`);
    del.addEventListener('click', () => {
      if (!confirm(`Delete "${cls.title}" from every week?`)) return;
      state.classes = state.classes.filter((c) => c.id !== cls.id);
      save();
      refresh();
      toast('Class removed');
    });

    li.append(dot, main, del);
    list.appendChild(li);
  }
}

// ============================================================
// Filling a gap in the timeline
// ============================================================

function openGapSheet(gap) {
  $('#gap-heading').textContent = `${fmt12(gap.start)} – ${fmt12(gap.end)}`;
  $('#gap-title').value = '';
  $('#gap-start').value = gap.start;
  $('#gap-end').value = gap.end;

  $('#gap-sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
}

function closeGapSheet() {
  $('#gap-sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
}

$('#gap-cancel').addEventListener('click', closeGapSheet);
$('#sheet-backdrop').addEventListener('click', closeGapSheet);

$('#gap-form').addEventListener('submit', (e) => {
  e.preventDefault();

  const title = $('#gap-title').value.trim();
  const start = $('#gap-start').value;
  const end = $('#gap-end').value;

  if (!title || toMinutes(end) <= toMinutes(start)) {
    toast('End time must be after the start');
    return;
  }

  state.blocks.push({
    id: id(),
    title,
    date: selectedDate,      // one-off: tied to the day being viewed
    start,
    end,
    color: draftGapColor
  });

  save();
  closeGapSheet();
  refresh();
  toast('Added to your day');
});

// Tapping an existing block.
function handleBlockTap(entry) {
  if (entry.kind === 'auto') {
    toast(entry.auto === 'sleep'
      ? 'Bedtime is calculated from your first class — 7 hours before waking'
      : 'Wake-up is 1h 15m before your first class');
    return;
  }
  if (entry.kind === 'class') {
    toast('Edit recurring classes in the Schedule tab');
    return;
  }
  if (confirm(`Remove "${entry.title}"?`)) {
    state.blocks = state.blocks.filter((b) => b.id !== entry.id);
    save();
    refresh();
    toast('Removed');
  }
}

// ============================================================
// Colour swatches (built from the palette in store.js)
// ============================================================
function buildSwatches(container, onPick, initial) {
  container.innerHTML = '';

  COLORS.forEach((color) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch' + (color === initial ? ' is-on' : '');
    btn.style.background = color;
    btn.setAttribute('aria-label', `Colour ${color}`);

    btn.addEventListener('click', () => {
      container.querySelectorAll('.swatch').forEach((s) => s.classList.remove('is-on'));
      btn.classList.add('is-on');
      onPick(color);
    });

    container.appendChild(btn);
  });
}

// ============================================================
// Day window settings
// ============================================================
function wireAutoSleep() {
  const toggle = $('#auto-sleep-toggle');
  toggle.checked = state.settings.autoSleep !== false;

  toggle.addEventListener('change', () => {
    state.settings.autoSleep = toggle.checked;
    save();
    refresh();
    toast(toggle.checked ? 'Sleep blocks on' : 'Sleep blocks off');
  });
}

/* Plain-English summary of what the rule works out to for the day on screen,
   so the calculation is visible rather than something that just appears. */
function renderSleepSummary() {
  const line = $('#sleep-summary');
  if (!state.settings.autoSleep) { line.textContent = ''; return; }

  const generated = autoEntriesForDate(selectedDate);
  const sleep = generated.find((e) => e.auto === 'sleep');
  const ready = generated.find((e) => e.auto === 'ready');

  line.textContent = ready
    ? `For ${$('#day-label').textContent.toLowerCase()}: bed ${sleep ? fmt12(sleep.start) : '—'}, up ${fmt12(ready.start)}.`
    : 'Nothing scheduled that day, so no sleep block is generated.';
}

// ============================================================
// Backup: export / import
// ============================================================

$('#export-btn').addEventListener('click', async () => {
  const json = JSON.stringify(state, null, 2);
  const filename = `scheduler-backup-${toISODate(new Date())}.json`;

  // iOS blocks plain downloads inside an installed web app, so try the native
  // share sheet first — that is the route that actually works on a phone.
  try {
    const file = new File([json], filename, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Scheduler backup' });
      return;
    }
  } catch {
    // Share cancelled or unsupported — fall through to the other routes.
  }

  // Desktop browsers: a normal download.
  try {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast('Backup downloaded');
    return;
  } catch {
    // Last resort below.
  }

  // Everything else: put it on the clipboard so nothing is lost.
  try {
    await navigator.clipboard.writeText(json);
    toast('Backup copied to clipboard');
  } catch {
    toast('Could not export on this device');
  }
});

/* Shared by both import routes. Returns true if the backup was applied.
   Everything goes through sanitize(), so a pasted blob is treated with exactly
   the same suspicion as a chosen file. */
function applyBackupText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast('That is not valid backup text');
    return false;
  }

  const clean = sanitize(parsed);

  if (!clean.classes.length && !clean.blocks.length && !clean.tasks.length) {
    toast('No usable entries found');
    return false;
  }

  const kept = clean.classes.length + clean.blocks.length + clean.tasks.length;
  const found = (Array.isArray(parsed?.classes) ? parsed.classes.length : 0) +
                (Array.isArray(parsed?.blocks) ? parsed.blocks.length : 0) +
                (Array.isArray(parsed?.tasks) ? parsed.tasks.length : 0);
  const dropped = Math.max(0, found - kept);

  const message = dropped
    ? `Replace everything with this backup? ${kept} entries will be restored; ${dropped} could not be read and will be skipped.`
    : `Replace everything currently in the app with this backup? (${kept} entries)`;

  if (!confirm(message)) return false;

  applyState(clean);
  save();
  refresh();
  toast(`Restored ${kept} ${kept === 1 ? 'entry' : 'entries'}`);
  return true;
}

/* ---------- QR transfer to the phone ----------
   Encodes the schedule into the URL fragment and renders it as a QR code.
   Fragments are never sent to a server, so the data goes from this screen to
   your phone's camera and nowhere else — no upload, no account, no server. */
$('#qr-btn').addEventListener('click', () => {
  const box = $('#qr-box');

  if (!box.hidden) { box.hidden = true; return; }

  try {
    const payload = encodeForTransfer();
    const url = `${location.origin}${location.pathname}#s=${payload}`;

    // Type 0 lets the library pick the smallest size that fits; 'L' error
    // correction maximises capacity, which matters for a payload this size.
    const qr = qrcode(0, 'L');
    qr.addData(url);
    qr.make();

    $('#qr-canvas').innerHTML = qr.createImgTag(5, 8);
    box.hidden = false;
    toast('Scan this with your phone');
  } catch (err) {
    // Almost always "code length overflow" — too much data for one QR.
    console.error(err);
    $('#qr-canvas').innerHTML = '';
    box.hidden = true;
    toast('Schedule is too large for a QR code — use the paste option');
  }
});

$('#qr-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(state, null, 2));
    toast('Backup copied — paste it on your phone');
  } catch {
    toast('Could not copy on this device');
  }
});

/* If the app was opened from a QR link, load the schedule it carries.
   Runs before the first render so the app comes up already populated. */
function importFromLink() {
  const hash = location.hash;
  if (!hash.startsWith('#s=')) return false;

  try {
    const decoded = decodeTransfer(hash.slice(3));
    // Still sanitised: arriving by QR earns no extra trust.
    const clean = sanitize(decoded);

    const count = clean.classes.length + clean.blocks.length + clean.tasks.length;
    if (!count) throw new Error('nothing usable in the link');

    if (confirm(`Load this schedule from the link? (${count} entries — replaces what is here.)`)) {
      applyState(clean);
      save();
      return true;
    }
    return false;
  } catch (err) {
    console.error('Could not read the transfer link:', err);
    return false;
  } finally {
    // Strip the payload from the address bar either way, so it does not sit
    // in history or get shared by copying the URL.
    history.replaceState(null, '', location.pathname + location.search);
  }
}

$('#import-btn').addEventListener('click', () => $('#import-file').click());

/* Paste route — far easier than the Files app on a phone. */
$('#paste-load').addEventListener('click', () => {
  const text = $('#paste-input').value.trim();
  if (!text) { toast('Paste your backup text first'); return; }
  if (applyBackupText(text)) $('#paste-input').value = '';
});

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    // Refuse anything implausibly large before reading it into memory.
    if (file.size > 5 * 1024 * 1024) {
      toast('That file is too large to be a backup');
      return;
    }
    applyBackupText(await file.text());
  } catch (err) {
    console.error(err);
    toast('Could not read that file');
  } finally {
    // Clear the input so picking the same file again still fires `change`.
    e.target.value = '';
  }
});

// ============================================================
// Reminders
// ============================================================

/* Local notifications for tasks due soon.
 *
 * These are timers inside the page: they fire while the app is open or warm in
 * the background, not when it has been closed for hours. Genuine scheduled
 * push needs a server, which this app deliberately does not have. */
function scheduleReminders() {
  for (const timer of reminderTimers.values()) clearTimeout(timer);
  reminderTimers.clear();

  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  for (const task of rankTasks(state.tasks)) {
    if (task.done) continue;

    const msUntil = new Date(task.due).getTime() - now;
    if (msUntil <= 0 || msUntil > DAY) continue;

    reminderTimers.set(task.id, setTimeout(() => {
      new Notification(task.title, {
        body: task.ranking.reason,
        icon: 'icons/icon-192.png',
        tag: task.id
      });
    }, msUntil));
  }
}

function wireNotifications() {
  const btn = $('#notify-btn');
  if (!('Notification' in window)) return;

  if (Notification.permission === 'granted' || Notification.permission === 'denied') return;

  // Permission has to be asked for from a real tap, never on load.
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      btn.hidden = true;
      scheduleReminders();
      toast('Reminders on');
    } else {
      toast('Reminders stayed off');
    }
  });
}

// ============================================================
// Toast
// ============================================================
let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2200);
}

// ============================================================
// Service worker — the offline support
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then((registration) => {
        // Ask the browser to look for a newer service worker whenever the app
        // is brought back to the foreground, so updates are picked up promptly.
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) registration.update();
        });
      })
      .catch((err) => console.error('Service worker failed to register:', err));
  });

  /* When a new service worker takes control, reload once so the running page
     is not left half-old. `refreshing` guards against a reload loop, which is
     the classic way this pattern goes wrong. */
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

// ============================================================
// Start
// ============================================================
/* First-run seeding.
 *
 * A brand-new install has nothing in it, which makes the app look broken. So
 * on the very first run it loads the schedule bundled at
 * data/starter-schedule.json.
 *
 * It runs exactly once, tracked by a flag. That matters: if you later delete
 * every class on purpose, they must not silently reappear on the next launch.
 *
 * The file goes through the same validation as any imported backup — being
 * shipped with the app does not make it trusted input.
 */
const SEED_FLAG = 'scheduler.seeded.v1';

async function seedIfFirstRun() {
  if (localStorage.getItem(SEED_FLAG)) return false;

  // Existing data means this is not a first run; just record that and leave.
  if (state.classes.length || state.blocks.length || state.tasks.length) {
    localStorage.setItem(SEED_FLAG, '1');
    return false;
  }

  try {
    const response = await fetch('data/starter-schedule.json', { cache: 'no-store' });
    if (!response.ok) return false;

    const clean = sanitize(await response.json());
    if (!clean.classes.length) return false;

    applyState(clean);
    save();
    localStorage.setItem(SEED_FLAG, '1');
    return true;
  } catch (err) {
    // No starter file, or offline on the very first load. Not an error worth
    // bothering the user about — the app simply starts empty.
    console.info('No starter schedule loaded:', err.message);
    return false;
  }
}

async function init() {
  load();

  // A QR link wins over first-run seeding: if you scanned a code, that is
  // what you asked for.
  const fromLink = importFromLink();
  const seeded = fromLink ? false : await seedIfFirstRun();

  buildSwatches($('#class-swatches'), (c) => { draftClassColor = c; }, draftClassColor);
  buildSwatches($('#gap-swatches'), (c) => { draftGapColor = c; }, draftGapColor);
  wireAutoSleep();
  wireNotifications();
  initMapModule();

  // Default the task form to today, an hour from now, rounded.
  const soon = new Date();
  soon.setHours(soon.getHours() + 1, 0, 0, 0);
  $('#task-date').value = toISODate(soon);
  $('#task-time').value = toHHMM(soon.getHours() * 60);

  refresh();
  // Let layout settle before measuring where "now" is.
  setTimeout(() => scrollToNow(selectedDate), 120);
  if (fromLink) toast('Schedule loaded from your link');
  else if (seeded) toast('Your schedule is loaded');

  // The heartbeat: moves the now-line and updates the character.
  setInterval(() => tick(selectedDate), 1000);

  // Coming back to the app after it has been backgrounded — the clock may have
  // moved a long way, so redraw rather than waiting for the next tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

init();
