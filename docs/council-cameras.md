# Flood and road cameras — the councils' and QLDTraffic's

Most Queensland councils put cameras on the crossings that flood — a camera on
a pole at a causeway, a bridge or a gauge board, its picture replaced every few
minutes — and publish them on their disaster dashboards, often beside the TMR
road cameras that matter to them; and Transport and Main Roads publishes its
own flood cameras on QLDTraffic. Flood-Net draws every one of those cameras on
the Stations map, and a press on one brings up its latest picture and how old
that picture is.

- **The layer** — *Flood & road cameras (councils, QLDTraffic)* in **Map display**: a
  near-black tile with a white camera on it, a **blue** stripe along its foot
  for a flood camera and **amber** for a road camera. Cameras that would
  overlap are one tile with a count. On by default, for everybody, signed in
  or not, from zoom 8 (a view about 300 km across). `map-cameras.js`.
- **The viewer** — the camera's latest picture; *Updated 1:17 pm — 12 minutes
  ago, by the camera's server*; a warning when the picture is more than three
  hours old; the council's dashboard a link away; the Flood-Net station it
  stands at (within 250 m) or the nearest within 2 km; the council's own note
  about the camera; and what a picture cannot tell you. A camera that looks
  several ways has a button for each; a pin of several cameras has one for
  each camera.
- **The station card** — *Flood & road cameras at this station*, under the flood
  classes: the cameras within 2 km, nearest first, each a press away from its
  picture. Nothing at all for a station with none.

A quarter of the cameras stand within 250 m of a Flood-Net station, and nearly
a fifth within 100 m: the council is watching the same crossing the gauge is.
The rest are crossings Flood-Net has no gauge at — 28 of the 38 that only
QLDTraffic shows have no station within a kilometre.

## Where the list comes from

