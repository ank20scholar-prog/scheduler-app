/* map.js — the Map tab.
 *
 * Shows today's classes as a walking route between buildings, your live
 * position, which building you need next, and food you can pick up on the way.
 *
 * Privacy choices worth knowing, since this is the only part of the app that
 * touches the network or your location:
 *
 *   • Your GPS position never leaves the device. There is no routing API call.
 *     Distances are computed locally (see campus.js) and drawn as direct lines.
 *   • Location is only requested when you actually open this tab, never on
 *     app start.
 *   • The only external requests are map tile images from OpenStreetMap. Those
 *     reveal roughly which part of the map you are looking at — unavoidable for
 *     any real map — and nothing else.
 *   • Dining data is read from our own origin, refreshed by a scheduled job
 *     rather than fetched from a third party by your browser.
 */

import { scheduledEntriesForDate, toMinutes, fmt12, nowMinutes, toISODate } from './store.js';
import {
  BUILDINGS, CAMPUS_CENTRE, buildingFromLocation, buildingInfo,
  distanceMetres, walkMinutes, formatDistance, isOpenNow
} from './campus.js';

const el = {
  map:          document.getElementById('map'),
  walker:       document.getElementById('walker'),
  routeList:    document.getElementById('route-list'),
  routeEmpty:   document.getElementById('route-empty'),
  nextStop:     document.getElementById('next-stop'),
  nextTitle:    document.getElementById('next-stop-title'),
  nextDetail:   document.getElementById('next-stop-detail'),
  foodBtn:      document.getElementById('food-btn'),
  foodList:     document.getElementById('food-list'),
  foodHint:     document.getElementById('food-hint')
};

let map = null;
let layers = null;          // L.LayerGroup holding everything we redraw
let userMarker = null;
let userPosition = null;    // { lat, lon } — stays in this module, never sent
let dining = null;          // contents of data/dining.json, loaded once
let currentDate = null;
let watchId = null;

/* ------------------------------------------------------------
   Set-up
   ------------------------------------------------------------ */

/* Leaflet needs a container with a real size, so the map is only created the
   first time the tab is actually shown. */
