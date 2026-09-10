/* timeline.js — draws the day view and keeps it moving.
 *
 * Two jobs:
 *   1. renderDay()  — lay out the hour grid, the scheduled blocks, and the
 *                     dashed gaps, once, whenever the day or the data changes.
 *   2. tick()       — called every second. Moves the "now" line, updates the
 *                     character's state, and refreshes the progress bars.
 *
 * Everything is positioned by converting a time into minutes-since-midnight
 * and multiplying by PX_PER_MIN. That one conversion is the whole layout.
 */

import {
  state, entriesForDate, scheduledEntriesForDate, gapsForDate, windowForDate,
  continuationForDate, addDays, fromISODate,
  toMinutes, fmt12, nowMinutes, toISODate, humanDuration
} from './store.js';

// How tall one minute is on screen. 1.1px/min makes a 16-hour day ~1050px,
// which scrolls comfortably on a phone without feeling cramped.
const PX_PER_MIN = 1.1;

const el = {
  timeline:   document.getElementById('timeline'),
  hourGrid:   document.getElementById('hour-grid'),
  blocks:     document.getElementById('blocks-layer'),
  nowLine:    document.getElementById('now-line'),
  nowTime:    document.getElementById('now-time'),
  stage:      document.getElementById('stage'),
  status:     document.getElementById('stage-status'),
  detail:     document.getElementById('stage-detail'),
  blockProg:  document.getElementById('block-progress'),
  blockFill:  document.getElementById('block-progress-fill'),
  dayFill:    document.getElementById('day-progress-fill'),
  dayLeft:    document.getElementById('day-remaining'),
  clock:      document.getElementById('live-clock'),

  // The three dials
  ringDay:     document.getElementById('ring-day'),
  ringClasses: document.getElementById('ring-classes'),
  ringNext:    document.getElementById('ring-next'),
  wDay:        document.getElementById('w-day'),
  wClasses:    document.getElementById('w-classes'),
  wNext:       document.getElementById('w-next'),

  // 15-minute warning
  panic:       document.getElementById('panic'),
  panicTitle:  document.getElementById('panic-title'),
  panicDetail: document.getElementById('panic-detail'),
  panicClose:  document.getElementById('panic-close')
};

/* ------------------------------------------------------------
   The 15-minute warning
   ------------------------------------------------------------
   Shows when a real class is 15 minutes or less away, and gets visibly more
   frantic as the countdown runs down. It disappears on its own the moment the
   class starts. Dismissing it hides that specific class only — the next one
   still warns you.

   Note this can only appear while the app is open. A warning that reaches you
   with the app closed needs push notifications and a server. */
const PANIC_WINDOW = 15;      // minutes before a class
let dismissedPanicId = null;

el.panicClose.addEventListener('click', () => {
  dismissedPanicId = el.panic.dataset.classId || null;
  el.panic.hidden = true;
});

function updatePanic(isoDate, mins, isToday) {
  if (!isToday) { el.panic.hidden = true; return; }

  // Nearest real class that has not started yet. Generated sleep and
  // get-ready blocks are not something to panic about.
  const upcoming = scheduledEntriesForDate(isoDate)
    .filter((e) => e.kind === 'class' && toMinutes(e.start) > mins)
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))[0];

  if (!upcoming) { el.panic.hidden = true; return; }

  const minutesAway = toMinutes(upcoming.start) - mins;

  if (minutesAway > PANIC_WINDOW) {
    // Out of range — clear any old dismissal so the next class warns properly.
    if (dismissedPanicId && dismissedPanicId !== upcoming.id) dismissedPanicId = null;
    el.panic.hidden = true;
    return;
  }

  if (dismissedPanicId === upcoming.id) { el.panic.hidden = true; return; }

  // 0 at fifteen minutes out, 1 at the moment it starts. Drives how hard the
  // little figure shakes.
  const intensity = Math.min(1, Math.max(0, (PANIC_WINDOW - minutesAway) / PANIC_WINDOW));

  el.panic.dataset.classId = upcoming.id;
  el.panic.style.setProperty('--panic', intensity.toFixed(2));
  el.panic.classList.toggle('is-urgent', minutesAway <= 5);
  el.panicTitle.textContent = upcoming.title;

  const rounded = Math.max(1, Math.ceil(minutesAway));
  el.panicDetail.textContent =
    `Starts in ${rounded} min` + (upcoming.location ? ` · ${upcoming.location}` : '');

  el.panic.hidden = false;
}

