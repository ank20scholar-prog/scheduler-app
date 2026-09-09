/* store.js — the single source of truth for app data.
 *
 * Everything the app knows lives in the `state` object below and is mirrored
 * into localStorage so it survives closing the app. Nothing is sent anywhere.
 *
 * Also holds the small date/time helpers, because almost every other module
 * needs them and they belong next to the data they operate on.
 */

// Palette offered when colour-coding a class or a custom block.
export const COLORS = [
  '#8b7cf6', // violet
  '#4fd1c5', // teal
  '#f2a03d', // amber
  '#f0616d', // rose
  '#5aa9f7', // blue
  '#a3e635', // lime
  '#f472b6'  // pink
];

const STORAGE_KEY = 'scheduler.v2';

/* The shape of everything:
 *
 *  classes — recurring weekly. `days` holds day-of-week numbers where
 *            0 = Sunday … 6 = Saturday, matching JavaScript's getDay().
 *  blocks  — one-off entries tied to a single calendar date. These are what
 *            you create when you fill a gap in the timeline.
 *  tasks   — to-dos with a priority and a deadline. Not on the timeline;
 *            they are ranked separately by priority.js.
 */
export const state = {
  classes: [],
  blocks: [],
  tasks: [],
  settings: {
    dayStart: '07:00',   // top of the timeline
    dayEnd: '23:00',     // bottom of the timeline
    autoSleep: true      // generate sleep + get-ready blocks from the first class
  }
};

// ------------------------------------------------------------
// Persistence
// ------------------------------------------------------------

/* ------------------------------------------------------------
   Validation
   ------------------------------------------------------------
   Everything that enters the app from outside — a restored backup, or the
   contents of localStorage, which any script on this origin could have
   written — goes through here first.

   The rule is whitelist, never merge. Each record is rebuilt field by field
   from scratch and anything unrecognised is dropped on the floor.

   Two concrete attacks this closes:

   1. Prototype pollution. `Object.assign(target, JSON.parse(userJson))` copies
      using [[Set]], so a key of "__proto__" in the JSON runs the prototype
      setter and poisons *every* object in the app. Rebuilding by hand means an
      attacker-controlled key is never used as an assignment target at all.

   2. CSS injection. Colours are written into a custom property with
      style.setProperty('--blk', colour). An unvalidated string there can smuggle
      in arbitrary CSS values, so colours must match a strict hex pattern.
   ------------------------------------------------------------ */

const RE_HHMM  = /^([01]\d|2[0-3]):[0-5]\d$/;      // 00:00 – 23:59
const RE_DATE  = /^\d{4}-\d{2}-\d{2}$/;
const RE_HEX   = /^#[0-9a-fA-F]{6}$/;
const RE_ID    = /^[A-Za-z0-9_-]{1,64}$/;
const PRIORITIES = new Set(['low', 'medium', 'high']);

// Caps so a huge or hostile file cannot hang the UI by rendering forever.
const MAX_RECORDS = 1000;
const MAX_TEXT = 200;

const cleanText  = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : '');
const cleanColor = (v) => (typeof v === 'string' && RE_HEX.test(v) ? v : COLORS[0]);
const cleanId    = (v) => (typeof v === 'string' && RE_ID.test(v) ? v : id());
const cleanTime  = (v) => (typeof v === 'string' && RE_HHMM.test(v) ? v : null);