Most of the councils' dashboards are one product — QIT Plus's **Guardian IMS**
— and every one of them answers the same request the same way:
`GET <dashboard>/dashboard/getCameras` is the GeoJSON behind the dashboard's
own *Flood Cameras* page and its map. Public, no key, no sign-in. QIT Plus keeps
the list of its dashboards on a public ArcGIS layer (the one
[dashboards.qitplus.com](https://dashboards.qitplus.com/) draws), with each
council's boundary.

`tools/council_cameras.py` reads that list and then each dashboard's cameras
into **`data/council-cameras.json`**: for each camera, where it stands, what the
council calls it, flood or road, the addresses of its pictures (two or three for
a camera that looks several ways, named the way the council named them —
*North*, *Gauge Board Zoomed*), which way it faces where the council says, and
the council's note. Never a picture. About 70 requests, one at a time, under a
User-Agent that names Flood-Net and points here.

The same run reads **TMR's own flood cameras** from QLDTraffic —
`data.qldtraffic.qld.gov.au/floodcameras.geojson`, the keyless feed QLDTraffic's
site reads, the same data as its documented API, which licenses it CC BY 4.0
(#238 found it). About 120 cameras on causeways and bridges. Two-thirds of them
are already on a council's dashboard — at the same address, or the dashboard's
own copy of TMR's picture at another — and those stay one camera, the council's,
credited to TMR and on TMR's address (below); the other 38 are crossings no
council shows. QLDTraffic is listed among the councils, marked as an agency, so
the viewer says *Shown by QLDTraffic* and links to its site rather than to a
disaster dashboard.

`.github/workflows/council-cameras.yml` runs it weekly and commits straight to
main when something changed (a week with no change writes nothing, so
`meta.generated` is when the list last changed). Cloudflare deploys on the push,
which is what puts a new camera in the Worker's reach as well as on the map.

**As at 27 October 2026**: 596 cameras (510 flood, 86 road; 683 pictures) from
49 councils — 47 in Queensland, and Byron and Hawkesbury in NSW — and
QLDTraffic. Lockyer Valley's dashboard shows 27 of them.

| | Councils |
|---|---|
| Answered with cameras | 49 |
| Answered with none | 11 — Ashburton, Ballina, Banana, Blackall-Tambo, Blue Mountains (its seven are Live Traffic NSW web pages, below), Bulloo, Longreach, Palmerston, Paroo, Port Hedland, Tablelands |
| Did not answer | 7 — Barcaldine, Central Highlands, Murweh and Winton (404: an older dashboard with no camera list), Barcoo (a certificate nothing can verify, and no plain http), Redland and Weipa (not this platform's answer) |

The pictures themselves live on the councils' servers and their vendors':
QLDTraffic (~200), Envault (~180), Disaster Watch (~150), Sightmaster (Ipswich,
35), Valora, Spectur, QTEQ, Flood Monitor Australia, Toowoomba's and Somerset's
own servers, Transport for NSW, Airservices Australia's airport weather
cameras, and a handful more.

### What the tool leaves out, and why

- A feature with no point, or a point outside Australia. A point typed
  latitude-first (one of Logan's) is turned the right way round instead.
- A picture address that is not http(s), and the hosts in `NOT_PICTURES`:
  files uploaded to the dashboard behind a signed link that expires
  (`ims-s3-upload…`), Live Traffic NSW's and QLDTraffic's web pages, and a
  parked domain.
- A council in `LEAVE_OUT` — empty today; a council that asks not to be shown
  is one line there.

An address a council typed into an HTML field (`&amp;` for `&`) is unescaped.

### One camera, several dashboards

The same picture on several dashboards — a TMR camera on a shared highway, a
Cape York camera every shire up there shows — is one camera. It is filed under
the council whose area it stands in (QIT Plus's boundaries, generalised to
~500 m), and the viewer names the others: *Shown by Lockyer Valley Regional
Council — and by Somerset Regional Council*. A camera's id is
`<council>-<the council's own number for it>` (`qldtraffic-<TMR's>` for one only
QLDTraffic shows), so it stays the same from week to week.

A QLDTraffic camera a council shows **from another address** — the Guardian IMS
dashboard's own copy of TMR's picture, or the council's own feed of a camera
TMR also shows — is found by where it stands and what it is called: within
30 m, and a word of the place's name in common (*Kilkivan*, *Foxton* — not
*road*, *creek* or *bridge*). It stays the council's camera, now named as shown
by QLDTraffic too, credited to TMR when the picture is TMR's, and a flood
camera whatever the dashboard called it. Where the council's address was the
dashboard's copy (`camera-custom-image…`), TMR's own address takes its place:
the copies fall behind — one was six weeks old while TMR's was minutes. One to
one and nearest first, so two TMR cameras on one bridge stay two.

### When a dashboard does not answer

A council whose dashboard does not answer keeps last week's cameras, with
`answered` saying when it last did, rather than vanishing from the map for a
week. And the tool refuses to write a catalog that has lost more than 30% of the
last one's cameras — QIT Plus moving the endpoint, say — so the job fails and
GitHub emails the owner, instead of quietly emptying the layer. `--force` writes
it once the loss is understood.

## Why the pictures are not stored

The question was whether Flood-Net should keep copies of the pictures, or rely
on the councils every time somebody looks. It relies on the councils.

**What storing would cost.** A frame is 15 KB (a QLDTraffic thumbnail) to 900 KB
(Envault's 2560 × 1480), about a quarter of a megabyte on average. Every picture
every 15 minutes is 683 × 96 × 0.25 MB ≈ **16 GB a day, ~490 GB a month**:

- R2's free 10 GB would be full in under a day. Paid, it is US$0.015 a GB-month
  — about US$90 a month after a year, and growing every month — plus about
  US$4.50 a month for the two million writes.
- Supabase Storage (100 GB on the Pro plan) would be full within the week; the
  database would hold the rows but has no business holding the bytes.
- And it would be Flood-Net re-hosting other people's pictures, which nobody
  has asked the councils about (below).

**What it costs not to.** Nothing in the database — no table, no rows, no
migration. The list is a 255 KB file (35 KB over the wire) read once a session.
Each picture opened is one Worker request (the Workers Free plan's 100,000 a day
are shared with every other route) and nothing stored but Cloudflare's edge
cache.

**What storing would buy**, and what Flood-Net goes without: a crossing's
history through an event (the peak, as it passed), a picture when the council's
server is down for longer than six hours, and a record afterwards. A bounded
version is possible later — keep a frame every 30 minutes only from the cameras
within 250 m of a Flood-Net station whose level is past its minor flood class
(river-details.js has the classes), and only for 90 days. Twenty cameras through
a five-day event is about 1.2 GB, inside R2's free tier. It wants a person's
decision first: whether the councils mind their pictures being kept.

## How old a picture is

A dry causeway in yesterday's picture is the most dangerous thing this layer
could show, so the viewer always says what it knows about the age, and never
more:

- Most cameras' servers say when their picture last changed (`Last-Modified`).
  The viewer says it in words, and past **three hours** says, in the warning
  colour, that the picture is old, the camera may be offline, and it does not
  show the crossing as it is now.
- Envault's do not. Most Envault cameras print the time on the picture itself
  (*Helidon: Creek_Crossing_Overview — 2026-10-27 13:17:51*), so the viewer says
  to read it there.
- One council marks its cameras *check image date*; the viewer passes that on.
- Every viewer says what a picture cannot: how deep or fast the water is,
  whether the road under it is still there, or whether the road is closed —
  check the council's dashboard. *If it's flooded, forget it.*

## The route: `/api/cameras/*`

`worker/cameras.js`, on the same Worker as the rest of `/api`:

```
GET /api/cameras            {cameras, councils, generated, catalog, fresh_s, keep_s}
GET /api/cameras/<id>       the camera's latest picture (its first view)
GET /api/cameras/<id>/<n>   the n-th view of a camera that looks several ways, from 0
```

- **Only the catalog's cameras**, by id. Nothing in the request names an
  address, so it is not a proxy anybody can point anywhere. The Worker reads
  the same committed file the map draws, through the static assets binding
  (`wrangler.toml`'s `[assets] binding = "ASSETS"`), the first time an isolate
  needs it.
- **A picture by its own bytes** — JPEG, PNG, GIF or WebP — whatever its server
  calls it (several say `binary/octet-stream`; one says `text/html` when the
  camera is down), no larger than 8 MB, within 10 seconds.
- **The camera's server asked at most once a minute** per Cloudflare location,
  however many people are looking: the edge cache's key is the camera and the
  view and nothing else, so a query string cannot make it ask again, and a
  burst in one isolate is one request. A council's dashboard is under the most
  load on the day this layer is most used.
- **The last good picture stands in for six hours** when the camera's server
  does not answer, marked `X-Camera-Stale` with the reason; the viewer says it
  is the last picture fetched, and when. After six hours, a 502 saying why.
- **Every answer**: `Last-Modified` (the camera server's), `X-Camera-Fetched`
  (when this route fetched it), CORS open with those headers readable — the
  github.io copy and local checkouts ask floodwarning.net — and the same
  `nosniff` and sandbox lock as `/api/photos`. A browser may keep a picture for
  what is left of its minute.

No per-caller limit: everything served is public, the council's dashboard
serves the same picture to anybody, and a flood of requests costs the Worker's
daily allowance exactly as it would on any other public route.

When the route cannot answer at all, the viewer shows the camera's own address
instead (with no referrer sent), and says that it cannot tell how old that
picture is.

## Whose pictures

The pictures are the councils' (and, for TMR's flood and road cameras,
Transport and Main Roads', whose QLDTraffic camera data is published as open
data under
[CC BY 4.0](https://www.data.qld.gov.au/dataset/131940-traffic-and-travel-information-geojson-api)).
The councils state no licence for theirs. Flood-Net shows each one as published
— not cropped, not altered, the council's logo left on — credited to the
council whose dashboard it came from (and to TMR, Transport for NSW or
Airservices Australia where the address is theirs), with the council's
dashboard a link away and nothing kept. That is the same thing the council's
own dashboard does with the same picture; if a council asks Flood-Net not to
show its cameras, `LEAVE_OUT` in the tool does it at the next run.

## Not covered yet

- Councils not on Guardian IMS — Brisbane, the Sunshine Coast, Redland (whose
  dashboard no longer answers this way), most of NSW — and the four Guardian
  IMS dashboards too old to have a camera list.
- The Blue Mountains' seven Live Traffic NSW cameras, which its dashboard lists
  as web pages rather than pictures.
- TMR's QLDTraffic **traffic** cameras (`webcameras.geojson`): hundreds, most
  of them motorway traffic. Its flood cameras are in; of its traffic cameras,
  the councils have already picked the ones that matter to a flood.
- QLDTraffic's flood **events**, closures and damaged bridges — #238's, which
  is that issue's remaining half.
- The tilted 3-D map, which does not draw these pins yet.
- The agent API (`/api/v1`): the cameras are not in it.

## Checking it

`cd test && npm run councilcams` — under Node, the route against stand-ins for
the assets, the edge cache and the cameras' servers, and the catalog held to
its shape; in Chromium, the layer, the viewer and the station card on the real
catalog, signed in to nothing (`test/README.md` has every assertion).

Running the tool by hand:

```bash
python3 tools/council_cameras.py                 # fetch and write data/council-cameras.json
python3 tools/council_cameras.py --dry-run       # fetch and report, write nothing
python3 tools/council_cameras.py --save-raw DIR  # keep every answer; --from-raw DIR rebuilds offline
```