// The rings have a circumference of ~100, so the dash offset is 100 - percent.
function setRing(circle, percent) {
  circle.style.strokeDashoffset = String(100 - Math.max(0, Math.min(100, percent)));
}

/* The window currently being drawn. Set at the top of every renderDay() and
   tick(), because it varies by date — a day with an early class has an earlier
   bedtime and therefore an earlier window start. */
let win = { start: 0, end: 1440 };
let continuation = 0;   // minutes of the next day drawn below midnight

// Convert a time to a vertical offset in pixels from the top of the timeline.
function yFor(minutes) {
  return (minutes - win.start) * PX_PER_MIN;
}

/* ------------------------------------------------------------
   1. Full redraw
   ------------------------------------------------------------ */

export function renderDay(isoDate, onGapTap, onBlockTap) {
  win = windowForDate();
  const dayStart = win.start;
  const dayEnd = win.end;

  // How far past midnight we keep drawing, so the night reads continuously.
  continuation = continuationForDate(isoDate);

  // Container height covers the full day plus the continuation.
  el.timeline.style.setProperty(
    '--tl-height', `${(dayEnd - dayStart + continuation) * PX_PER_MIN}px`
  );

  renderHourGrid(dayStart, dayEnd + continuation);
  renderBlocks(isoDate, onBlockTap);
  renderContinuation(isoDate, onBlockTap);
  renderGaps(isoDate, onGapTap);

  tick(isoDate);
}

/* Everything from the next day that falls inside the continuation, drawn
   below midnight at an offset of a full day. This is what makes a 2:45 AM
   bedtime visible from the evening it actually belongs to. */
function renderContinuation(isoDate, onBlockTap) {
  if (continuation <= 0) return;

  const nextDay = addDays(isoDate, 1);

  // A labelled divider so it is obvious where the day rolls over.
  const divider = document.createElement('div');
  divider.className = 'day-divider';
  divider.style.top = `${yFor(1440)}px`;
  const label = document.createElement('span');
  label.textContent = fromISODate(nextDay)
    .toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  divider.appendChild(label);
  el.blocks.appendChild(divider);

  for (const entry of entriesForDate(nextDay)) {
    const start = toMinutes(entry.start);
    if (start >= continuation) continue;         // beyond what we are showing

    const end = Math.min(toMinutes(entry.end), continuation);
    const height = (end - start) * PX_PER_MIN;
    if (height <= 0) continue;

    const div = document.createElement('div');
    div.className = 'block is-next-day';
    div.dataset.id = entry.id;
    div.dataset.kind = entry.kind;
    div.style.top = `${yFor(1440 + start)}px`;
    div.style.height = `${Math.max(height, 22)}px`;
    div.style.setProperty('--blk', entry.color || 'var(--accent)');

    const title = document.createElement('div');
    title.className = 'block-title';
    title.textContent = entry.title;
    div.appendChild(title);

    if (height > 40) {
      const meta = document.createElement('div');
      meta.className = 'block-meta';
      meta.textContent = `${fmt12(entry.start)} – ${fmt12(entry.end)}`;
      div.appendChild(meta);
    }

    if (entry.auto === 'sleep' && height > 120) {
      div.classList.add('is-sleep');
      div.appendChild(buildSleeper());
    }

    div.addEventListener('click', () => onBlockTap(entry));
    el.blocks.appendChild(div);
  }
}