export function showMap(isoDate) {
  currentDate = isoDate;

  if (!map) {
    map = L.map(el.map, {
      center: [CAMPUS_CENTRE.lat, CAMPUS_CENTRE.lon],
      zoom: 16,
      zoomControl: true,
      attributionControl: false
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      // Keep the tile servers' terms satisfied even though we render our own
      // credit line under the map.
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    layers = L.layerGroup().addTo(map);
    bindWalkerToMap();   // must happen after the map exists
    startLocating();
    loadDining();
  }

  // The container was hidden until now, so Leaflet has stale dimensions.
  setTimeout(() => map.invalidateSize(), 60);
  drawRoute();
}

export function refreshMap() {
  if (map) drawRoute();
}

/* ------------------------------------------------------------
   Location
   ------------------------------------------------------------ */

function startLocating() {
  if (!('geolocation' in navigator)) return;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      userPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      drawUser();
      drawRoute();
    },
    (err) => {
      // Denied or unavailable. The map still works, it just cannot show "you".
      console.info('Location unavailable:', err.message);
      el.foodHint.textContent =
        'Location is off, so food is ranked from your next class instead of from you.';
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
  );
}

function drawUser() {
  if (!userPosition || !map) return;

  const latlng = [userPosition.lat, userPosition.lon];

  if (!userMarker) {
    userMarker = L.marker(latlng, {
      icon: L.divIcon({ className: 'you-pin', html: '<span></span>', iconSize: [18, 18] }),
      zIndexOffset: 1000
    }).addTo(map);
  } else {
    userMarker.setLatLng(latlng);
  }
}

/* ------------------------------------------------------------
   Today's route
   ------------------------------------------------------------ */

/* The classes for the day that have a building we can place, in time order.
   The route is simply chronological — there is no shortest-path problem to
   solve, because the order is fixed by when the classes are. */
function todayStops(isoDate) {
  return scheduledEntriesForDate(isoDate)
    .filter((e) => e.kind === 'class')
    .map((e) => ({ entry: e, code: buildingFromLocation(e.location) }))
    .filter((s) => s.code && BUILDINGS[s.code])
    .map((s) => ({ ...s, place: BUILDINGS[s.code] }));
}

function drawRoute() {
  if (!map) return;

  layers.clearLayers();
  el.routeList.innerHTML = '';

  const stops = todayStops(currentDate);
  el.routeEmpty.hidden = stops.length > 0;

  if (!stops.length) {
    el.nextStop.hidden = true;
    return;
  }

  const isToday = currentDate === toISODate(new Date());
  const mins = nowMinutes();

  // Which stop is next: the first class that has not finished yet.
  const nextIndex = isToday
    ? stops.findIndex((s) => toMinutes(s.entry.end) > mins)
    : 0;

  // --- The walking line between consecutive buildings ---
  const points = stops.map((s) => [s.place.lat, s.place.lon]);
  if (points.length > 1) {
    L.polyline(points, {
      className: 'route-line',
      weight: 4,
      opacity: .9,
      dashArray: '2 8',
      lineCap: 'round'
    }).addTo(layers);
  }

  // --- A pin per building ---
  stops.forEach((stop, index) => {
    const isNext = index === nextIndex;
    const isDone = isToday && toMinutes(stop.entry.end) <= mins;

    L.marker([stop.place.lat, stop.place.lon], {
      icon: L.divIcon({
        className: `stop-pin${isNext ? ' is-next' : ''}${isDone ? ' is-done' : ''}`,
        html: `<span class="stop-code">${stop.code}</span>`,
        iconSize: [46, 46]
      }),
      zIndexOffset: isNext ? 800 : 0
    })
      .bindPopup(`<strong>${stop.entry.title}</strong><br>${stop.place.name}<br>${fmt12(stop.entry.start)} – ${fmt12(stop.entry.end)}`)
      .addTo(layers);
  });

  renderRouteList(stops, nextIndex, isToday, mins);
  renderNextStop(stops, nextIndex, isToday, mins);
  positionWalker(stops, nextIndex, isToday);
  fitToRoute(points);
}

let hasFitted = false;
function fitToRoute(points) {
  // Only auto-fit once, so panning around is not undone on every tick.
  if (hasFitted || !points.length) return;
  hasFitted = true;

  const all = userPosition ? [...points, [userPosition.lat, userPosition.lon]] : points;
  map.fitBounds(L.latLngBounds(all).pad(0.25), { animate: false });
}

function renderRouteList(stops, nextIndex, isToday, mins) {
  stops.forEach((stop, index) => {
    const li = document.createElement('li');
    li.className = 'route-item';
    if (isToday && index === nextIndex) li.classList.add('is-next');
    if (isToday && toMinutes(stop.entry.end) <= mins) li.classList.add('is-done');

    const time = document.createElement('span');
    time.className = 'route-time';
    time.textContent = fmt12(stop.entry.start);

    const body = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'route-name';
    name.textContent = stop.entry.title;

    const where = document.createElement('div');
    where.className = 'route-where';
    where.textContent = `${stop.place.name}${stop.entry.location ? ' · ' + stop.entry.location : ''}`;
    body.append(name, where);

    li.append(time, body);

    // Walking leg from the previous building.
    if (index > 0) {
      const previous = stops[index - 1].place;
      const metres = distanceMetres(previous, stop.place);
      const leg = document.createElement('span');
      leg.className = 'route-leg';
      leg.textContent = `${walkMinutes(metres)} min walk`;
      li.appendChild(leg);
    }

    el.routeList.appendChild(li);
  });
}

function renderNextStop(stops, nextIndex, isToday, mins) {
  if (!isToday || nextIndex < 0) { el.nextStop.hidden = true; return; }

  const next = stops[nextIndex];
  const minutesAway = toMinutes(next.entry.start) - mins;

  el.nextTitle.textContent = `Next: ${next.entry.title}`;

  const parts = [next.place.name];
  if (next.entry.location) parts.push(next.entry.location);

  if (userPosition) {
    const metres = distanceMetres(userPosition, next.place);
    parts.push(`${formatDistance(metres)} away, about ${walkMinutes(metres)} min walk`);
  }

  parts.push(minutesAway > 0
    ? `starts in ${Math.round(minutesAway)} min`
    : 'in progress');

  el.nextDetail.textContent = parts.join(' · ');
  el.nextStop.hidden = false;
}

/* The little walking figure sits on the map at your position when we have it,
   otherwise at the next building — a guide showing where you are headed. */
function positionWalker(stops, nextIndex, isToday) {
  if (!map || !stops.length) { el.walker.hidden = true; return; }

  const target = stops[Math.max(0, nextIndex)];
  if (!target) { el.walker.hidden = true; return; }

  const anchor = userPosition
    ? [userPosition.lat, userPosition.lon]
    : [target.place.lat, target.place.lon];

  const point = map.latLngToContainerPoint(anchor);
  const size = map.getSize();

  // Hide rather than let it wander outside the map and overlap the cards
  // below — a guide floating over unrelated UI is just noise.
  const x = point.x - 20;
  const y = point.y - 52;
  if (x < -10 || y < -10 || x > size.x - 30 || y > size.y - 30) {
    el.walker.hidden = true;
    return;
  }

  el.walker.style.transform = `translate(${x}px, ${y}px)`;
  el.walker.hidden = false;
}

// Keep the walker glued to its spot while the map is panned or zoomed.
function bindWalkerToMap() {
  if (!map) return;
  map.on('move zoom', () => {
    const stops = todayStops(currentDate);
    if (!stops.length) { el.walker.hidden = true; return; }

    const isToday = currentDate === toISODate(new Date());
    const mins = nowMinutes();
    const nextIndex = isToday
      ? stops.findIndex((s) => toMinutes(s.entry.end) > mins)
      : 0;

    positionWalker(stops, nextIndex, isToday);
  });
}

/* ------------------------------------------------------------
   Food
   ------------------------------------------------------------ */

async function loadDining() {
  try {
    const response = await fetch('data/dining.json', { cache: 'no-cache' });
    if (!response.ok) return;
    dining = await response.json();
  } catch (err) {
    console.info('Dining data unavailable:', err.message);
  }
}

/* Rank food by how much of a detour it adds to the walk you are already doing.
 *
 *   detour = (you → food) + (food → next class) − (you → next class)
 *
 * A place directly on the route scores near zero. This is why a slightly
 * further café on your path beats a closer one in the opposite direction. */
function rankFood(origin, destination) {
  if (!dining?.places?.length) return [];

  const direct = destination ? distanceMetres(origin, destination) : 0;

  return dining.places
    .map((place) => {
      const toFood = distanceMetres(origin, place);
      const onward = destination ? distanceMetres(place, destination) : 0;
      return {
        ...place,
        toFood,
        detour: destination ? Math.max(0, toFood + onward - direct) : toFood,
        open: isOpenNow(place.hours)
      };
    })
    // Ignore anything wildly out of the way.
    .filter((p) => p.toFood < 1500)
    .sort((a, b) => {
      // Known-open places first, then by smallest detour.
      const aOpen = a.open === false ? 1 : 0;
      const bOpen = b.open === false ? 1 : 0;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return a.detour - b.detour;
    })
    .slice(0, 6);
}

function showFood() {
  el.foodList.innerHTML = '';

  if (!dining) {
    el.foodHint.textContent = 'Dining data has not loaded yet — try again in a moment.';
    return;
  }

  const stops = todayStops(currentDate);
  const isToday = currentDate === toISODate(new Date());
  const mins = nowMinutes();

  const nextIndex = isToday ? stops.findIndex((s) => toMinutes(s.entry.end) > mins) : -1;
  const next = nextIndex >= 0 ? stops[nextIndex] : null;

  const origin = userPosition || (next ? next.place : CAMPUS_CENTRE);
  const destination = next ? next.place : null;

  const minutesUntilNext = next ? toMinutes(next.entry.start) - mins : null;
  const results = rankFood(origin, destination);

  if (!results.length) {
    el.foodHint.textContent = 'Nothing found nearby.';
    return;
  }

  // The brief he asked for: if the next class is within the hour, point out
  // the best option actually on the way.
  if (next && minutesUntilNext !== null && minutesUntilNext > 0 && minutesUntilNext <= 60) {
    const best = results[0];
    const extra = walkMinutes(best.detour);
    el.foodHint.textContent =
      `${next.entry.title} starts in ${Math.round(minutesUntilNext)} min. ` +
      `${best.name} is on the way — about ${extra} min extra.`;
  } else if (next) {
    el.foodHint.textContent = `Ranked by detour on the way to ${next.entry.title}.`;
  } else {
    el.foodHint.textContent = userPosition
      ? 'Nothing else scheduled — ranked by distance from you.'
      : 'Nothing else scheduled — ranked from the middle of campus.';
  }

  for (const place of results) {
    const li = document.createElement('li');
    li.className = 'food-item';

    const name = document.createElement('div');
    name.className = 'food-name';
    name.textContent = place.name;

    const meta = document.createElement('div');
    meta.className = 'food-meta';

    const status = document.createElement('span');
    if (place.open === true) { status.className = 'food-open'; status.textContent = 'Open now'; }
    else if (place.open === false) { status.className = 'food-shut'; status.textContent = 'Closed now'; }
    else { status.className = 'food-unknown'; status.textContent = 'Hours unknown'; }

    const detail = document.createElement('span');
    detail.textContent = destination
      ? `${formatDistance(place.toFood)} away · +${walkMinutes(place.detour)} min detour`
      : `${formatDistance(place.toFood)} away`;

    meta.append(status, detail);
    li.append(name, meta);

    // Tapping a result drops a pin and pans to it.
    li.addEventListener('click', () => {
      map.setView([place.lat, place.lon], 17);
      L.marker([place.lat, place.lon], {
        icon: L.divIcon({ className: 'food-pin', html: '<span></span>', iconSize: [22, 22] })
      }).addTo(layers).bindPopup(`<strong>${place.name}</strong>`).openPopup();
    });

    el.foodList.appendChild(li);
  }
}

el.foodBtn.addEventListener('click', showFood);

/* Kept as an explicit hook from app.js so the module's set-up order is
   visible there rather than relying on import side effects. The map itself is
   created lazily in showMap(), because Leaflet cannot size a hidden container. */
export function initMapModule() {
  // Nothing to do up front by design — see showMap().
}
