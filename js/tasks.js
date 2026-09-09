/* tasks.js — draws the task list.
 *
 * The ordering decisions all live in priority.js. This file only turns the
 * already-ranked list into DOM, grouped under its bucket headings.
 */

import { state, fmt12, fromISODate } from './store.js';
import { rankTasks, groupTasks, urgentCount } from './priority.js';

const el = {
  groups: document.getElementById('task-groups'),
  empty:  document.getElementById('tasks-empty'),
  badge:  document.getElementById('tab-badge')
};

// Priority name -> the CSS colour variable used for that task's accents.
const PRIORITY_COLOR = {
  high:   'var(--hi)',
  medium: 'var(--med)',
  low:    'var(--low)'
};

export function renderTasks(onToggle, onDelete, highlightId = null) {
  const ranked = rankTasks(state.tasks);
  const groups = groupTasks(ranked);

  el.groups.innerHTML = '';
  el.empty.hidden = state.tasks.length > 0;

  for (const group of groups) {
    const heading = document.createElement('h2');
    heading.className = 'group-head';
    heading.textContent = group.bucket;
    el.groups.appendChild(heading);

    group.items.forEach((task, index) => {
      el.groups.appendChild(buildTaskRow(task, index, onToggle, onDelete, highlightId));
    });
  }

  updateBadge(ranked);
}

function buildTaskRow(task, index, onToggle, onDelete, highlightId) {
  const row = document.createElement('div');
  // `just-changed` is only ever on the row the user actually tapped, so the
  // celebration animation does not re-fire for every done task on re-render.
  row.className = 'task' + (task.done ? ' done' : '') +
                  (task.id === highlightId ? ' just-changed' : '');
  row.style.setProperty('--pc', PRIORITY_COLOR[task.priority]);
  // Stagger so the list cascades in rather than appearing all at once.
  row.style.animationDelay = `${Math.min(index * 35, 250)}ms`;

  // Round tick button
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check';
  check.textContent = task.done ? '✓' : '';
  check.setAttribute('aria-label', task.done ? 'Mark as not done' : 'Mark as done');
  check.addEventListener('click', () => onToggle(task.id));

  const main = document.createElement('div');
  main.className = 'task-main';

  const title = document.createElement('div');
  title.className = 'task-title';
  // textContent, never innerHTML: typed text must not be treated as markup.
  title.textContent = task.title;

  const meta = document.createElement('div');
  meta.className = 'task-meta';

  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.textContent = task.priority;

  const when = document.createElement('span');
  const due = new Date(task.due);
  when.textContent = `${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ` +
                     `${fmt12(`${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`)}`;

  // The algorithm's own explanation of why this sits where it does.
  const reason = document.createElement('span');
  reason.className = task.ranking.bucket === 'Overdue' ? 'overdue' : '';
  reason.textContent = task.ranking.reason;

  meta.append(chip, when, reason);
  main.append(title, meta);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'task-del';
  del.textContent = '✕';
  del.setAttribute('aria-label', 'Delete task');
  del.addEventListener('click', () => onDelete(task.id));

  row.append(check, main, del);
  return row;
}

// Red count on the Tasks tab: overdue + "do next" items.
function updateBadge(ranked) {
  const count = urgentCount(ranked);
  el.badge.hidden = count === 0;
  el.badge.textContent = count;
}
