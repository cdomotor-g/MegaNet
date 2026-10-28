# Route on map — the drive to a station, on Flood-Net's own map

🛣️ **Route on map** is on a station card's *Position* group, beside 🚗
Directions, and in the station editor's. It draws the drive to the station on
the Stations map: by road from where the trip starts to where the station's
mapped access track begins, then along the track to the gauge, with the
distance, the time and the turns. Issue #251, part of #250.

It is for **signed-in editors**, for now (the owner, 2026-10-28). A route
through a property's gate is no more for the open internet than the access
track it ends on (`0067`).

🚗 Directions stays as it is. It hands the station's coordinate to Apple or
Google Maps, which is where voice guidance, re-routing and offline maps are.
Route on map is for planning the trip and for the last stretch, which no maps
app knows.

## Where the drive starts

In this order:

1. **Where the phone is**, if it has a position when the route is asked for.
   The fix is asked for then, on a phone or a tablet only. It has to arrive
   within 12 seconds and be good to 2 km. A desk's browser is never asked:
   its answer would be the office network's guess, and asking would put a
   permission prompt in front of the route.
2. **Pritchard Road, Virginia** (the middle of the road, -27.37429,
   153.06059) for a station on the Brisbane hub (`hub_id = brisbane`).
3. **Otherwise it asks.** The panel offers where you are, Pritchard Road, a
   click or tap on the map, the start used last, or a town, a station (by its
   name or number) or a coordinate typed in. A town is looked up in
   OpenStreetMap's gazetteer through 📍 Find a place's own lookup, on its terms.

**Change** on the panel picks another start at any time. The start chosen is
remembered for the session as *the start used last*, never as the default.

When the rule falls through — the phone would not say where it is, or only
roughly — the panel says why under *From*.

## The last stretch

A station with a mapped **access track** is driven to where the track starts,
and the track is drawn from there to the gauge, from Flood-Net's own database.
Of a track's two ends, the one nearer the pin is the station's and the other
is the road's, whichever way round it was recorded. When a station has several
tracks, the one whose road end is nearest the start is used. Only the track's
road end leaves the browser, as a coordinate. The track itself never does.

Where nothing mapped reaches, the rest is a **dotted straight line**, and the
panel gives its length as *Not mapped*: the road stopping at a gate, the track
stopping short of the pin, or a pin with no track at all. It is the part nobody
has mapped, not a way in.

On the map: the road is a blue line in a dark casing, the track is the access
track's own green (as 📌 Site features draws it), the unmapped stretches are
dotted white, and the start is a ringed dot. All of it sits under the links
and the pins and over the context layers, and none of it takes a click.

## The panel

Bottom left of the map, like Move pin's. It shows:

- **From**: where the drive starts, and **Change**.
- **By road**: the distance and the time at the roads' usual speeds. It does
  not account for traffic, roadworks, closures or floods. A ferry is flagged.
- **Access track**: the track's length.
- **Not mapped**: what no road or track reaches.
- **Turn by turn**: the router's directions, then the unmapped stretch and the
  track to the station.
- 🚗 **Directions** and **Whole route**.
- OpenStreetMap's credit and a **Report a map error** link.
- **What the words here mean**: the same meanings the underlined words give
  on hover.

The station card gives way to the panel when the route opens, as it does for
Move pin and Site features. A card opened again while the route is up folds
the panel to one line, and closing the card unfolds it. ▾ folds and unfolds it
by hand, and ✕ takes the route off the map.

## Where the road comes from

**Not Google.** Google's Routes API only lets its routes be shown on a Google
Map, and restricts storing them
([policy](https://developers.google.com/maps/documentation/routes/policies)).
The Stations map is Leaflet over OpenStreetMap, OpenTopoMap, Esri and the
State's imagery.

**OpenStreetMap's roads, through Valhalla on FOSSGIS's server**
(`valhalla1.openstreetmap.de`). FOSSGIS e.V. runs it, with donations and
volunteers, for low-traffic applications on
[these terms](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/),
which Flood-Net keeps:

| FOSSGIS asks | Flood-Net |
|---|---|
| At most one request a second | One a second from each Worker isolate, a queue of at most 8 s, and 30 a minute across all of them (`DRIVE_RATE_LIMIT`) — all of it behind a 6-hour cache of the same pair of points |
| A User-Agent naming the application, and a Referer | `Flood-Net station routes (+https://floodwarning.net/docs/drive.md)`, from `https://floodwarning.net/` |
| OpenStreetMap's attribution and a link to report map errors | On the panel, under the route |
| The operator's email easy to find on the site | [privacy.html](../privacy.html) and [terms.html](../terms.html) carry it |
| No high-traffic sites; the service may be withdrawn without notice | A few editors planning trips; the router's address is in one place (below) |

Valhalla rather than FOSSGIS's OSRM because, tried against 30 random Queensland
stations (#250), it followed property tracks further in. At two stations it
stopped 150 m from the pin where OSRM stopped 1.4 km and 2 km short. It can
also be told to avoid areas, which #252 (flooded and closed roads) needs.

If FOSSGIS withdraws it, the fallbacks are openrouteservice (a free key; 2,000
routes a day on its standard plan) or a Valhalla of Flood-Net's own. Either
one is a change to `ROUTER_URL` and `routerBody()` in `worker/drive.js`, and
nothing else.

## The Worker route — `/api/drive`

`worker/drive.js`:

```
GET /api/drive?from=<lat>,<lon>&to=<lat>,<lon>
  Authorization: Bearer <an editor's Supabase session>
```

| Status | What |
|---|---|
| 200 | `{from, to, km, s, ferry, toll, shape, steps, gap_start_m, gap_end_m, source, fetched}` — `shape` latitude first; `steps` the router's turns without its arrival; `gap_*_m` how far each end of the road is from the point asked for. `cached: true` when it came from the edge cache |
| 400 | not two coordinates, not in Australia, or more than 2,500 km apart |
| 401 | not an editor (the session is put to `meganet.is_editor()`) |
| 422 | `code: no_road` (no road near a point), `no_path` (none between them), `too_far` |
| 429 | `code: busy` — the brakes above, with `Retry-After: 60` |
| 502 / 504 | `code: router` / `timeout` — the router down, slow, or answering something else |

Nothing of the caller's request goes to the router but the two coordinates,
rounded to a metre. The session, cookies and address stay with the Worker. A
failure is never cached.

## Checks

`npm run drive` (`test/drive.mjs`), in CI. Under Node, it runs the route
against stand-ins for the router, the cache, the clock and the editor check.
In Chromium, it runs the real app on the real station list, with the Worker,
the access tracks and the gazetteer stood in. Its header lists what each half
holds.

## Not yet

- Avoiding QLDTraffic's flooded and closed roads — #252.
- An inspection run: several stations in the best order, and road distances
  on 📌 Nearby — #253.
- Keeping a route on the phone for when there is no signal — #254.
