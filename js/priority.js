/* priority.js — the ranking algorithm.
 *
 * The question this answers: given a pile of tasks with different priorities
 * and different deadlines, which one should be waved in front of you first?
 *
 * The rule in one sentence: urgency is driven by the deadline, priority
 * multiplies it. A low-priority task due in an hour will overtake a
 * high-priority task due next week — which is what you actually want, since
 * the far-off one can wait and the near one cannot.
 *
 * Every score comes with a plain-English `reason`, so the ordering is never
 * mysterious. If the sort ever looks wrong, the reason string says why.
 */

// How much each priority level multiplies urgency by.
const WEIGHT = { high: 3, medium: 2, low: 1 };

/* Urgency from the deadline alone, before priority is applied.
 *
 * The curve is 100 / (1 + hours), which gives:
 *     due now    -> 100
 *     in 1 hour  ->  50
 *     in 3 hours ->  25
 *     in 12 hours->   8
 *     in 3 days  ->   1.4
 *
 * The steep early drop is deliberate: the difference between "due in 1 hour"
 * and "due in 3 hours" matters far more than between "in 5 days" and "in 7".
 */
function urgencyFromHours(hours) {
  return 100 / (1 + Math.max(0, hours));
}

/* Score one task. Higher = more deserving of your attention right now. */
export function scoreTask(task, now = new Date()) {
  const due = new Date(task.due);
  const msUntil = due.getTime() - now.getTime();
  const hoursUntil = msUntil / 3_600_000;
  const weight = WEIGHT[task.priority] ?? 1;

  // Completed tasks sink to the bottom and stay there.
  if (task.done) {
    return { score: -1, bucket: 'Done', reason: 'Completed' };
  }

  // Overdue beats everything. Within the overdue group, higher priority and
  // longer overdue float up, but the base is high enough that no upcoming
  // task can ever outrank something already late.
  if (msUntil < 0) {
    const hoursLate = Math.abs(hoursUntil);
    return {
      score: 1000 + weight * 10 + Math.min(hoursLate, 72),
      bucket: 'Overdue',
      reason: `Overdue by ${describeGap(hoursLate)}`
    };
  }

  const score = urgencyFromHours(hoursUntil) * weight;

  // Buckets are what the user actually sees as headings. They are based on the
  // score rather than the raw deadline, so a high-priority item due tomorrow
  // can sit in "Do next" above a low-priority item due sooner.
  let bucket;
  if (score >= 50) bucket = 'Do next';
  else if (hoursUntil <= 24) bucket = 'Next 24 hours';
  else if (hoursUntil <= 168) bucket = 'This week';
  else bucket = 'Later';

  const label = task.priority[0].toUpperCase() + task.priority.slice(1);
  return { score, bucket, reason: `${label} · due in ${describeGap(hoursUntil)}` };
}

// 2.5 -> '2h', 0.4 -> '24m', 50 -> '2d'
function describeGap(hours) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/* Sort every task, best-first, and attach its score info.
   Completed tasks are pushed to the end regardless of deadline. */
export function rankTasks(tasks, now = new Date()) {
  return tasks
    .map((task) => ({ ...task, ranking: scoreTask(task, now) }))
    .sort((a, b) => b.ranking.score - a.ranking.score);
}

/* Group ranked tasks under their bucket headings, preserving rank order
   within each group. Returns [{ bucket, items }] in a fixed, sensible
   heading order rather than whatever order the buckets happened to appear. */
export function groupTasks(ranked) {
  const ORDER = ['Overdue', 'Do next', 'Next 24 hours', 'This week', 'Later', 'Done'];
  const groups = new Map();

  for (const task of ranked) {
    const key = task.ranking.bucket;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }

  return ORDER
    .filter((bucket) => groups.has(bucket))
    .map((bucket) => ({ bucket, items: groups.get(bucket) }));
}

/* How many tasks are urgent enough to warrant the red badge on the tab bar:
   anything overdue or in the "Do next" group. */
export function urgentCount(ranked) {
  return ranked.filter(
    (t) => !t.done && (t.ranking.bucket === 'Overdue' || t.ranking.bucket === 'Do next')
  ).length;
}