// A recurring class. Returns null — meaning "discard this record" — if the
// parts that the timeline maths depends on are not sound.
function cleanClass(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const title = cleanText(raw.title, 80);
  const start = cleanTime(raw.start);
  const end = cleanTime(raw.end);

  // A zero or negative length would draw a block of negative height.
  if (!title || !start || !end || toMinutes(end) <= toMinutes(start)) return null;

  const days = Array.isArray(raw.days)
    ? [...new Set(raw.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : [];
  if (!days.length) return null;

  return {
    id: cleanId(raw.id),
    title,
    location: cleanText(raw.location, 60),
    days,
    start,
    end,
    color: cleanColor(raw.color)
  };
}

// A one-off block on a specific date.
function cleanBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const title = cleanText(raw.title, 80);
  const start = cleanTime(raw.start);
  const end = cleanTime(raw.end);
  const date = typeof raw.date === 'string' && RE_DATE.test(raw.date) ? raw.date : null;

  if (!title || !start || !end || !date || toMinutes(end) <= toMinutes(start)) return null;

  return { id: cleanId(raw.id), title, date, start, end, color: cleanColor(raw.color) };
}

// A task. The deadline must be a date the engine can actually parse, or the
// ranking maths would produce NaN and the sort order would be meaningless.
function cleanTask(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const title = cleanText(raw.title, 120);
  if (!title) return null;

  const due = typeof raw.due === 'string' ? raw.due : '';
  if (Number.isNaN(new Date(due).getTime())) return null;

  return {
    id: cleanId(raw.id),
    title,
    priority: PRIORITIES.has(raw.priority) ? raw.priority : 'medium',
    due,
    done: raw.done === true
  };
}

// Only the two known settings, both validated, and never merged in bulk.
function cleanSettings(raw) {
  const fallback = { dayStart: '07:00', dayEnd: '23:00', autoSleep: true };
  if (!raw || typeof raw !== 'object') return fallback;

  // Default to on when absent, so older backups gain the feature rather than
  // silently having it switched off.
  const autoSleep = raw.autoSleep !== false;

  const dayStart = cleanTime(raw.dayStart) || fallback.dayStart;
  const dayEnd = cleanTime(raw.dayEnd) || fallback.dayEnd;

  if (toMinutes(dayEnd) <= toMinutes(dayStart)) return { ...fallback, autoSleep };
  return { dayStart, dayEnd, autoSleep };
}

/* Turn an untrusted parsed object into a safe, complete state object.
   Used for both localStorage reads and file imports. */
export function sanitize(parsed) {
  const list = (value, fn) =>
    (Array.isArray(value) ? value.slice(0, MAX_RECORDS) : [])
      .map(fn)
      .filter(Boolean);

  return {
    classes: list(parsed?.classes, cleanClass),
    blocks: list(parsed?.blocks, cleanBlock),
    tasks: list(parsed?.tasks, cleanTask),
    settings: cleanSettings(parsed?.settings)
  };
}

/* Replace the live state with a sanitised copy, field by field.
   `state` itself is never reassigned, because other modules hold a
   reference to it. */
export function applyState(clean) {
  state.classes = clean.classes;
  state.blocks = clean.blocks;
  state.tasks = clean.tasks;
  state.settings = clean.settings;
}

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    // Sanitised even though it is "our own" data: any script running on this
    // origin can write to localStorage, so it is not a trusted source.
    applyState(sanitize(JSON.parse(raw)));
  } catch (err) {
    console.error('Could not read saved data; starting fresh.', err);
  }
}

export function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Could not save.', err);
  }
}

// Short unique id for new records.
export function id() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
         (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
}

// ------------------------------------------------------------
// Date + time helpers
// ------------------------------------------------------------

/* Date -> 'YYYY-MM-DD' in LOCAL time.
   Deliberately not toISOString(), which converts to UTC and would file a
   late-evening item under the wrong day. */
export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 'YYYY-MM-DD' -> Date at local midnight.
export function fromISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Shift an ISO date string by a number of days.
export function addDays(iso, n) {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

// 'HH:MM' -> minutes since midnight. The timeline does all its maths in these.
export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// minutes since midnight -> 'HH:MM'
export function toHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 'HH:MM' -> '2:30 PM'
export function fmt12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

// Minutes since midnight, right now.
export function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

// 90 -> '1h 30m'. Used for gap sizes and time-remaining labels.
export function humanDuration(mins) {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h && rem) return `${h}h ${rem}m`;
  if (h) return `${h}h`;
  return `${rem}m`;
}

// ------------------------------------------------------------
// Reading the schedule for one particular day
// ------------------------------------------------------------

/* Everything actually scheduled on a date: recurring classes whose weekday
   matches, plus one-off blocks saved against that exact date. Sorted by start.
   This deliberately excludes the generated sleep/get-ready blocks, because
   those are derived FROM it — including them would be circular. */
