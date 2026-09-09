#!/usr/bin/env python3
"""Refresh data/dining.json from OpenStreetMap.

Food places and their opening hours change, so they must not be hardcoded.
This queries the public Overpass API for everything edible near campus and
writes a small JSON file the app reads from its own origin.

It is run two ways:
  * by hand:            python tools/fetch-dining.py
  * by GitHub Actions:  on a schedule, committing the result to the public repo

Why a build step rather than fetching from the browser: a static page cannot
call a third-party API without relaxing the Content-Security-Policy and
exposing the user's browsing to that API. Doing it here means the app only ever
talks to its own origin, and no personal data is involved at any point — this
touches nothing but public map data.
"""

import json
import pathlib
import sys
import urllib.parse
import urllib.request

# Roughly the middle of campus. The radius covers campus and the Route 1 strip.
CENTRE_LAT = 38.9875
CENTRE_LON = -76.9430
RADIUS_M = 1400

OVERPASS = "https://overpass-api.de/api/interpreter"

QUERY = f"""
[out:json][timeout:60];
(
  nwr["amenity"~"^(cafe|fast_food|restaurant|food_court|ice_cream|bar|pub)$"]
     (around:{RADIUS_M},{CENTRE_LAT},{CENTRE_LON});
  nwr["name"~"Dining Hall|The Diner",i](around:{RADIUS_M},{CENTRE_LAT},{CENTRE_LON});
);
out center tags;
"""


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    request = urllib.request.Request(
        OVERPASS,
        data=body,
        # Overpass asks for a descriptive agent so it can contact heavy users.
        headers={"User-Agent": "scheduler-app/1.0 (campus dining refresh)"},
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def normalise(raw):
    places = []
    seen = set()

    for element in raw.get("elements", []):
        tags = element.get("tags") or {}
        name = tags.get("name")
        if not name:
            continue

        lat = element.get("lat") or (element.get("center") or {}).get("lat")
        lon = element.get("lon") or (element.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue

        # The same place can appear as both a node and a building way.
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)

        places.append({
            "name": name,
            "kind": tags.get("amenity") or "dining_hall",
            "lat": round(float(lat), 6),
            "lon": round(float(lon), 6),
            # OSM opening_hours syntax, e.g. "Mo-Fr 07:00-19:00". Absent for
            # plenty of places, which the app has to handle gracefully.
            "hours": tags.get("opening_hours"),
            "cuisine": tags.get("cuisine"),
            "indoor": tags.get("level") is not None,
        })

    places.sort(key=lambda p: p["name"].lower())
    return places


def main():
    try:
        places = normalise(fetch())
    except Exception as error:                      # noqa: BLE001
        print(f"Could not refresh dining data: {error}", file=sys.stderr)
        # Leave the existing file alone rather than replacing good data with
        # nothing — stale data beats an empty map.
        return 1

    if len(places) < 10:
        print(f"Only {len(places)} places returned; refusing to overwrite.", file=sys.stderr)
        return 1

    out = pathlib.Path(__file__).resolve().parent.parent / "data" / "dining.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "source": "OpenStreetMap contributors, ODbL",
        "centre": {"lat": CENTRE_LAT, "lon": CENTRE_LON},
        "radius_m": RADIUS_M,
        "places": places,
    }, indent=1), encoding="utf-8")

    with_hours = sum(1 for p in places if p["hours"])
    print(f"Wrote {len(places)} places ({with_hours} with opening hours) to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
