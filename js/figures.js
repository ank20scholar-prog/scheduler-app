/* figures.js — the little animated people that live inside timeline blocks.
 *
 * Every figure is an inline SVG built here and animated entirely in CSS, in
 * the same flat geometric style as the character on the Today tab. Nothing is
 * drawn realistically; what makes them read as real is the *motion* — a chest
 * that rises, a brush that scrubs, a pendulum that swings.
 *
 * Three families:
 *   buildSleeper()             the Sleep block
 *   buildBrusher()             the Get ready block
 *   buildSubjectFigure(code)   class blocks, matched to the subject
 */

// ============================================================
// Which subject a course code belongs to
// ============================================================

/* Departments map to a figure. The four-letter prefix of a UMD course code IS
 * the department id — a CHEM course is Chemistry, a PHYS course is Physics — so
 * case needs no lookup at all. Anything unrecognised is resolved against
 * umd.io once and cached; see resolveSubject() below. */
const DEPT_FIGURES = {
  // Physical sciences
  CHEM: 'chemistry', BCHM: 'chemistry',
  PHYS: 'physics',   ASTR: 'physics',   ENES: 'physics',
  // Life sciences
  BSCI: 'biology',   BIOL: 'biology',   BIOM: 'biology',
  ENTM: 'biology',   PLSC: 'biology',   NFSC: 'biology',
  // Maths and computing
  MATH: 'maths',     STAT: 'maths',     AMSC: 'maths',
  CMSC: 'computing', INST: 'computing', DATA: 'computing',
  // Business and social science
  BMGT: 'business',  ECON: 'business',  BUFN: 'business',
  BUAC: 'business',  BUSI: 'business',  BUDT: 'business',
  // Humanities
  ENGL: 'humanities', HIST: 'humanities', PHIL: 'humanities',
  GVPT: 'humanities', PSYC: 'humanities', SOCY: 'humanities',
  // Arts
  ARTT: 'arts', MUSC: 'arts', THET: 'arts', DANC: 'arts'
};

// Human-readable name per figure, used in the tooltip.
export const FIGURE_LABELS = {
  chemistry: 'Chemistry', physics: 'Physics', biology: 'Biology',
  maths: 'Maths', computing: 'Computing', business: 'Business',
  humanities: 'Humanities', arts: 'Arts', study: 'Study'
};

const LOOKUP_CACHE_KEY = 'scheduler.deptCache.v1';

function readCache() {
  try { return JSON.parse(localStorage.getItem(LOOKUP_CACHE_KEY)) || {}; }
  catch { return {}; }
}

function writeCache(cache) {
  try { localStorage.setItem(LOOKUP_CACHE_KEY, JSON.stringify(cache)); } catch { /* full */ }
}

// "ABCD123 LEC" -> "ABCD". Returns null if the title is not a course code.
export function departmentOf(title) {
  const match = /^([A-Za-z]{3,4})\s?\d{3}/.exec(title.trim());
  return match ? match[1].toUpperCase() : null;
}

/* The figure to draw for a class title, resolved immediately from the code.
   Falls back to a generic studying figure. */
export function subjectFor(title) {
  const dept = departmentOf(title);
  if (!dept) return 'study';

  if (DEPT_FIGURES[dept]) return DEPT_FIGURES[dept];

  // Previously looked up and cached.
  const cached = readCache()[dept];
  return cached || 'study';
}

/* Ask umd.io what an unknown department actually is, once, and remember it.
 *
 * This is the "check it against the UMD database" step. It only runs for codes
 * not already in the table above, results are cached in localStorage, and a
 * failure is silent — the class simply keeps the generic studying figure
 * rather than the block breaking. Only a public course code is sent; nothing
 * personal. */
export async function resolveUnknownSubjects(titles) {
  const cache = readCache();
  const unknown = [...new Set(
    titles.map(departmentOf).filter((d) => d && !DEPT_FIGURES[d] && !cache[d])
  )];
  if (!unknown.length) return false;

  let learned = false;

  for (const dept of unknown) {
    try {
      const response = await fetch(
        `https://api.umd.io/v1/courses/departments?dept_id=${encodeURIComponent(dept)}`
      );
      if (!response.ok) continue;

      const data = await response.json();
      const name = (Array.isArray(data) ? data[0]?.department : data?.department) || '';
      cache[dept] = figureFromDepartmentName(name);
      learned = true;
    } catch {
      // Offline or the service is down. Leave it unresolved; it will be
      // retried next time rather than cached as a wrong answer.
    }
  }

  if (learned) writeCache(cache);
  return learned;
}