// One faint rule and label per hour.
function renderHourGrid(dayStart, dayEnd) {
  el.hourGrid.innerHTML = '';

  // Start at the first whole hour at or after the day start.
  const firstHour = Math.ceil(dayStart / 60);
  const lastHour = Math.floor(dayEnd / 60);

  for (let h = firstHour; h <= lastHour; h++) {
    const row = document.createElement('div');
    row.className = 'hour-row';
    row.style.top = `${yFor(h * 60)}px`;

    const label = document.createElement('span');
    label.className = 'hour-label';
    // Hours past 24 belong to the next day, so wrap them back to 0-23.
    const hourOfDay = h % 24;
    const period = hourOfDay >= 12 ? 'PM' : 'AM';
    const hour12 = hourOfDay % 12 === 0 ? 12 : hourOfDay % 12;
    label.textContent = `${hour12} ${period}`;
    if (h >= 24) label.classList.add('next-day-label');

    const rule = document.createElement('span');
    rule.className = 'hour-rule';

    row.append(label, rule);
    el.hourGrid.appendChild(row);
  }
}

// Classes and custom blocks, positioned and sized by their start/end times.
function renderBlocks(isoDate, onBlockTap) {
  el.blocks.innerHTML = '';

  const dayStart = win.start;
  const dayEnd = win.end;
  const entries = entriesForDate(isoDate);

  entries.forEach((entry, index) => {
    const start = toMinutes(entry.start);
    const end = toMinutes(entry.end);

    // Skip anything wholly outside the visible window.
    if (end <= dayStart || start >= dayEnd) return;

    // Clamp so a block that runs past the window still draws neatly.
    const top = yFor(Math.max(start, dayStart));
    const height = (Math.min(end, dayEnd) - Math.max(start, dayStart)) * PX_PER_MIN;

    const div = document.createElement('div');
    div.className = 'block';
    div.dataset.id = entry.id;
    div.dataset.kind = entry.kind;
    div.style.top = `${top}px`;
    div.style.height = `${Math.max(height, 22)}px`;   // keep short blocks tappable
    div.style.setProperty('--blk', entry.color || 'var(--accent)');
    // Stagger the entrance animation slightly so blocks cascade in.
    div.style.animationDelay = `${Math.min(index * 40, 300)}ms`;

    const title = document.createElement('div');
    title.className = 'block-title';
    title.textContent = entry.title;

    div.appendChild(title);

    /* Sleep is the one generated block that should be unmissable rather than
       quiet — it is the anchor the rest of the day hangs off. Given a 7-hour
       block is several hundred pixels tall, there is room for a proper
       sleeping figure inside it. */
    if (entry.auto === 'sleep' && height > 120) {
      div.classList.add('is-sleep');
      div.appendChild(buildSleeper());
    }

    // Only show the time range if the block is tall enough to fit it.
    if (height > 40) {
      const meta = document.createElement('div');
      meta.className = 'block-meta';
      meta.textContent = `${fmt12(entry.start)} – ${fmt12(entry.end)}` +
                         (entry.location ? ` · ${entry.location}` : '');
      div.appendChild(meta);
    }

    div.addEventListener('click', () => onBlockTap(entry));
    el.blocks.appendChild(div);
  });
}

/* The sleeping figure that sits inside the Sleep block: a person under a
   duvet, breathing, with Zzz drifting up. Built in code rather than written
   into index.html because it is created per-day alongside the block. */
function buildSleeper() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'sleeper');
  svg.setAttribute('viewBox', '0 0 200 90');
  svg.setAttribute('aria-hidden', 'true');

  svg.innerHTML = `
    <ellipse class="sleeper-shadow" cx="100" cy="79" rx="66" ry="5" />

    <!-- pillow -->
    <rect class="sleeper-pillow" x="40" y="46" width="40" height="22" rx="9" />

    <g class="sleeper-body">
      <!-- head -->
      <circle class="sleeper-head" cx="66" cy="50" r="15" />
      <!-- hair -->
      <path class="sleeper-hair" d="M52 46 Q54 34 66 34 Q78 34 80 46 Q73 39 66 40 Q58 40 52 46 Z" />
      <!-- closed eyes, drawn as gentle curves -->
      <path class="sleeper-eye" d="M59 50 q3 3 6 0" />
      <path class="sleeper-eye" d="M69 50 q3 3 6 0" />
      <!-- duvet, rising and falling with the breath -->
      <path class="sleeper-duvet" d="M78 68 Q78 50 104 50 L150 50 Q166 50 166 68 Z" />
      <path class="sleeper-duvet-edge" d="M78 60 Q120 54 166 60" />
    </g>

    <!-- bed base -->
    <rect class="sleeper-bed" x="36" y="68" width="134" height="7" rx="3.5" />

    <g class="sleeper-zzz">
      <text x="92" y="30" class="sleeper-z z1">z</text>
      <text x="106" y="20" class="sleeper-z z2">z</text>
      <text x="120" y="11" class="sleeper-z z3">z</text>
    </g>
  `;

  return svg;
}

