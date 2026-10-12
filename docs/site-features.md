# Site features

Where a station's ancillary features are — its **orifice outlet**, **inspection
pits**, **benchmarks**, **gauge boards** and **crest gauge** as points, and its
**orifice run** (or a cable run) as a line through them — mapped on the Stations
map and kept in the datastore (`0061`).

| Where | What it does |
|---|---|
| **📌 Site features** on a station's card, beside *Move pin* | Arms the mode for that station: the panel bottom left of the map, its features listed, and the map taken to the site. |
| **📌 Site features on the map** in the station editor, beside *Move pin on map* | The same. |
| The station card's **Site features** section | What is mapped there, a row each; a row shows its feature on the map. |
| 🗺️ **Map display → Site features (📌)** | Every station's features in view, from zoom 16. On unless switched off; remembered. |

All of it is for **signed-in editors**. Signed out there is no pill, no section
and nothing drawn, and nothing is asked of the database — where a benchmark is,
and where a line runs that somebody might dig through, are not for the open
internet, the same call `0060` made for the levels.

## The kinds

| Kind | Shape | Drawn as |
|---|---|---|
| Orifice outlet | point | a ringed dot — where the line ends and the water is read |
| Inspection pit | point | a crossed square, the plan symbol for a pit |
| Benchmark | point | a triangle, the survey mark's |
| Gauge board | point | a staff with its metre marks |
| Crest gauge | point | a diamond |
| Other point | point | a dot — **needs a name** |
| Orifice run | line | blue, in a dark casing |
| Cable run | line | orange, dashed |
| Other line | line | white, dotted — **needs a name** |

The list is `meganet.station_feature_kind`: a new kind is an insert there, and
the app offers it without a release, drawn as a plain dot or line until it is
given a shape of its own in `site-features.js` (`SITE_FEATURE_KINDS`).

## Mapping a station's features

1. **📌 Site features** on the station's card. The card gives way to the panel,
   as it does to Move pin, and the map goes to the site — from zoom 18, beside
   the panel rather than under it. A draw tool, the link budget's pick, What is
   here and a pin being moved all let go of the map first.
2. **Add** — pick the kind and press **Put it on the map**.
   - **A point**: click the map where it is. Drag it, or click again, to move
     it. Or stand on it and press **📍 Use my position** — the fix's ± is kept
     with it, and a fix worse than ±100 m places nothing. Or type its latitude
     and longitude (a pair pasted into either box is split between them).
   - **A line**: click each point along it — from the shelter, through each
     pit, to the outlet. A click within 14 px of the station's pin or one of its
     points lands on it exactly, so a run drawn through its pits passes through
     them. **Double-click**, **Enter** or **✓ Finish the line** ends it;
     **Backspace** or **↶ Last point back** takes a point back. **📍 Add my
     position** adds where you are standing as the next point — walk the line
     and add a point at each pit.
3. Once a line is finished its points are handles: drag one to move it, drag
   (or click) a **＋** between two for a point there, click a point to pick it
   and press **Delete** (or **✕ Take out point**) to take it out. **＋ Carry on
   from the end** draws on.
4. **Points as coordinates** is the whole line as text, a point a line,
   latitude then longitude — type over it or paste a survey's coordinates in,
   in decimal degrees or degrees, minutes and seconds, and press **Use these
   points**. A pair whose first number cannot be a latitude is read the other
   way round. This is the keyboard's way to draw a line.
5. Give it a **name** (optional, but *BM1* is how it is found again — and an
   *Other* has to have one) and a **note**, and press **Save**.

**Escape** does one thing at a time: finishes the line being drawn (or lets go
of one with fewer than two points), then puts the draft down — asking first if
it has changed — then closes the mode. On a phone the panel folds itself to its
head and its Save while a feature is put on the ground (▾ / ▴ fold it by hand),
and the digital twin's offer at close zoom waits until the mode is closed.

Pick a feature in the list to show it on the map; **Edit** opens it. **🗑
Delete** asks first. **⬇ GeoJSON** downloads the station's features with the
station's own pin, as `floodnet-site-features-<station>.geojson`, for QGIS or
Google Earth — with how each was placed, and nobody's address.

Outside the mode, a feature clicked on the map says what it is, how far it is
from the pin, how it was placed and when it last changed, with **✏️ Edit on the
map**.

## How a position was placed

Saved with every feature, because a pit dropped on 20 cm imagery and one stood
on with a phone are different claims:

| `placed` | Means |
|---|---|
| `map` | clicked or dragged on the map |
| `gps` | the device's own fix; `accuracy_m` is its ± |
| `typed` | typed or pasted coordinates |
| `mixed` | a line some of whose points came one way and some another; `accuracy_m` is its worst GPS point's ± |

The map is only as good as its imagery: the State's aerial program is 10–20 cm
in the towns and coarser in the country, and the topo base is not imagery at
all. Pick **Satellite** in Map display before placing anything by eye.

## Two people at once

A save carries the stamp the feature was read with, and the database refuses
it if somebody has changed the feature since (`PT409`). The panel says so, keeps
what you drew, and offers **Reload** — which opens their version to make your
change on again. Deleting works the same way. Two new features never collide.

## What the database keeps

`db/migrations/0061_station_features.sql`:

- **`meganet.station_feature_kind`** — the kinds above: key, label, `Point` or
  `LineString`, whether it needs a name, order and a sentence. Public, like
  every vocabulary.
- **`meganet.station_feature`** — one feature: station, kind, name, note,
  `geom` (GeoJSON, longitude first, WGS84, seven decimal places), `placed`,
  `accuracy_m`, who added it and when, who last changed it and when, and a soft
  delete (`deleted_at`, `deleted_by`). **Editors only** (RLS): a signed-in
  editor reads the live rows; nobody signed out reads anything.
- **`meganet.save_station_feature(jsonb, timestamptz)`** — add (no id: needs
  the station, the kind and the geometry) or change (the id and the stamp it was
  read with; what it does not mention stays as it was). Refused in words: a
  geometry that is not a point or a 2–500-point line going somewhere, a kind
  that is not one or is the other shape, an *Other* with no name, a key it does
  not know, a deleted station, or a point more than **10 km** from the
  station's pin — the wrong station's map, not a far benchmark. A ± sent with a
  position that was not a GPS fix is dropped. A save that changes nothing
  writes nothing.
- **`meganet.delete_station_feature(uuid, timestamptz)`** — soft delete, with
  the stamp; deleting one already gone answers its tombstone.

`tools/check_station_features.sql` holds all of it against a real database (64
checks, in CI's `db-checks` job); `npm run sitefeatures` drives the tab in a
browser against a stand-in.

**Applying it.** `0061` is applied to the live database the way every
migration is (`db/README.md`), after `0053`–`0060`. Until it is, the card and
the panel say *This database has no site features yet — 0061 is not applied*,
and the map draws nothing; nothing else changes. A feature deleted by mistake
is restored by hand:

```sql
update meganet.station_feature set deleted_at = null, deleted_by = null
 where id = '<the feature''s id>';
```

## Where, not how high

A level survey (`0060`) records a benchmark's and a board's **level**, adopted
by an administrator; this records where they **are**, mapped by any editor. The
two meet on the name — BM1 is BM1 in both — and neither is worked out from the
other.

## Not yet

- The features are drawn on the flat map, not in ⛰️ 3-D or the digital twin.
- Mapping needs a signal to save: a feature drawn with none stays on screen
  until Save goes through, but is not kept on the device the way a level survey
  is.