export function scheduledEntriesForDate(isoDate) {
  const weekday = fromISODate(isoDate).getDay();

  const classes = state.classes
    .filter((c) => c.days.includes(weekday))
    .map((c) => ({ ...c, kind: 'class' }));

  const blocks = state.blocks
    .filter((b) => b.date === isoDate)
    .map((b) => ({ ...b, kind: 'block' }));

  return [...classes, ...blocks].sort(
    (a, b) => toMinutes(a.start) - toMinutes(b.start)
  );
}

// ------------------------------------------------------------
// Generated sleep and get-ready blocks
// ------------------------------------------------------------

/* These are computed, never stored. They follow two rules:
 *
 *   wake   = first class of the day  −  75 minutes
 *   bedtime = wake  −  7 hours
 *
 * Because they are derived, they update automatically when the schedule
 * changes and cannot drift out of sync with it. They are also not editable —
 * changing your first class is what changes them.
 */
export const AUTO = {
  readyMinutes: 75,    // awake this long before the first class
  sleepMinutes: 420,   // 7 hours
  sleepColor: '#8e93a6',
  readyColor: '#d9954f'
};

// Start time of the first real thing scheduled on a date, in minutes, or null.
function firstScheduledStart(isoDate) {
  const entries = scheduledEntriesForDate(isoDate);
  return entries.length ? toMinutes(entries[0].start) : null;
}

function autoEntry(type, isoDate, startMin, endMin) {
  const sleep = type === 'sleep';
  return {
    // Stable id so re-renders match the same element.
    id: `auto-${type}-${isoDate}-${startMin}`,
    title: sleep ? 'Sleep' : 'Get ready',
    location: '',
    start: toHHMM(startMin),
    end: toHHMM(endMin),
    color: sleep ? AUTO.sleepColor : AUTO.readyColor,
    kind: 'auto',
    auto: type          // 'sleep' | 'ready' — drives the character state
  };
}

/* The generated blocks that fall on this calendar day.
 *
 * Sleep usually starts after midnight (a 9:30 class means bed at 1:15 AM), so
 * it sits on the same day as the wake-up. But an early first class pushes
 * bedtime before midnight, in which case the sleep splits: the tail belongs to
 * the previous evening. Both halves are handled here so the block is never
 * silently dropped. */
export function autoEntriesForDate(isoDate) {
  if (!state.settings.autoSleep) return [];

  const out = [];

  // --- Today's own wake-up, and the sleep leading into it ---
  const firstToday = firstScheduledStart(isoDate);
  if (firstToday !== null) {
    const wake = firstToday - AUTO.readyMinutes;
    const bed = wake - AUTO.sleepMinutes;

    if (wake > 0) {
      out.push(autoEntry('ready', isoDate, wake, firstToday));
      // Clipped at midnight; anything earlier is on the previous evening.
      const segmentStart = Math.max(0, bed);
      if (wake > segmentStart) out.push(autoEntry('sleep', isoDate, segmentStart, wake));
    }
  }

  // --- The evening portion of the sleep that ends tomorrow morning ---
  const firstTomorrow = firstScheduledStart(addDays(isoDate, 1));
  if (firstTomorrow !== null) {
    const wakeTomorrow = firstTomorrow - AUTO.readyMinutes;
    const bedTomorrow = wakeTomorrow - AUTO.sleepMinutes;

    if (bedTomorrow < 0) {
      // e.g. bedtime of −30 means 23:30 the night before.
      out.push(autoEntry('sleep', isoDate, 1440 + bedTomorrow, 1439));
    }
  }

  return out;
}