// The empty stretches, drawn as dashed outlines you can tap to fill.
function renderGaps(isoDate, onGapTap) {
  const gaps = gapsForDate(isoDate);

  for (const gap of gaps) {
    const start = toMinutes(gap.start);
    const end = toMinutes(gap.end);
    const height = (end - start) * PX_PER_MIN;

    const div = document.createElement('div');
    div.className = 'gap';
    div.style.top = `${yFor(start)}px`;
    div.style.height = `${height}px`;

    // Only label gaps with room for text; small ones stay clean and empty.
    if (height > 34) {
      const span = document.createElement('span');
      span.textContent = `+ ${humanDuration(end - start)} free`;
      div.appendChild(span);
    }

    div.addEventListener('click', () => onGapTap(gap));
    el.blocks.appendChild(div);
  }
}

/* Scroll the page so the current time sits about a third of the way down.
   A full day is roughly 1600px tall, so without this you open the app looking
   at three in the morning. Only meaningful on today. */
export function scrollToNow(isoDate) {
  if (isoDate !== toISODate(new Date())) return;

  const y = el.timeline.getBoundingClientRect().top + window.scrollY
            + yFor(nowMinutes()) - window.innerHeight * 0.33;

  window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}

/* ------------------------------------------------------------
   2. The per-second update
   ------------------------------------------------------------ */

export function tick(isoDate) {
  const now = new Date();
  const mins = nowMinutes();
  const isToday = isoDate === toISODate(now);

  win = windowForDate();
  const dayStart = win.start;
  const dayEnd = win.end;

  // Live clock in the header, always the real current time.
  el.clock.textContent = now.toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit'
  });

  // How far through the day window we are.
  const dayPct = Math.min(100, Math.max(0, ((mins - dayStart) / (dayEnd - dayStart)) * 100));
  el.dayFill.style.width = `${dayPct}%`;
  el.dayLeft.textContent = mins < dayEnd && mins > dayStart
    ? `${humanDuration(dayEnd - mins)} left`
    : '';

  // The now-line only makes sense on today, inside the window.
  const showLine = isToday && mins >= dayStart && mins <= dayEnd;
  el.nowLine.hidden = !showLine;
  if (showLine) {
    el.nowLine.style.top = `${yFor(mins)}px`;
    el.nowTime.textContent = now.toLocaleTimeString(undefined, {
      hour: 'numeric', minute: '2-digit'
    });
  }

  updateStage(isoDate, mins, isToday);
  markCurrentBlock(isoDate, mins, isToday);
  updateWidgets(isoDate, mins, isToday);
  updatePanic(isoDate, mins, isToday);
}

/* The three dials under the character.
     Day     — how far through the day window you are
     Classes — how many of today's classes are finished
     Next    — countdown to whatever is coming up
   On a day that is not today, live values would be meaningless, so they show
   that day's totals instead of a fake countdown. */
