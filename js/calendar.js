/* calendar.js — the month grid and attendance marking.
 *
 * Three parts, top to bottom:
 *   1. A month grid, each day showing how its classes were marked
 *   2. A panel for the selected day, where you mark present or absent
 *   3. Per-course totals, with the dates you missed listed so "catch up later"
 *      has something concrete attached to it
 */

import {
  state, scheduledEntriesForDate, markAttendance, attendanceFor,
  attendanceStats, monthSummary, toISODate, fromISODate, fmt12
} from './store.js';

const el = {
  grid:      document.getElementById('cal-grid'),
  monthName: document.getElementById('cal-month'),
  prev:      document.getElementById('cal-prev'),
  next:      document.getElementById('cal-next'),
  dayTitle:  document.getElementById('cal-day-title'),
  dayList:   document.getElementById('cal-day-list'),
  dayEmpty:  document.getElementById('cal-day-empty'),
  stats:     document.getElementById('cal-stats'),
  statsEmpty:document.getElementById('cal-stats-empty')
};

// Which month is on screen, and which day is selected within it.
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();
let selected = toISODate(new Date());

let onChanged = () => {};

export function initCalendar(changedCallback) {
  onChanged = changedCallback || (() => {});

  el.prev.addEventListener('click', () => shiftMonth(-1));
  el.next.addEventListener('click', () => shiftMonth(1));
}

function shiftMonth(delta) {
  viewMonth += delta;
  if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
  if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
  renderCalendar();
}

/* Jump the calendar to a specific date — used when you open the tab, so it
   lands on the day you are actually looking at rather than always today. */
export function focusCalendarOn(isoDate) {
  const date = fromISODate(isoDate);
  viewYear = date.getFullYear();
  viewMonth = date.getMonth();
  selected = isoDate;
  renderCalendar();
}

export function renderCalendar() {
  renderGrid();
  renderDayPanel();
  renderStats();
}

// ------------------------------------------------------------
// 1. Month grid
// ------------------------------------------------------------

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function renderGrid() {
  el.monthName.textContent = new Date(viewYear, viewMonth, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  el.grid.innerHTML = '';

  // Weekday header row.
  WEEKDAY_INITIALS.forEach((initial, i) => {
    const head = document.createElement('div');
    head.className = 'cal-weekday';
    head.textContent = initial;
    head.setAttribute('aria-label', ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][i]);
    el.grid.appendChild(head);
  });

  const summary = monthSummary(viewYear, viewMonth);
  const today = toISODate(new Date());

  // Blank cells so the 1st lands under the right weekday.
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  for (let i = 0; i < firstWeekday; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-cell is-blank';
    el.grid.appendChild(blank);
  }

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = toISODate(new Date(viewYear, viewMonth, day));
    const info = summary.get(iso);

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-cell';
    cell.classList.toggle('is-today', iso === today);
    cell.classList.toggle('is-selected', iso === selected);
    cell.classList.toggle('has-classes', !!info);

    // A day with classes you never marked, that has already passed.
    if (info?.unmarked > 0) cell.classList.add('is-unmarked');

    const number = document.createElement('span');
    number.className = 'cal-num';
    number.textContent = day;
    cell.appendChild(number);

    /* One dot per class, coloured by how it was marked. At a glance the month
       reads as a pattern: solid green weeks, and the days you slipped. */
    if (info) {
      const dots = document.createElement('span');
      dots.className = 'cal-dots';

      for (let i = 0; i < info.present; i++) dots.appendChild(dot('present'));
      for (let i = 0; i < info.absent; i++) dots.appendChild(dot('absent'));
      for (let i = 0; i < info.total - info.present - info.absent; i++) dots.appendChild(dot('none'));

      cell.appendChild(dots);
    }

    cell.addEventListener('click', () => {
      selected = iso;
      renderCalendar();
    });

    el.grid.appendChild(cell);
  }
}

function dot(kind) {
  const span = document.createElement('span');
  span.className = `cal-dot is-${kind}`;
  return span;
}

// ------------------------------------------------------------
// 2. The selected day
// ------------------------------------------------------------

function renderDayPanel() {
  const date = fromISODate(selected);
  el.dayTitle.textContent = date.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const classes = scheduledEntriesForDate(selected).filter((e) => e.kind === 'class');

  el.dayList.innerHTML = '';
  el.dayEmpty.hidden = classes.length > 0;

  for (const cls of classes) {
    const row = document.createElement('div');
    row.className = 'cal-class';
    row.style.setProperty('--blk', cls.color);

    const main = document.createElement('div');
    main.className = 'cal-class-main';

    const name = document.createElement('div');
    name.className = 'cal-class-name';
    name.textContent = cls.title;

    const when = document.createElement('div');
    when.className = 'cal-class-when';
    when.textContent = `${fmt12(cls.start)} – ${fmt12(cls.end)}` +
                       (cls.location ? ` · ${cls.location}` : '');

    main.append(name, when);

    const marks = document.createElement('div');
    marks.className = 'cal-marks';
    marks.append(
      markButton(cls, 'present', 'Present'),
      markButton(cls, 'absent', 'Absent')
    );

    row.append(main, marks);
    el.dayList.appendChild(row);
  }
}

function markButton(cls, mark, label) {
  const current = attendanceFor(selected, cls.id);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `mark-btn is-${mark}` + (current === mark ? ' is-on' : '');
  button.textContent = label;
  button.setAttribute('aria-pressed', String(current === mark));

  button.addEventListener('click', () => {
    markAttendance(selected, cls.id, mark);
    renderCalendar();
    onChanged();
  });

  return button;
}

// ------------------------------------------------------------
// 3. Per-course totals and what to catch up on
// ------------------------------------------------------------

function renderStats() {
  const rows = attendanceStats().filter((r) => r.present + r.absent > 0);

  el.stats.innerHTML = '';
  el.statsEmpty.hidden = rows.length > 0;

  for (const row of rows) {
    const total = row.present + row.absent;
    const rate = Math.round((row.present / total) * 100);

    const item = document.createElement('div');
    item.className = 'stat-row';
    item.style.setProperty('--blk', row.cls.color);

    const head = document.createElement('div');
    head.className = 'stat-head';

    const name = document.createElement('span');
    name.className = 'stat-name';
    name.textContent = row.cls.title;

    const figure = document.createElement('span');
    figure.className = 'stat-figure';
    figure.textContent = `${rate}%`;
    // Below 80% is the point where most attendance policies start to bite.
    if (rate < 80) figure.classList.add('is-low');

    head.append(name, figure);

    const bar = document.createElement('div');
    bar.className = 'stat-bar';
    const fill = document.createElement('div');
    fill.className = 'stat-fill';
    fill.style.width = `${rate}%`;
    bar.appendChild(fill);

    const detail = document.createElement('div');
    detail.className = 'stat-detail';
    detail.textContent = row.absent
      ? `Missed ${row.absent} of ${total} — ${row.missedDates.slice(0, 4).map(shortDate).join(', ')}` +
        (row.missedDates.length > 4 ? ` +${row.missedDates.length - 4} more` : '')
      : `Attended all ${total}`;

    item.append(head, bar, detail);
    el.stats.appendChild(item);
  }
}

function shortDate(iso) {
  return fromISODate(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