/* Everything the timeline draws: real entries plus generated ones. */
export function entriesForDate(isoDate) {
  return [...scheduledEntriesForDate(isoDate), ...autoEntriesForDate(isoDate)]
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

/* The visible time range for a date.
 *
 * Starts from the configured day window, then stretches to fit anything that
 * falls outside it — otherwise a 1:15 AM bedtime would be computed, placed,
 * and then be invisible because the window starts at 08:00. Rounded out to
 * whole hours so the hour grid stays tidy. */
export function windowForDate(isoDate) {
  let start = toMinutes(state.settings.dayStart);
  let end = toMinutes(state.settings.dayEnd);

  for (const entry of entriesForDate(isoDate)) {
    start = Math.min(start, toMinutes(entry.start));
    end = Math.max(end, toMinutes(entry.end));
  }

  return {
    start: Math.floor(start / 60) * 60,
    end: Math.min(1440, Math.ceil(end / 60) * 60)
  };
}

/* Finds the stretches of empty time between entries, within the day window.
   These become the dashed, tappable gaps on the timeline.
   Gaps shorter than `minGap` are ignored — a 5-minute sliver is not worth
   drawing or filling. */
export function gapsForDate(isoDate, minGap = 20) {
  const entries = entriesForDate(isoDate);
  const { start: dayStart, end: dayEnd } = windowForDate(isoDate);

  const gaps = [];
  let cursor = dayStart;

  for (const entry of entries) {
    const start = toMinutes(entry.start);
    const end = toMinutes(entry.end);

    // Ignore anything sitting entirely outside the visible window.
    if (end <= dayStart || start >= dayEnd) continue;

    if (start - cursor >= minGap) {
      gaps.push({ start: toHHMM(cursor), end: toHHMM(start) });
    }
    // Math.max guards against overlapping entries pulling the cursor back.
    cursor = Math.max(cursor, end);
  }

  if (dayEnd - cursor >= minGap) {
    gaps.push({ start: toHHMM(cursor), end: toHHMM(dayEnd) });
  }

  return gaps;
}

// ------------------------------------------------------------
// Compact transfer encoding (for the phone QR code)
// ------------------------------------------------------------

/* A QR code holds roughly 2.9KB. The full backup JSON is bigger than that once
 * base64-encoded, so transfers use a compact form: positional arrays instead of
 * named fields, times as minutes, ids dropped and regenerated on the other side.
 *
 * The payload travels in the URL fragment, which browsers never send to a
 * server — so the schedule goes from screen to camera and nowhere else.
 */

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded) {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeForTransfer() {
  const payload = {
    v: 1,
    // [title, location, days, startMinutes, endMinutes, colour]
    c: state.classes.map((c) => [
      c.title, c.location || '', c.days.join(''),
      toMinutes(c.start), toMinutes(c.end), c.color
    ]),
    // [title, date, startMinutes, endMinutes, colour]
    b: state.blocks.map((b) => [b.title, b.date, toMinutes(b.start), toMinutes(b.end), b.color]),
    // [title, priority initial, due, done]
    t: state.tasks.map((t) => [t.title, t.priority[0], t.due, t.done ? 1 : 0]),
    s: [state.settings.dayStart, state.settings.dayEnd, state.settings.autoSleep ? 1 : 0]
  };
  return toBase64Url(JSON.stringify(payload));
}

/* Turn a transfer payload back into a normal backup object.
   The result still goes through sanitize() before it is applied — a compact
   encoding is not a reason to trust it any less. */
export function decodeTransfer(encoded) {
  const payload = JSON.parse(fromBase64Url(encoded));
  if (!payload || payload.v !== 1) throw new Error('unrecognised transfer format');

  const PRIORITY = { h: 'high', m: 'medium', l: 'low' };

  return {
    classes: (payload.c || []).map(([title, location, days, start, end, color]) => ({
      id: id(), title, location,
      days: String(days).split('').map(Number),
      start: toHHMM(start), end: toHHMM(end), color
    })),
    blocks: (payload.b || []).map(([title, date, start, end, color]) => ({
      id: id(), title, date, start: toHHMM(start), end: toHHMM(end), color
    })),
    tasks: (payload.t || []).map(([title, priority, due, done]) => ({
      id: id(), title, priority: PRIORITY[priority] || 'medium', due, done: !!done
    })),
    settings: {
      dayStart: payload.s?.[0] || '07:00',
      dayEnd: payload.s?.[1] || '23:00',
      autoSleep: payload.s?.[2] !== 0
    }
  };
}
