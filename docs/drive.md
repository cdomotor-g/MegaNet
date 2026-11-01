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
Google Maps, which know the roads but not the last stretch. Route on map is
for planning the trip and for that last stretch, and **🚘 Drive** (below)
follows it as you drive, in 3-D, with the turns said out loud and the route
worked out again if you leave it. With no signal, the maps apps are still the
ones to use: keeping a route on the phone is #254.

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
- 🚘 **Drive** (on a phone or a tablet) and ▶ **Preview the drive** — see
  *Driving mode* below.
- 🚗 **Directions** and **Whole route**.
- OpenStreetMap's credit and a **Report a map error** link.
- **What the words here mean**: the same meanings the underlined words give
  on hover.

The station card gives way to the panel when the route opens, as it does for
Move pin and Site features. A card opened again while the route is up folds
the panel to one line, and closing the card unfolds it. ▾ folds and unfolds it
by hand, and ✕ takes the route off the map.

## In 3-D

With a route up, ⛰️ 3-D drapes it on the ground the same way: the road blue,
the track green, what is not mapped dotted, the start a ringed dot, all under
the radio paths. Picking a start on the map goes back to the flat map, whose
coordinate for a click is the right one.

## Driving mode — 🚘 Drive and ▶ Preview

From the panel, once the route is worked out:

- **🚘 Drive**, on a phone or a tablet, follows the route as you drive it.
- **▶ Preview the drive**, everywhere, plays the drive along the route without
  using where you are — at the roads' usual speeds sped up 1, 4 or 16 times
  (⏸, ⏭ to just before the next turn) — to see what the drive will look like.

The map fills the screen and turns to the 3-D view, tilted and heading up, with
the car an arrow on the road about three-quarters of the way down so that most
of the screen is the road ahead. The camera comes in closer at walking pace and
pulls back at highway speed.

- **Across the top**: the next turn — its arrow, how far, and the router's
  words for it — and the turn after it when that one follows close behind.
  Then Flood-Net's own: where the mapped road ends, the access track, what is
  not mapped, and arriving. Past the end of the road, the banner says which way
  the station is and how far, as the crow flies.
- **Said out loud**, in Australian English where the device has the voice:
  each turn about 15 seconds out at the speed you are doing (200 m at least)
  and again at the turn, and how far to the next after a turn when that is more
  than 3 km. 🔊 turns the voice off and on, remembered on the device; the words
  go to a screen reader either way.
- **Across the foot**: ✕ End (or Escape), the time and distance *to go*, when
  you would *arrive*, 🔊, and 🗺️ — the rest of the route from overhead.
- **The stations**: the pins the Stations map is showing stand on the ground
  round the road. The ones nearest ahead (up to 12 km, in front of the car or
  within 600 m behind it) are named over their pins with how far each is in a
  straight line, at most six, never over one another; the station you are
  driving to is flagged 🏁 from 30 km out, whatever the map's filters say.
- **Looking round**: drag, pinch or turn the map and it stays where you put it;
  ◎ goes back to the car, and on a real drive it goes back by itself after 15
  seconds untouched.

**Where the car is.** The phone's position, put on the route: within 40 m of
it, plus however rough the position is, the car is drawn on the line and
carried along it between fixes, and the view turns with the road. A position
rougher than 100 m is not followed (the screen says so).

**Off the route.** More than that from the route for 6 seconds while still on
the road, and the route is worked out again from where you are — the same
`/api/drive`, with the same brakes, at most once every 20 seconds — and the old
one is followed until the new one comes. Past the road nothing would route the
rest, so there it says which way the station is instead.

**To go and arrive** are the rest of the road at the router's times for each
turn, the access track at 20 km/h and what is not mapped at walking pace —
with no traffic, roadworks, closures or floods.

The screen is kept on while the drive is. Keep Flood-Net on screen: a phone's
browser stops giving a page its position once it is in the background or the
phone is locked, and the drive waits ("Waiting for GPS…") until it is back. A
route already worked out keeps being followed through a stretch with no
signal, but the ground, the base map and a new route need one.

The drive opens with a line that says it once: *the route knows nothing of floods, closures or roadworks — if
it's flooded, forget it.*

The drive ends with ✕ End or Escape, on leaving the Stations tab, or when the
route is taken off the map (signing out does that). The flat map is left where
the car was, with the route and its panel as they were, and the 3-D view is
closed again if the drive opened it. While it lasts, the radio paths, the
rising water, the minimap and the cards are put away; they come back after.

`map-drive-mode.js`, with the route draped and the camera handed over by
`map-3d.js` (*Driving*). Checked by `npm run drivemode`.

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

`npm run drivemode` (`test/drivemode.mjs`), in CI: the drive in the real 3-D
view with the router and the phone's position stood in — the camera on the
car, the turns shown and said in time, the stations named, a drag that moves
the map, re-routing when the car leaves the road, and the map given back as
the drive found it. Its header lists what it holds.

## Not yet

- Avoiding QLDTraffic's flooded and closed roads — #252.
- An inspection run: several stations in the best order, and road distances
  on 📌 Nearby — #253.
- Keeping a route on the phone for when there is no signal — #254. Driving
  mode would follow it from there; the 3-D ground and the base map would
  still need a signal.
- The router's own kind of turn (a ramp, a fork, a merge) for the arrow:
  `/api/drive` passes on its words and not its turn type, so the arrow is read
  from the words and the bend of the road.