function updateWidgets(isoDate, mins, isToday) {
  const entries = entriesForDate(isoDate);
  const dayStart = win.start;
  const dayEnd = win.end;

  // --- Day ---
  const dayPct = isToday
    ? Math.min(100, Math.max(0, ((mins - dayStart) / (dayEnd - dayStart)) * 100))
    : 0;
  setRing(el.ringDay, dayPct);
  el.wDay.textContent = isToday ? `${Math.round(dayPct)}%` : '—';

  // --- Classes done --- (real classes only; generated sleep/ready blocks
  // are not things you "complete")
  const realClasses = scheduledEntriesForDate(isoDate).filter((e) => e.kind === 'class');
  const total = realClasses.length;
  const done = isToday ? realClasses.filter((e) => mins >= toMinutes(e.end)).length : 0;
  setRing(el.ringClasses, total ? (done / total) * 100 : 0);
  el.wClasses.textContent = `${done}/${total}`;

  // --- Next ---
  const current = entries.find((e) => mins >= toMinutes(e.start) && mins < toMinutes(e.end));
  const next = entries.find((e) => toMinutes(e.start) > mins);

  if (isToday && current) {
    // Mid-class: the ring tracks progress through it.
    const start = toMinutes(current.start);
    const end = toMinutes(current.end);
    setRing(el.ringNext, ((mins - start) / (end - start)) * 100);
    el.wNext.textContent = humanDuration(end - mins);
  } else if (isToday && next) {
    // Waiting: the ring fills as the next class approaches, over a 3-hour
    // runway, so it is nearly empty when something is hours away and full
    // just before it starts.
    const until = toMinutes(next.start) - mins;
    setRing(el.ringNext, Math.max(0, 100 - (until / 180) * 100));
    el.wNext.textContent = humanDuration(until);
  } else if (!isToday && entries.length) {
    setRing(el.ringNext, 0);
    el.wNext.textContent = fmt12(entries[0].start);
  } else {
    setRing(el.ringNext, 0);
    el.wNext.textContent = '—';
  }
}

/* Decide what the little character is doing, and what the status text says. */
function updateStage(isoDate, mins, isToday) {
  const entries = entriesForDate(isoDate);
  const dayStart = win.start;
  const dayEnd = win.end;

  // Looking at another day: describe it rather than pretending it is live.
  if (!isToday) {
    setStage('state-busy',
      `${entries.length} ${entries.length === 1 ? 'thing' : 'things'} scheduled`,
      entries.length ? `Starting ${fmt12(entries[0].start)}` : 'Nothing planned yet');
    el.blockProg.hidden = true;
    return;
  }

  const current = entries.find(
    (e) => mins >= toMinutes(e.start) && mins < toMinutes(e.end)
  );

  if (current) {
    const start = toMinutes(current.start);
    const end = toMinutes(current.end);
    const pct = ((mins - start) / (end - start)) * 100;

    let stateClass = 'state-busy';
    if (current.kind === 'class') stateClass = 'state-class';
    else if (current.auto === 'sleep') stateClass = 'state-night';
    else if (current.auto === 'ready') stateClass = 'state-ready';

    const detail = current.auto === 'sleep'
      ? `Until ${fmt12(current.end)} · ${humanDuration(end - mins)} more`
      : `${humanDuration(end - mins)} left · ends ${fmt12(current.end)}`;

    setStage(stateClass, current.title, detail);

    el.blockProg.hidden = false;
    el.blockFill.style.width = `${pct}%`;
    return;
  }

  el.blockProg.hidden = true;

  // Outside the day window entirely — asleep.
  if (mins < dayStart || mins > dayEnd) {
    setStage('state-night', 'Off the clock', 'Nothing scheduled right now');
    return;
  }

  // Free: say what is coming, and how long the break is.
  const next = entries.find((e) => toMinutes(e.start) > mins);
  setStage(
    'state-free',
    'Free time',
    next
      ? `${humanDuration(toMinutes(next.start) - mins)} until ${next.title}`
      : 'Nothing else scheduled today'
  );
}

// Swap the state class on the stage, which is what drives the CSS animations.
function setStage(stateClass, status, detail) {
  el.stage.className = `stage ${stateClass}`;
  el.status.textContent = status;
  el.detail.textContent = detail;
}

// Highlight the block happening now; fade the ones already finished.
function markCurrentBlock(isoDate, mins, isToday) {
  const entries = entriesForDate(isoDate);

  for (const div of el.blocks.querySelectorAll('.block')) {
    const entry = entries.find((e) => e.id === div.dataset.id);
    if (!entry) continue;

    const start = toMinutes(entry.start);
    const end = toMinutes(entry.end);

    div.classList.toggle('is-now', isToday && mins >= start && mins < end);
    div.classList.toggle('is-past', isToday && mins >= end);
  }
}
