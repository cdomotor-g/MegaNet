# Views on the Stations map

**Layers → Views**, the first section of the 🗺️ Layers panel on the Stations
map, sets the map up for the job in hand in one press, and is the one place that
decides how the radio paths are drawn and how strong they are.

- **The chips** — ready-made views for each kind of person who uses the map, and
  the person's own, kept on their device. A view sets the base map, which
  stations and paths are on, the link colouring and the overlay layers, and how
  the paths are drawn. **Put the map back** undoes the last one picked.
- **How the radio paths are drawn** — which paths (every one, each field
  station's best, bundled into trunks, or areas instead of lines) and as what
  (lines, flowing dashes, or tails and a spotlight).
- **Line strength** — auto-contrast and Balance.
- **Keep this mix** — the map as it is, saved under a name.
- **What the words in Views mean** — every special word in the section, for
  anyone who cannot hover.

It is `map-views.js` (the section, the views, the settings and the line
strength), with three modules that draw: `map-paths.js` (which paths),
`map-flow.js` (Flow) and `map-tails.js` (Tails & spotlight), all three on the
shared overlay canvas in `map-overlay.js`. Easements and land tenure, which the
Property services views use, are on the cadastre layer in `map-lots.js`.

Until somebody picks something, the map draws every path, with the person's own
Link opacity and no Balance, as **Flow** (since 7 Nov 2026; under the Classic
look too since 8 Nov). A stored drawing from before that says Lines under
Classic is read as the old default (settings version 3); under another look it
was a choice and is kept. An address can say otherwise for that page only,
`?draw=lines` (or `flow`, `tails`): nothing is stored, and it is taken out of
the address, as `?rail=` is. The browser checks open Classic pages with it
(`test/lib/browser.mjs`), since they were written against the lines.
Under Flow the backbone is drawn amber and glowing, with pulses running along
it, and the map's own black-dashed backbone steps back.

The section is a card per group — **Everyone**, **Technicians**, **Flood**,
**Property**, then Your views — with a row per view (a small picture, its name,
one line). Under all of them (since 8 Nov 2026 — opened under the view's own
row they moved every row below it), **Settings for** the view in force: its
tags and the quick settings — which paths, how they are drawn, and the
Balance — in its group's colour. Everything else is in the **More drawing
settings** fold.

Views and the map's own layers and controls under it are two cards of their
kind, in the Stations cards' dress (`.card-kind`): a ground a breath off the
pane and a band along the top, Views in indigo (`--panel-views`,
`--edge-views`) and **Map layers & controls** in slate (`--panel-mapctl`,
`--edge-mapctl`), each card's heading bands in its colour. The find box at the
top hides the controls card whole when nothing in it matches.

**Find a view or a control**, the box at the very top of Layers (since 8 Nov
2026; it was under Views and searched only the switches), filters Views as it
filters the switches below (`MapViews.find`, called from `applyMapDisplayFind`
in `app.js`). Every word typed has to be somewhere in what an item says — its
words and hover words — or in the names it is under: *Views*, its group, the
fold. So "flood" is the Flood views, "technicians weak" is Weak links, and
"presenting" is the Presenting switch. A view's row keeps its quick settings
with it both ways round. A match inside **More drawing settings** opens it on
the part that matched, and the words fold shows only the meanings that match;
both shut again when the box is cleared, and neither is remembered as opened.
Nothing matching anywhere hides Views whole, and the panel says nothing
matches. The filter survives Views redrawing itself. `npm run mapviews` §1.

---

**The view in a link** (since 8 Nov 2026). The address — and so 🔗 Share,
a station card's Copy link and Ctrl+K's copy — carries how the Stations map is
drawn, as `view=`: a built-in view's name while one is in force
(`view=radio`), else the whole mix as one short code (`MapViews.shareCode`):

```
view=m1.<switches>.<pins>.<colour>.<bases>.<drawing>
     m1.11000100000000000001110.111.freq.OSM-Topo*100!Satellite*0.lod~flow~all~100~35~24~90~1~1~1~70
```

a 1 or 0 for each switch in `SHARE_SWITCHES`' order (append only), the three
pin roles, the link colouring, each base map top first with its opacity (0
off), and the drawing: which paths, drawn as, Flow's motion, speed %, Lines
underneath %, tail and spotlight px, spotlight follows, backbone in full,
auto-contrast, Balance. With it, `focus=` names the repeater picked out, beside
`station=` and `map=`, and `3d=62,135` the ⛰️ 3-D view's tilt and turn while it
is up (route.js, `Map3D.camera`); a link opened with it opens the 3-D view so
(`Map3D.openAt`). A link opened — followed, typed, pasted —
applies them once the stations have arrived, the view as pressing one does:
a note says the link set the map, and ↶ Put the map back undoes it
(`MapViews.applyShared`). A reload, or back and forward, keeps the device's
own view: an address written a moment before the last change could otherwise
put an older view back. A part of the code that does not read is left out
rather than spoiling the rest; a code that does not read at all is let go.
`npm run mapviews` §12.

## The views, by who they are for

Every view says whether the backbone paths are on; only Overview and Backbone
have them (since 8 Nov 2026 — over tails, a spotlight, fade-margin colours or
live pulses the backbone was most of what the eye saw).

| Group | View | What it sets |
|---|---|---|
| Everyone | **Overview** | The base map left alone; every station; each field station's best path until you zoom in (zoom 11), as lines; auto-contrast on; backbone on; links coloured by channel; rivers, flood cameras, field photos and site features on, everything else off. |
| Everyone | **Site visit** | Satellite; every path as tails, the spotlight following the pointer; auto-contrast; Balance a little toward the photo (35); pins coloured by health; backbone off; property boundaries, easements, road parcels, survey marks, photos, site features, cameras and rivers. |
| Everyone | **Tasks** | Light map; no radio paths; every station; health colours, backbone and arrows off; rivers and the Tasks layer (`map-tasks.js`) on, everything else off. The layer rings each station with an unfinished task the signed-in person may see (task_list(), 0095) in the colour of its most pressing task — red overdue, amber waiting, blue filled in progress, blue open — with a ✅ badge counting them; badges close on screen merge, dashed, until you zoom in. Turning it on moves the map to take in those stations unless they are all in view. A badge opens the station's card; signed out, or on no team, it draws nothing and its note says why. The same pins are the ✅ Tasks tab's map (`tasks.js`). |
| Technicians | **Radio paths** | Satellite; every path as tails; Balance toward the network (62); arrows; health; backbone off; maintenance hubs; rivers, photos and site features. No property layers. |
| Technicians | **Weak links** | The base map left alone; every path as lines, coloured by fade margin; Balance well toward the network (85) so the weak ones stand out; backbone off. Working out a margin that is not saved fetches the ground heights along that path. |
| Technicians | **Backbone** | Only repeaters and bases (the field pins and their paths off); the backbone, drawn as Flow, with arrows, health and the maintenance hubs. |
| Technicians | **Live traffic** | Each field station's best path, faded, with ⏱️ Latency's live pulses running along it as readings arrive (the network is asked every 15 seconds); health on; backbone off. |
| Flood | **Rivers & catchments** | OSM-Topo; no radio paths; field stations only, with the forecast and information locations outlined; rivers, a river's catchment, the river basins, ground height and flood cameras. |
| Flood | **Rainfall** | Light; no radio paths; field stations only, outlined; the rainfall heat map over the river basins and rivers (re-read every 5 minutes). |
| Property | **Property & easements** | Satellite; no radio paths; property boundaries, easements, road parcels and road owners, council areas, survey marks and rivers. |
| Property | **Land & tenure** | OSM-Topo; no radio paths; land tenure, property boundaries, easements, rivers, river basins, council areas and road parcels. |

Each chip's tooltip says what it does and, where it applies, what turning it on
fetches. The line under the chips says what the view in force does, or **Your own
mix** when no view matches the map as it is.

A view that has no radio paths still sets the drawing back to every path, plain
lines — otherwise a Live traffic view picked before it would go on asking for
readings with nothing on the map to show them.

### Applying a view, and putting the map back

A view is a list of **knobs**, each one of the map's own switches:

| Knob | Read from | Set with |
|---|---|---|
| base | `map.mnBases.mix()` (the base drawn strongest) | `map.mnBases.set({ Satellite: 1 })` |
| links | `state.mapShowLinks` | written straight into state, then a rebuild |
| roles | `state.mapRolesOff` | `MapSymbols.setRole(role, on)` |
| backbone, arrows, colour, health, outlines | `state.mapShowBackbone`, `mapArrows`, `mapLinkColour`, `mapHealth`, `mapPinSls` | `setMapBackbone`, `MapArrows.setEnabled`, `setMapLinkColour`, `HealthGlance.setPins`, `MapSymbols.setOutlines` |
| riverLines, riverCatchment, rain, elev, catchments | the layer's `state.map…` flag | its module's `setEnabled` (`MapRiverLines.setCatchment` for the catchment) |
| lots, easements, tenure | `state.mapLots`, `mapEasements`, `mapTenure` | `MapLots.setEnabled`, `.setEasements`, `.setTenure` |
| roads, roadOwners, councils, survey, hubs, wind, cameras, photos, siteFeatures | the layer's flag | its module's `setEnabled` |
| drawing | `MapViews.settings()` | `MapViews.set(…)` |

Applying one reads each knob and calls its setter only where it differs, so a
view half in place costs half as much, and anything a view leaves out is left
alone. While it is applied `state.mapRefreshHold` is set: `refreshMapLayers`,
`rerenderMapDisplayControls` and `rerenderMapLegend` return at once (the first
records that a rebuild is owed in `state.mapRefreshOwed`), and when the last knob
is set the map is rebuilt once, the panel redrawn once and the legend repainted
once.

**Put the map back** is the map as it was just before the view, read the same
way (`MapViews.snapshot()`) and applied as if it were a view. It is kept for the
session, until the next view is picked.

### Your views

**Keep this mix** saves the snapshot under a name (up to 12, on this device, in
`mn-map-saved-views`); saving under a name already used updates it. A kept view
is a dashed chip under **Your views** with a ✕ to remove it.

Two knobs — whether the radio paths are shown and which kinds of station are
drawn — are not remembered by their own switches. The last view picked
(`mn-map-view-pick`) puts those two back on the next visit, as long as the rest
of the view is still in force; if the person has since set the map their own
way, it is forgotten.

---

## How the radio paths are drawn

### Which paths (`map-paths.js`)

- **Every path** — the map as it always was.
- **Best path only** — one path per field station: the one with the biggest fade
  margin anybody has worked out for it (a saved figure, else this session's),
  and where none of its paths has one, the shortest. Nothing is worked out to
  rank them — that would fetch terrain for thousands of paths — but the saved
  margins are asked for once a session, and the map is drawn again if they move
  a station's pick. Point at a station, open its card or focus a repeater and its
  other paths are drawn dashed on an overlay.
- **Best path until you zoom in** — the best path below zoom 11, every path from
  there in.
- **Bundled into trunks** — every path, but those of 16 km or more coming into
  one repeater from the same direction (a 36° slice) curve together and arrive
  along one line; three or more get a trunk, wider the more paths it carries.
  Shorter paths, and a path on its own, stay straight.
- **Areas, no lines** — no field lines: each repeater gets a coloured area round
  the field stations whose best path is to it (4.5 km round each, at least 8 px),
  and those pins wear the same colour as a ring. Repeaters less than 60 km apart
  never share a colour (eight colours, `--map-area-1` … `--map-area-8`).
  **In the ⛰️ 3-D view** the same areas are draped on the ground (since 8 Nov
  2026): `MapPaths.drawn3d(box)` draws them for the camera's box, padded by a
  quarter, into a Web Mercator picture that `map-3d.js` lays over the relief
  as an image source (`mn-areas`, over the elevation and water, under the polar
  plot and the cadastre) — Epic #186's rule, as the polar plot does it. A new
  picture is drawn when the camera settles outside the padded box or the areas
  change (`Map3D.areasChanged()`). The **digital twin** still draws all of a
  station's paths as rays: `MapPaths.droppedFor(id)` hands over the ones Best
  path only or Areas left out of the build.

The note under the choices, and the link note under Show radio paths, say how
many paths are drawn and how to see the rest. The paths left out are handed to
⏱️ Latency as hidden links, so its pulses still run along the real routes when
*Animate along hidden links* is on.

### Draw them as

- **Lines** — as always.
- **Flow** (`map-flow.js`) — dashes running along each path into its repeater
  (6 px on, 44 px gap, at 42 px a second times Speed), timed from the repeater
  end so every path into one repeater pulses into it together; and along the
  backbone on to the base, both ways on a repeater-to-repeater path. The lines
  underneath are drawn at *Lines underneath* (35 % to begin with). Three things
  can move:
  - **Everything flows**;
  - **Repeaters take turns** — one repeater at a time, west to east, about 2.6
    seconds each at the usual speed, its paths drawn in full with a ring and its
    name; focusing a repeater holds the turn on it;
  - **Live readings** — ⏱️ Latency's own pulses, one for each reading as it
    arrives. Views switches its animation on and, when you leave Live readings,
    off again — only if it was Views that switched it on.

  It starts paused when the device asks for less motion; **Play the dashes**
  overrides that either way. About 30 frames a second, and nothing at all while
  the 3-D view or the twin is up.

  **In the ⛰️ 3-D view** (since 8 Nov 2026) Flow has its own dashes, drawn by
  MapLibre (`map-3d.js`, "Flow in 3-D"): two line layers over the links, white
  dashes on the field paths and warm-white pulses on the backbone, at the 2-D
  sizes, gaps and speeds (6 px on, 44 off, 42 px a second; the backbone 16 on,
  56 off, 0.7 as fast). A MapLibre dash cannot slide, so the dash pattern is
  stepped a unit at a time, up to 30 times a second. Under Flow the field
  paths are drawn at Lines underneath (at least 0.3) and the backbone in Flow's
  amber at 0.85 or more, with no black dash; under Tails the field paths are
  drawn at 0.3 of their strength, since a tail is a flat-map drawing.
  Repeaters take turns runs every path at once there; Live readings draws no
  dashes there (its pulses are ⏱️ Latency's). They stand still while Presenting or paused, and go while a drive has the
  camera. `npm run mapviews` §9 checks it.
- **Tails & spotlight** (`map-tails.js`) — each path is a short tail out of each
  end (Tail length, 24 px to begin with from the field station, 0.7 of that from
  the repeater), pointing along it. A path is drawn whole when its station is in
  the **spotlight** — a circle round the pointer (Spotlight size, 120 px) — or is
  pointed at, on the card, or served by the focused repeater; pointing at a
  repeater draws all its paths. On a touch screen a tap moves the spotlight.
  *Backbone always in full* off gives the backbone tails too. A path drawn at
  nothing is also not clickable, so a hidden path is never hovered.

### Line strength

Every link's opacity is decided by one function, `MapViews.lineOpacity(line)`:

```
base   the person's Link opacity — or, with auto-contrast on, its figure
× bal  Balance: 0.45 + 1.1 × balance / 100   (1 at 50)
× role a casing at 0.75 of its core
= full what the 3-D view and the twin copy   (line.mnFullOpacity)
× mode Flow: Lines underneath (backbone at least 0.5); Tails: 1 lit, 0 not;
       Lines: 1 — and 1 while the 3-D view or the twin is up (the 3-D
       view makes its own of full: Flow and Tails above)
```

`MapViews.restyle()` writes it to every line (`mnBaseOpacity`, what the
repeater focus dims to a fifth of) and repaints only the lines that moved.

- **Auto-contrast** — the strength worked out from how much of the screen the
  lines cover: each drawn core's length on screen times its width plus two
  pixels, over the screen's area; the strength is what puts about 4.5 % of the
  screen in solid line, kept between 12 % and 90 %. Worked out again after every
  build and whenever the map stops moving, and applied only when it moves by
  more than 1.5 points. It never writes the person's own Link opacity, which
  comes back when it is turned off; the Link opacity slider is disabled while it
  is on, with a note saying what auto-contrast has the lines at. It holds while
  the 3-D view is up.
- **Balance** — between the photo (0) and the network (100). Toward Network the
  base map turns grey and darker (a CSS filter on this map's tile pane, up to
  85 % grey and 45 % darker) and the lines get up to half as strong again;
  toward Photo the map keeps its colours and the lines fade, to 45 % at the end.
  The filter is this map's alone — not saved into the base maps the other maps
  share, and not the 3-D view's or the magnifier's.

### The settings

One JSON object in `mn-map-drawing`, deep-merged and clamped on every change:

```js
{
  paths: 'every' | 'best' | 'lod' | 'bundle' | 'areas',
  draw:  'lines' | 'flow' | 'tails',
  flow:  { mode: 'all' | 'turns' | 'live', speed: 1 /* 0.3–2.5 */, under: 0.35 /* 0–1 */, playing: null },
  tails: { len: 24 /* 8–70 px */, spot: 90 /* 60–260 px */, follow: true, backboneFull: true },
  auto: false,
  balance: 50, /* 0–100 */
}
```

A change to `paths` rebuilds the map; anything else restyles the lines in place
and tells the three drawing modules. Sliders follow the map as they move and are
saved when let go.

---

## Easements and land tenure

Two rows under **Property boundaries (Qld)** in Layers, on the same cadastre
export (`map-lots.js`):

- **Easements, dashed** — the easement parcels as a dashed white line over a dark
  edge, under the lot lines; from about 1:40,000 like the lots.
- **Land tenure (Qld)** — national park, State forest, timber and forest
  reserves, reserves, leases and State land, each a pale colour of its own
  (`--map-tenure-*`, filled at about 35 %); freehold is left clear. From about
  1:300,000.

The legend's Overlay layers section keys both while they are drawn.

**What land is under the pointer** (since 8 Nov 2026, `map-property-tip.js`).
While the lot lines, easements or tenure are drawn, resting the mouse on the
land for a moment — or tapping it with a finger — puts up a hover name, stacked with the road reserve's and the
survey mark's (`map-tip-stack.js`), asked of the same cadastre as What is here
through `SiteLand.parts`:

- **Tenure on** (Land & tenure): the tenure first, who holds that kind of land,
  the lot on plan and its area, what the land is used for (the State's land use
  map, with its year), the locality and council.
- **Otherwise** (Property & easements, or the lot lines in any view): the lot on
  plan, its area and tenure, the easement under the pointer by its own lot on
  plan — or "No easement here" and how many are nearby, while Easements is on —
  the street address, the locality and council.

Both then add, once the pointer has rested half a second (since 11 Nov 2026):
the nearest road within 150 m, how far it is and who manages it, and the
nearest bridge and whether it is Transport and Main Roads' — the station card's
*Road and bridge — who manages them* (`site-roads.js`: `brief`, `askPoint`), a
line each, without who to call. Three questions a spot (the roads and the two
bridge registers); spots within about 5 m are one spot and the answers are kept
for the visit.

A road reserve is left to the road layer's own name when that is on, with the
road and bridge lines under it once they are known. Never who
owns a lot (the State does not publish it). The lot comes back with its
outline, so moving about inside it asks nothing more; its easements come in one
question a lot, its address in one, and the land use in one an area. A tap
keeps its label until the next tap or the map moves, and stands aside for a
survey mark's or a bridge's own callout. Nothing while the map moves, a tool
owns the pointer, the 3-D view is up, or outside Queensland. `npm run mapviews`
§13 checks it on made-up State answers, by mouse and by tap.

---

## How a module plugs in

- **Reading the settings** — `MapViews.settings()` returns a copy; never keep it
  past the call. `MapViews.hovered()` is the station under the pointer.
- **Changing a line's strength** — never `setStyle({ opacity })` on a link
  directly: hand the lines to `MapViews.restyle(lines)` and give `lineOpacity`
  what it needs to know (a module that changes which lines are lit, like
  MapTails, adds its own factor there).
- **After a build** — `refreshMapLayers` calls `MapViews.afterBuild()` at its end
  and in its early return, which works out auto-contrast, rebuilds MapTails'
  index, restyles, and syncs MapFlow, MapTails and MapPaths.
- **Drawing over the paths** — `MapOverlay.create(map, { pane, z, className,
  draw(ctx, h, t), animating() })`, a screen-sized canvas under the pins (z
  395–399; panes `mnAreas` 396, `mnPathsX` 398, `mnFlow` and `mnTails` 399), with
  pointer events off. `h.at(lat, lng)` is a point on the canvas, right mid-drag.
  Draw nothing while `Map3D.active()` or `MapTwin.active()`.
- **A new knob** — add it to `KNOB` and `ORDER` in `map-views.js` with `avail`,
  `read`, `same`, `write` and whether it rebuilds; the views that care list it.
- **A new view** — an entry in `VIEWS`: `id`, `group`, `label`, a plain-words
  `say`, a `caution` for anything it fetches, and its `knobs`.
- **A new word** — in `WORDS`, which feeds both the hover meanings and the fold.

The checks that cover it: `npm run mapviews` (this feature's own), `mapctl`, `maplinks`, `dock`, `map3d`,
`latency` and `smoke` (the panel, the lines, the 3-D mirror, ⏱️ Latency's pulses
and a clean console).