// Map a department's English name onto one of our figures.
function figureFromDepartmentName(name) {
  const n = name.toLowerCase();
  if (/chem/.test(n)) return 'chemistry';
  if (/physic|astro/.test(n)) return 'physics';
  if (/bio|life scien|genetic|zoolog|botan/.test(n)) return 'biology';
  if (/math|statist/.test(n)) return 'maths';
  if (/comput|informat|data/.test(n)) return 'computing';
  if (/business|manage|account|financ|econom|market/.test(n)) return 'business';
  if (/art|music|theat|danc|film/.test(n)) return 'arts';
  if (/english|histor|philosoph|govern|psycholog|sociolog|languag/.test(n)) return 'humanities';
  return 'study';
}

// ============================================================
// SVG helper
// ============================================================

function svgEl(className, viewBox, markup) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = markup;
  return svg;
}

// ============================================================
// The Sleep block
// ============================================================

/* Side-lying, head sunk into the pillow, duvet drawn up over the shoulder.
 * The breathing is the point: the duvet swells over the chest specifically
 * rather than the whole figure scaling, which is what made the previous
 * version look like a picture being zoomed rather than a person breathing. */
export function buildSleeper() {
  return svgEl('sleeper', '0 0 240 110', `
    <!-- headboard and bed -->
    <rect class="sl-headboard" x="8" y="20" width="12" height="62" rx="5" />
    <rect class="sl-bed" x="8" y="80" width="224" height="10" rx="5" />
    <rect class="sl-leg" x="16" y="90" width="7" height="12" rx="3" />
    <rect class="sl-leg" x="218" y="90" width="7" height="12" rx="3" />

    <!-- pillow, dented where the head rests -->
    <path class="sl-pillow" d="M24 74 Q22 50 44 48 L70 46 Q86 48 84 62 Q82 74 62 76 Z" />

    <!-- mattress line -->
    <rect class="sl-mattress" x="12" y="74" width="216" height="8" rx="4" />

    <g class="sl-figure">
      <!-- duvet: the big shape, swelling over the chest as it breathes -->
      <path class="sl-duvet" d="M92 76 Q96 52 128 52 L196 52 Q222 54 224 76 Z" />
      <path class="sl-duvet-fold" d="M92 64 Q140 56 224 62" />

      <!-- shoulder peeking above the duvet, following the breath -->
      <path class="sl-shoulder" d="M92 60 Q100 50 116 52 L116 60 Z" />

      <!-- head resting on its side, sunk into the pillow -->
      <g class="sl-head-group">
        <circle class="sl-head" cx="70" cy="60" r="15" />
        <path class="sl-hair" d="M56 56 Q56 43 70 43 Q84 43 85 55 Q76 49 66 52 Q59 54 56 56 Z" />
        <!-- closed eye, one visible from this angle -->
        <path class="sl-eye" d="M63 61 q4 3.5 8 0" />
        <!-- slightly open mouth -->
        <ellipse class="sl-mouth" cx="74" cy="68" rx="2.4" ry="1.6" />
      </g>
    </g>

    <!-- Zzz, each on its own drift with its own timing -->
    <g class="sl-zzz">
      <text class="sl-z a" x="96" y="34">z</text>
      <text class="sl-z b" x="112" y="24">z</text>
      <text class="sl-z c" x="130" y="14">z</text>
    </g>
  `);
}

// ============================================================
// The Get ready block
// ============================================================

/* Brushing teeth at a sink. The arm scrubs horizontally, the head bobs very
 * slightly against it, and foam appears and fades. */
export function buildBrusher() {
  return svgEl('brusher', '0 0 150 110', `
    <!-- mirror -->
    <rect class="br-mirror" x="18" y="6" width="52" height="42" rx="6" />
    <path class="br-glint" d="M26 42 L58 12" />

    <!-- sink and pedestal -->
    <path class="br-sink" d="M8 74 L88 74 Q86 90 70 90 L26 90 Q10 90 8 74 Z" />
    <rect class="br-pedestal" x="40" y="90" width="16" height="16" rx="3" />
    <rect class="br-tap" x="44" y="62" width="6" height="13" rx="3" />
    <path class="br-tap-spout" d="M47 62 q0 -8 9 -8" />

    <g class="br-figure">
      <!-- body -->
      <path class="br-torso" d="M92 92 Q92 62 112 62 Q132 62 132 92 Z" />

      <!-- head, bobbing with the brushing -->
      <g class="br-head-group">
        <circle class="br-head" cx="112" cy="44" r="16" />
        <path class="br-hair" d="M96 40 Q98 26 112 26 Q126 26 128 40 Q119 32 112 34 Q103 33 96 40 Z" />
        <circle class="br-eye" cx="105" cy="45" r="2" />
        <circle class="br-eye" cx="118" cy="45" r="2" />
        <!-- open mouth, brush inside -->
        <ellipse class="br-mouth" cx="111" cy="54" rx="6" ry="4" />
      </g>

      <!-- brushing arm: scrubs side to side -->
      <g class="br-arm">
        <path class="br-limb" d="M96 70 Q86 62 84 54" />
        <circle class="br-hand" cx="84" cy="53" r="4" />
        <rect class="br-brush-handle" x="82" y="44" width="4" height="14" rx="2" />
        <rect class="br-brush-head" x="80.5" y="40" width="7" height="6" rx="2" />
      </g>

      <!-- foam flecks -->
      <g class="br-foam">
        <circle class="br-bubble f1" cx="122" cy="56" r="2.6" />
        <circle class="br-bubble f2" cx="128" cy="50" r="1.9" />
        <circle class="br-bubble f3" cx="119" cy="47" r="1.5" />
      </g>
    </g>
  `);
}

