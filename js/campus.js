/* campus.js — where things are, and how far apart.
 *
 * Building coordinates are hardcoded on purpose: buildings do not move, so
 * fetching them at runtime would add a network dependency for data that never
 * changes. Anything that DOES change — opening hours in particular — is
 * refreshed into data/dining.json instead (see tools/fetch-dining.py).
 *
 * Coordinates came from OpenStreetMap and are the building centroids.
 */

export const BUILDINGS = {
  VMH: { name: 'Van Munching Hall',           lat: 38.983017, lon: -76.947055 },
  BRB: { name: 'Biosciences Research Building', lat: 38.988975, lon: -76.942874 },
  HJP: { name: 'H.J. Patterson Hall',         lat: 38.987063, lon: -76.943237 },
  CHM: { name: 'Chemistry Building',          lat: 38.989636, lon: -76.940179 },
  PHY: { name: 'John S. Toll Physics',        lat: 38.988716, lon: -76.940062 }
};

// Middle of campus — where the map opens if we have no position yet.
export const CAMPUS_CENTRE = { lat: 38.9875, lon: -76.9430 };

/* Pull a building code out of a location string such as a room reference.
   Examples are deliberately generic here — the publish guard rejects real room
   numbers appearing in code destined for the public repo, and rightly so.
   Returns null when nothing matches, which the map treats as "this class has
   no mappable location" rather than guessing. */
export function buildingFromLocation(location) {
  if (!location) return null;
  const match = String(location).toUpperCase().match(/\b(VMH|BRB|HJP|CHM|PHY)\b/);
  return match ? match[1] : null;
}

export function buildingInfo(code) {
  return code ? BUILDINGS[code] || null : null;
}

/* Straight-line distance in metres (haversine).
 *
 * Deliberately not a routing service: sending your live coordinates to a
 * third-party API to draw a slightly nicer line is a privacy cost that is not
 * worth paying. Campus paths are close enough to direct that straight lines
 * plus a walking-speed estimate give an honest answer. */
export function distanceMetres(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 +
            Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Minutes to walk a distance. 1.35 m/s is a normal walking pace; the 1.25
   multiplier accounts for paths not being straight lines, which keeps the
   estimate honest rather than optimistic. */
export function walkMinutes(metres) {
  return Math.max(1, Math.round((metres * 1.25) / (1.35 * 60)));
}

export function formatDistance(metres) {
  return metres < 950 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

/* ------------------------------------------------------------
   Opening hours
   ------------------------------------------------------------ */

/* Is a place open right now, according to its OSM opening_hours string?
 *
 * OSM's syntax is large and this parser handles the common subset:
 *   "Mo-Fr 07:00-19:00"
 *   "Mo-Th 10:30-22:30; Fr 10:00-23:30; Sa,Su 11:00-20:00"
 *   "24/7"
 *
 * Anything it cannot parse returns null — meaning "unknown", never a
 * confident guess. A wrong "open now" is worse than admitting we don't know,
 * because it sends you across campus to a locked door.
 */
const DAY_INDEX = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };

export function isOpenNow(hours, now = new Date()) {
  if (!hours || typeof hours !== 'string') return null;

  const text = hours.trim().toLowerCase();
  if (text === '24/7') return true;

  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  let understoodAnything = false;

  for (const rule of text.split(';')) {
    const part = rule.trim();
    if (!part) continue;

    // Split into an optional day spec and one or more time ranges.
    const timeMatches = [...part.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
    if (!timeMatches.length) continue;

    const daySpec = part.slice(0, part.indexOf(timeMatches[0][0])).trim();
    const days = parseDays(daySpec);
    if (days === null) continue;          // unparseable day spec — skip the rule

    understoodAnything = true;
    if (days.size && !days.has(day)) continue;

    for (const m of timeMatches) {
      const from = Number(m[1]) * 60 + Number(m[2]);
      let to = Number(m[3]) * 60 + Number(m[4]);
      // "22:00-02:00" wraps past midnight.
      if (to <= from) to += 1440;
      if (minutes >= from && minutes < to) return true;
      if (minutes + 1440 >= from && minutes + 1440 < to) return true;
    }
  }

  return understoodAnything ? false : null;
}

// "mo-fr", "sa,su", "" (meaning every day). Returns null if not understood.
function parseDays(spec) {
  if (!spec) return new Set();          // no day spec = applies every day

  const days = new Set();

  for (const chunk of spec.split(',')) {
    const piece = chunk.trim();
    if (!piece) continue;

    const range = piece.match(/^([a-z]{2})\s*-\s*([a-z]{2})$/);
    if (range) {
      const from = DAY_INDEX[range[1]];
      const to = DAY_INDEX[range[2]];
      if (from === undefined || to === undefined) return null;
      for (let d = from; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === to) break;
      }
      continue;
    }

    const single = DAY_INDEX[piece];
    if (single === undefined) return null;
    days.add(single);
  }

  return days;
}