// ============================================================
// Class blocks, by subject
// ============================================================

/* Each subject gets a scene of its own. They share a visual grammar — the same
 * desk, the same proportions — so a timeline of mixed subjects still reads as
 * one person moving through their day rather than a sticker sheet. */
const SUBJECT_SVG = {
  chemistry: `
    <path class="fg-bench" d="M6 78 H126 V84 H6 Z" />
    <!-- conical flask with bubbling contents -->
    <path class="fg-flask" d="M52 34 L52 50 L38 76 Q36 82 43 82 L73 82 Q80 82 78 76 L64 50 L64 34 Z" />
    <path class="fg-liquid" d="M45 66 L71 66 L73 76 Q74 79 70 79 L46 79 Q42 79 43 76 Z" />
    <rect class="fg-neck" x="50" y="30" width="16" height="5" rx="2" />
    <g class="fg-bubbles">
      <circle class="fg-bubble b1" cx="53" cy="72" r="2.4" />
      <circle class="fg-bubble b2" cx="60" cy="74" r="1.8" />
      <circle class="fg-bubble b3" cx="66" cy="71" r="2.1" />
    </g>
    <!-- vapour curling off the top -->
    <path class="fg-vapour" d="M58 28 q-5 -7 1 -12 q5 -5 0 -10" />
    <!-- test tube rack -->
    <rect class="fg-tube" x="92" y="52" width="7" height="26" rx="3" />
    <rect class="fg-tube" x="104" y="52" width="7" height="26" rx="3" />
  `,
  physics: `
    <path class="fg-bench" d="M6 84 H126 V90 H6 Z" />
    <!-- pendulum frame -->
    <rect class="fg-frame" x="18" y="14" width="86" height="5" rx="2.5" />
    <rect class="fg-post" x="20" y="18" width="5" height="66" rx="2" />
    <rect class="fg-post" x="98" y="18" width="5" height="66" rx="2" />
    <!-- swinging bob -->
    <g class="fg-pendulum">
      <line class="fg-string" x1="61" y1="18" x2="61" y2="58" />
      <circle class="fg-bob" cx="61" cy="63" r="9" />
    </g>
    <!-- arc it traces -->
    <path class="fg-arc" d="M34 58 Q61 78 88 58" />
  `,
  biology: `
    <path class="fg-bench" d="M6 82 H126 V88 H6 Z" />
    <!-- microscope -->
    <path class="fg-scope-base" d="M36 82 Q36 72 56 72 L84 72 Q92 72 92 82 Z" />
    <rect class="fg-scope-stage" x="46" y="58" width="42" height="6" rx="3" />
    <g class="fg-scope-arm">
      <path class="fg-scope-body" d="M62 22 Q78 22 78 40 L78 58 L66 58 L66 40 Q66 30 58 30 Z" />
      <rect class="fg-eyepiece" x="56" y="14" width="13" height="12" rx="4" />
    </g>
    <!-- slide, and the specimen on it -->
    <rect class="fg-slide" x="50" y="62" width="34" height="4" rx="2" />
    <g class="fg-cells">
      <circle class="fg-cell c1" cx="60" cy="64" r="2.2" />
      <circle class="fg-cell c2" cx="68" cy="64" r="1.7" />
      <circle class="fg-cell c3" cx="76" cy="64" r="2" />
    </g>
  `,
  maths: `
    <!-- whiteboard with equations writing themselves -->
    <rect class="fg-board" x="10" y="10" width="112" height="66" rx="5" />
    <rect class="fg-tray" x="10" y="76" width="112" height="6" rx="3" />
    <g class="fg-chalk">
      <path class="fg-eq e1" d="M24 32 H56" />
      <path class="fg-eq e2" d="M24 46 H74" />
      <path class="fg-eq e3" d="M24 60 H48" />
    </g>
    <!-- the marker that writes them -->
    <rect class="fg-marker" x="80" y="56" width="5" height="16" rx="2.5" />
    <circle class="fg-sum" cx="98" cy="30" r="10" />
  `,
  computing: `
    <path class="fg-desk" d="M6 82 H126 V88 H6 Z" />
    <!-- laptop -->
    <path class="fg-lid" d="M34 26 H98 Q102 26 102 30 L102 66 H30 L30 30 Q30 26 34 26 Z" />
    <rect class="fg-screen" x="36" y="32" width="60" height="28" rx="2" />
    <path class="fg-keyboard" d="M22 66 H110 L116 78 H16 Z" />
    <!-- code lines appearing -->
    <g class="fg-code">
      <path class="fg-line l1" d="M42 39 H70" />
      <path class="fg-line l2" d="M42 45 H84" />
      <path class="fg-line l3" d="M42 51 H62" />
    </g>
    <rect class="fg-cursor" x="42" y="55" width="7" height="2.5" rx="1.2" />
  `,
  business: `
    <!-- presentation board with growing bars -->
    <rect class="fg-board" x="10" y="10" width="112" height="66" rx="5" />
    <rect class="fg-tray" x="10" y="76" width="112" height="6" rx="3" />
    <g class="fg-bars">
      <rect class="fg-bar b1" x="28" y="30" width="14" height="34" rx="3" />
      <rect class="fg-bar b2" x="50" y="30" width="14" height="34" rx="3" />
      <rect class="fg-bar b3" x="72" y="30" width="14" height="34" rx="3" />
      <rect class="fg-bar b4" x="94" y="30" width="14" height="34" rx="3" />
    </g>
    <path class="fg-trend" d="M28 58 L52 46 L76 50 L106 26" />
    <circle class="fg-trend-dot" cx="106" cy="26" r="4" />
  `,
  humanities: `
    <path class="fg-desk" d="M6 84 H126 V90 H6 Z" />
    <!-- open book, pages turning -->
    <path class="fg-book-l" d="M18 74 Q18 42 62 38 L62 74 Z" />
    <path class="fg-book-r" d="M110 74 Q110 42 66 38 L66 74 Z" />
    <path class="fg-page" d="M64 38 Q92 42 100 70 Q80 62 64 66 Z" />
    <g class="fg-text">
      <path class="fg-line l1" d="M28 52 H54" />
      <path class="fg-line l2" d="M28 60 H50" />
      <path class="fg-line l3" d="M74 52 H100" />
    </g>
  `,
  arts: `
    <!-- easel with a canvas being painted -->
    <path class="fg-easel" d="M30 88 L52 24 M98 88 L76 24 M40 62 H88" />
    <rect class="fg-canvas" x="34" y="18" width="60" height="46" rx="3" />
    <path class="fg-stroke s1" d="M42 52 Q54 34 66 48" />
    <path class="fg-stroke s2" d="M58 56 Q72 40 86 52" />
    <!-- brush dabbing at it -->
    <g class="fg-brush">
      <rect class="fg-brush-handle" x="100" y="40" width="4" height="18" rx="2" />
      <path class="fg-brush-tip" d="M100 40 L104 40 L102 33 Z" />
    </g>
  `,
  study: `
    <path class="fg-desk" d="M6 82 H126 V88 H6 Z" />
    <rect class="fg-paper" x="30" y="44" width="56" height="38" rx="3" />
    <g class="fg-text">
      <path class="fg-line l1" d="M38 56 H72" />
      <path class="fg-line l2" d="M38 64 H78" />
      <path class="fg-line l3" d="M38 72 H62" />
    </g>
    <g class="fg-pen">
      <rect class="fg-pen-body" x="86" y="34" width="5" height="24" rx="2.5" />
      <path class="fg-pen-tip" d="M86 58 L91 58 L88.5 65 Z" />
    </g>
  `
};

/* Build the figure for a class. `kind` varies the animation speed a little so a
   lab feels busier than a lecture, without needing separate artwork. */
export function buildSubjectFigure(title, kind = 'LEC') {
  const subject = subjectFor(title);
  const svg = svgEl(`class-figure fig-${subject}`, '0 0 132 96', SUBJECT_SVG[subject] || SUBJECT_SVG.study);
  svg.dataset.kind = kind;
  return svg;
}

// "ABCD123 LAB" -> "LAB"
export function kindOf(title) {
  const match = /\b(LEC|LAB|DIS|SEM)\b/i.exec(title);
  return match ? match[1].toUpperCase() : 'LEC';
}
