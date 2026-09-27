# Field photos

Photos from the field, **filed by where they were taken** — and then shown
there: a 📷 marker standing on the ground in the **Digital Twin** where the
photographer stood, turned the way the camera faced; a pin on the **Stations
map**; and the **Field Photos** tab, where they come in by the handful, by the
folderful, or on their own from a Dropbox folder. Every one of those opens the
same viewer: a carousel over the photos taken at that spot, with when, where,
which way and how each of those was known.

It is `photo-meta.js` (reading a photo), `field-photos.js` (the tab and the
viewer), `map-photos.js` (the map's layer), the twin's markers in
`digital-twin.js`, `db/migrations/0035_field_photos.sql` (the table and its
three doors), `tools/storage_bucket.sql` (the private bucket) and
`tools/field-photos/` with `.github/workflows/field-photos-dropbox.yml` (the
Dropbox sync). `npm run photos`, `tools/check_field_photos.sql` and the sync's
own tests hold it (see the end).

---

## Getting photos in

### Dropped on the tab

**Field Photos** is under *Site visits*. Signed in as an editor, the top panel
takes photos three ways — dropped on it, *📷 Choose photos* (any number), or
*📁 Choose a folder* (everything in it, subfolders included). JPEG, PNG, WebP
and HEIC, up to 24 MB each (`meganet.attachment_type`, the same list and the
same limits the inspection forms' attachments use); anything else in a folder
is left out, and the line under the drop zone says how many.

Each file is **read before anything is sent**, one at a time — a phone photo is
~50 MB of pixels decoded, and two at once on a phone is how a tab gets killed:

1. its **SHA-256**, of the file as it arrived;
2. what the file says about itself — EXIF and XMP, read by `PhotoMeta.read`
   without decoding a pixel;
3. if that holds no position (or no time), what the picture *shows*: the
   overlay a field camera app printed on it, read by OCR;
4. the **station** it is of — the nearest within a kilometre;
5. a 480 px **thumbnail**.

Then **nothing happens until somebody presses Upload.** A position read off a
picture is a reading, and the table under the drop zone is where it is
checked: each row says where the position came from (*camera GPS*, *read off
the photo*, *placed by hand*, *at the station*), flags one the OCR read only
once (*read once — check it*), and has *Change…* for one that is wrong or
*Place it…* for one nothing could place — paste coordinates in any of the
forms the Stations search reads (`-27.5543, 152.2741`, `27°33'15"S 152°16'27"E`
and so on), pick a station round it, find one by name or number, or say
*No station*. A photo nothing can place still uploads; it lands in
*Unplaced*, and is placed from there later.

**The same photo twice is one photo.** Twice in one drop, the second is
refused before it is read further. Already in MegaNet, the upload asks the
database by hash first and sends nothing: *Already in MegaNet — added by …
on …*, with *Show it*. If two people race, the database's own unique index
refuses the second and the objects it sent are taken down again.

**HEIC.** A HEIC is converted to a JPEG before it goes up — a photo stored as
something Chrome cannot show is a photo half the crew cannot see. Safari draws
HEIC and converts it itself. Chrome and Firefox cannot draw one at all, so for
the first HEIC of a session the tab fetches a decoder — libheif built to
WebAssembly (`libheif-js` 1.23.2 from unpkg, about half a megabyte, LGPL-3.0),
run in a worker and let go after a quiet minute — and from the picture on it is
the same as in Safari: the thumbnail, the OCR if the file has no position, the
JPEG. It draws the file's primary image, turned and mirrored as the HEIC says,
which is how every HEIC reader goes. A session with no HEIC never fetches it.
If it cannot be fetched (offline, or a network that blocks unpkg) the photo is
refused with that reason and the other ways round it: on an iPhone,
*Settings → Camera → Formats → Most Compatible* saves JPEGs; or put the HEICs in
the Dropbox folder, where the sync converts them. The hash is always of the file
as it arrived, so the same HEIC dropped twice is still one photo.

### From Dropbox, on their own

Photos saved into a linked Dropbox folder are imported by a scheduled GitHub
Actions workflow about every fifteen minutes, read by the **same**
`photo-meta.js` — EXIF first, then the overlay by OCR — and filed exactly as a
dropped photo is. The panel at the foot of the tab says when it last ran,
whose Dropbox it read, and what it did. *Linking a Dropbox folder* below is
the setup, click by click.

---

## Where a photo was taken

In this order; the first that answers wins, and the record says which it was
(`placement`).

### 1. The camera's own GPS — `exif`, `xmp`

The GPS block of the file's EXIF, in any of the containers a camera writes: a
JPEG's APP1, a HEIC's `Exif` item (wherever its `iloc` puts it — in the file or
in `idat`), a PNG's `eXIf` chunk, a WebP's `EXIF` chunk; either byte order.
From it: the position, its accuracy (`GPSHPositioningError`), the altitude,
the direction the camera faced and whether that is true or magnetic
(`GPSImgDirection`, `GPSImgDirectionRef`), the datum, and the GPS clock. Then
XMP — `exif:GPSLatitude` for a photo that has been through an editor, and a
DJI drone's own tags (`drone-dji:GpsLatitude`, and `GpsLongtitude`, which is
how some firmware spells it), where the **gimbal's** yaw and pitch are the
camera's heading and tilt, not the aircraft's.

A fix of (0, 0) is no fix, and a latitude without a longitude is no position.

### 2. The overlay on the picture — `ocr`

A photo that has been through Messages, WhatsApp, an email or most chat apps
has **lost its EXIF and kept its overlay** — the burnt-in panel a field camera
app draws. That is the case this exists for. The two photos this feature was
built from are Solocator's:

```
242°SW (T) -27.554294°, 152.274116° ±4m ▲ 134m (HAE)
BoM-FWIN
Gatton   2026-06-24, 12:26:08 AEST
```

and the parser reads the other forms field apps print as well: GPS Map
Camera's `Lat -27.554294° Long 152.274116°` with a day-first date and
`GMT +10:00`; Timestamp Camera's degrees, minutes and seconds; NoteCam's
hemisphere-first `S 27.554294 E 152.274116`; labelled `Latitude:` /
`Longitude:`; an **MGA or UTM grid reference** (`MGA56 E 431234 N 6951234`,
`56J 431234 6951234`), converted by Krüger's series to the millimetre; a
heading as `242°SW (T)` or `Heading: 242°`; accuracy as `±4m` or
`Accuracy: 4 m`; altitude with its datum (`HAE`, `MSL`, `AHD`); and a time as
`2026-06-24 12:26:08`, `24/06/2026 12:26 PM`, `24 Jun 2026 12:26` or
`Jun 24, 2026 12:26 PM`, with its zone where one is printed.

**How it is read.** Tesseract.js (7.0.0, the English model), fetched only when
a photo needs it — ~7 MB, once a session, and let go after a quiet minute.
Overlays sit in a band across the top or the bottom, so those are what is
read, not the picture: each band cut out, scaled to a width the engine reads
well, and made into a few black-on-white versions — a grey one with its
contrast stretched, and one keyed to the colour of the overlay's panel
(Solocator's green bar, say), which is what separates white text from a
bright sky. Each version is one *pass*. After the first reading that finds a
position, the line it is on is cut out and read again on its own, because a
second reading that agrees is the whole difference between "read" and "read
right".

**Readings are voted, not trusted.** A position is only *high* confidence when
two readings agree on it to a metre; one reading is *medium*, and *low* where
it had to be repaired — a decimal point the OCR lost put back where it gives
both halves the same precision, a sign it had to guess (a bare `27.55, 152.27`
is taken to be south, where the network is, and says it guessed). A heading
has to agree with the compass word printed beside it, to within a point and a
half — which is what stops a latitude followed by `S` being read as a heading
due south, or a compass ribbon's bare `300 NW 330` being read at all. The OCR's
usual confusions are undone before any of that: `(T)` read as `(1)`, `±` as
`+`, `▲` as `A`, a degree sign as a nought. On the two Solocator photos it is
four passes each, both positions carried by two readings, a few seconds a
photo.

Every reading's text is kept with the photo (`meta.ocr`), because what the
OCR saw is part of the record — and the viewer says how sure it was.

### 3. By hand — `manual`, `station`

Coordinates typed or pasted, in the queue before upload or in the viewer
afterwards (*Move…*, or *Place it…* for an unplaced one); or a station, which
puts an unplaced photo at the station's own position (`station`) and files a
placed one under it without moving it.

### The station it is filed under

The nearest station with a position within **1 km**, worked out by the
database (`meganet.field_photo_station_for`) when the photo is indexed, and
shown in the queue before that by the same rule. A station somebody chose is
kept and not replaced by distance, and so is *No station*. A photo moved later
is filed again by distance if its station was only ever picked by distance —
or if it had no place at all until now, since nobody can have filed it
anywhere.

### Which way, and when

**The heading** is the direction the camera faced, clockwise from north, true
or magnetic as the source says (Solocator's `(T)` is true). It turns the
camera on the twin's marker and the cones on the map's pin.

**The time** is kept twice: as the camera's own clock read it (`taken_local`)
and as an instant (`taken_at`). The zone is the one the file wrote
(`OffsetTimeOriginal`); failing that, the difference between the camera's
clock and the GPS clock, to the quarter hour; failing that, the one printed on
the overlay (`AEST`, `GMT+10:00`); failing that, **the zone of where it was
taken**, with daylight saving by date — Queensland keeps none, New South
Wales does. The border between the two is a sketch good to a few kilometres,
so a summer photo from right beside it, with nothing else to go on, can be an
hour out; a time whose zone was assumed says so wherever it is shown.

**The altitude is shown, never used.** Phones and apps disagree about its
datum — Solocator prints height above the ellipsoid (`HAE`), about 40 m off
AHD around Gatton — and the marker in the twin stands on the twin's own
ground.

**Nothing a photo did not say is recorded as nought.** A photo with no pitch
is not one held level, and one whose lens is unknown has no field of view:
those columns stay null, and nothing is drawn for them.

---

## Seeing them

### The Field Photos tab

Below the drop zone, the library: newest first by when they were taken, sixty
at a time, each thumbnail fetched through a link signed for an hour — a page
of them in **one** request. *All*, *Unplaced (n)*, *From Dropbox*, and *At*
a station (the station card's *📷 Field photos →* pill opens the tab filtered
to it).

**The viewer** is one dialog for every door. ← → (or swipe) through the photos,
Home and End, the strip of thumbnails under it; Escape or × closes it and the
focus goes back where it came from. Beside the picture: when, where (and how
that was known, and how sure), facing, altitude, the station and how far and
which way from it, the file, who added it. An editor can caption it, move it,
file it under another station, and remove it — which deletes the picture, not
just hides it, and keeps a tombstone so the Dropbox sync never brings it back.
*Open the original*, *On the map* (zoom 16 on the spot), *In the twin* (the
twin on its station, the camera standing behind the photographer looking the
way they looked).

### On the Stations map

A 📷 pin where each photo was taken, from zoom 12: a dot on the exact point, a
badge standing up off it with the count, and **a cone for each way the cameras
faced from there** — the two Solocator photos were taken from one spot six
seconds apart, up the reach and down it, and are one pin with two cones.
Photos within 3 m of each other are one spot; pins that would overlap on
screen merge. Click one for the carousel. *🗺️ Map display → Field photos*
switches the layer, and the note under it says how many are in view.

The pins sit over the network's canvas and under the station pins: over the
canvas because a full-map `<canvas>` takes every click that lands on it, under
the pins because a photo taken beside a station must never cover the station.

**Tilted (⛰️), the same pins stand on the terrain** — the dot on the point and
the cones laid flat on the ground, both still under the station pins, and the
badge standing up off the point so the count reads at any angle. Click the
badge, or Tab to it and press Enter, for the same carousel. The 3-D view draws
what this layer drew and asks for no photo of its own, so the same three things
leave it empty — signed out, zoomed out past 12, the switch off — and the same
note says which. They are the photos around the middle of the view: the flat
map under the 3-D one follows the camera, so a photo out towards the horizon is
drawn once the camera goes to it.

### In the Digital Twin

Where somebody stood with a camera, drawn where they stood: a post at chest
height (1.45 m) on the ground of the twin's own patch, a camera on it turned
and tilted the way the photo was taken, a pale wedge the width of its view on
the ground ahead of it — one for each way the cameras faced from there — and a
badge over it with the count, which grows with distance so it can be found
from across a 1.6 km patch. **Click it**, pick it from the line under the
stage (*📷 Field photos (3): 2 120 m NW · 1 25 m NE · all 3*), or **walk up to
it in the POV** — *📷 2 photos taken here — Enter to look* — and press Enter.
The same markers stand in the twin inside the Stations map. They are not in
the `.glb`: the scene there is the site, and a photo's position is not
something to hand to a file.

---

## Who can see them

**Editors, signed in — nobody else.** The pictures, and where they were taken,
are in a private bucket (`field-photos`) and only ever shown through a link
that expires; the rows are readable only by a signed-in editor (0035's policy),
and anonymous has no grant at all. A site photo shows its access, its padlock
and often a colleague, and its coordinates are as much a disclosure as its
pixels. Signed out, the tab says so, and the map and the twin draw nothing.

Every object is named by the app, `photo/<uuid>.<ext>` and
`photo/<uuid>.thumb.jpg` — never the camera's `IMG_0042.jpg`, which would make
a private bucket a guess away from public. Writes go through three
`security definer` functions (`add_field_photo`, `update_field_photo`,
`remove_field_photo`), not a grant: they enforce the path, the type and size
against `meganet.attachment_type`, one live photo per SHA-256, one row per
Dropbox file (tombstones included), and stamp who did it. The bytes go up
first, then the row that points at them, and a refused row takes its bytes
down again.

---

## Linking a Dropbox folder

About ten minutes, once. It needs someone who can sign in to the Dropbox
account whose folder will hold the photos, and someone who can add secrets to
this repository on GitHub.

### Which folder

The sync reads **one folder and everything under it**. Two ways to set that
up; the first is the one to use unless you need the second.

- **An app folder (recommended).** The Dropbox app you create below gets a
  folder of its own, `Apps/<the app's name>` in the account's Dropbox, and can
  see nothing else. Crews save or share photos into it — from the Dropbox
  phone app (*＋ → Upload photos*, into that folder), or by sharing the folder
  with their own Dropbox accounts and saving into it.
- **A folder elsewhere in the Dropbox** — the account's *Camera Uploads*, say,
  or the folder a camera app uploads to by itself. That needs the app created
  with *Full Dropbox* access, and the repository variable `DROPBOX_FOLDER` set
  to the folder (below). Everything in that folder is imported, so make it a
  work folder, not a personal camera roll.

### 1. Create the Dropbox app

1. Sign in to Dropbox as the account that will hold the photos, and open
   <https://www.dropbox.com/developers/apps>.
2. Press **Create app**.
3. *Choose an API*: **Scoped access**.
4. *Choose the type of access you need*: **App folder** (or **Full Dropbox**,
   see above).
5. *Name your app*: something unique, e.g. `MegaNet Field Photos` — with App
   folder access this is also the folder's name, `Apps/MegaNet Field Photos`.
6. Press **Create app**.
7. On the app's page, open the **Permissions** tab, tick
   **`files.metadata.read`** and **`files.content.read`**, and press
   **Submit** at the foot of the page. (`account_info.read` is ticked already;
   leave it — the tab uses it to say whose Dropbox the sync reads.)
8. Open the **Settings** tab. Under *OAuth 2*, check that *Allow public clients
   (Implicit Grant & PKCE)* says **Allow** (it does by default). Copy the
   **App key** — you need it twice below. You do not need the app secret, and
   nothing here asks for it.

The app can stay in *Development* status: it is only ever used by the one
account that created it.

### 2. Get a refresh token, from the Field Photos tab

1. In MegaNet, sign in, open **Field Photos**, and at the foot of the tab under
   **From Dropbox** open **Link a Dropbox folder**.
2. Paste the **App key** into the box in step 1 of that list.
3. Press **Open Dropbox to allow access ↗**. A Dropbox page opens in a new tab:
   check it names your app, sign in as the account from step 1 if asked, and
   press **Allow**.
4. Dropbox shows an **access code**. Copy it, come back to MegaNet's tab, paste
   it into step 3 of the list, and press **Get the token**.
5. *Linked.* — the **refresh token** is shown, once. Press **Copy**.

The token is not stored anywhere in MegaNet — not in the database, not in the
browser. The exchange is PKCE, Dropbox's flow for an app that cannot keep a
secret, which is why the app secret is never needed. A code is single-use and
expires in minutes; if it is refused, press *Open Dropbox…* again for a new
one.

### 3. Give GitHub the three secrets

1. On GitHub, open this repository → **Settings** → **Secrets and variables** →
   **Actions** → the **Secrets** tab → **New repository secret**.
2. Name **`DROPBOX_REFRESH_TOKEN`**, value the token from step 2 → **Add
   secret**.
3. **New repository secret** again: **`DROPBOX_APP_KEY`**, the app key.
4. And **`SUPABASE_SECRET_KEY`**: in the Supabase dashboard, open the MegaNet
   project → **Project Settings** → **API Keys** → under *Secret keys*, reveal
   and copy the secret key (`sb_secret_…`; on a project still on the legacy
   keys, the `service_role` key). This is the one credential that can write
   past the editors-only rules, which is why it lives only in this workflow's
   secrets and nowhere else in the repository.
5. *Only if you chose a folder other than the whole app folder*: the
   **Variables** tab → **New repository variable** → **`DROPBOX_FOLDER`**, the
   folder's path as Dropbox shows it, starting with `/` — e.g. `/Field photos`
   (a folder inside the app folder) or `/Camera Uploads` (with Full Dropbox).

### 4. Run it

**Actions** → **Field photos from Dropbox** → **Run workflow** → **Run
workflow**. When it finishes (a minute or two; longer for a big first import),
refresh the Field Photos tab: the panel at its foot says *Working — last ran …,
reading …'s Dropbox*, and the photos are in the library. From then on it runs
every fifteen minutes on its own.

Before the secrets exist the workflow does nothing, every fifteen minutes, and
says so in a notice rather than failing.

---

## How the sync runs

Each run (`tools/field-photos/sync.mjs`, one Node process on a GitHub runner):

1. **Where the last run got to** — a Dropbox cursor, kept in
   `meganet.field_photo_sync_cursor`, which only the secret key can read.
2. **What is new since**, in the folder and every folder under it, oldest
   first. Photos only (`.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`, `.webp`).
3. **What came in before** — asked a hundred files at a time — is skipped: an
   imported photo is not imported twice, and **a photo removed from MegaNet is
   never brought back** (its tombstone keeps the Dropbox file id).
4. **Each photo left**: downloaded; read by `photo-meta.js` exactly as the tab
   reads one (a HEIC decoded and converted to JPEG here, by the same libheif
   the tab fetches in a browser that cannot draw one); skipped if the same
   bytes are already in MegaNet (somebody
   dropped it in by hand); the photo and a thumbnail uploaded; indexed through
   `meganet.add_field_photo()`, which files it under the nearest station and
   refuses what it must — a refused photo's objects are taken down again.
5. **The cursor moves on only when every photo in the listing was dealt with.**
   A run stops after 150 photos or ten minutes, whichever is first, and the
   next run carries on from the same listing; photos it has already imported
   are skipped and never count against that cap, so a first import of
   thousands is worked through, run after run, and never lost.
6. **What it did** goes in `meganet.field_photo_sync`: when it ran, whose
   Dropbox, how many seen, imported (and of those unplaced), skipped, failed,
   and the last error — which is what the tab's panel reads. The run's own
   log (Actions → the run) lists every file and what happened to it.

A photo the sync could not place is in *Unplaced* like any other.

**Why a scheduled workflow and not a server.** The job is "look at a folder
now and then", and GitHub already runs things now and then for this
repository: nothing to host, a log of every run, and *Run workflow* for an
import right now. A photo waits at most a quarter of an hour. Dropbox can call
a webhook the moment a file lands, and a route on the Worker could start the
workflow from it — a refinement for later, not a reason to have a server.

---

## The schema

`db/migrations/0035_field_photos.sql`; `db/README.md` has the table list.

| | |
|---|---|
| `meganet.field_photo` | one row per photo: the object and its thumbnail, the file (type, size, SHA-256, pixels), title and caption, when (local and instant, and from what), where (lat/lon, how placed, accuracy), altitude and its datum, heading and its reference, pitch, field of view, the station (and whether by distance), `meta` (the camera, the OCR's readings, the Dropbox file), where it came from (`upload`, `dropbox`) and who added it; soft-deleted |
| `meganet.field_photo_origin`, `meganet.field_photo_placement` | the two vocabularies |
| `meganet.field_photo_sync` | the sync's report, one row per source |
| `meganet.field_photo_sync_cursor` | where the sync got to — RLS on, no policy: the secret key only |
| `add_field_photo(p_photo jsonb)`, `update_field_photo(p_id, p_patch jsonb)`, `remove_field_photo(p_id)` | the three doors |
| `field_photo_station_for(p_lat, p_lon, p_within_m default 1000)` | the nearest live station within a distance |

The bucket, `field-photos`, private, 25 MB an object, editors only for all
four operations, is `tools/storage_bucket.sql` — run once per project, after
the migration, like 0010's.

## What the network has to allow

| Host | For | Notes |
|---|---|---|
| `unpkg.com` | the OCR engine, once a session, only for a photo with no GPS; the HEIC decoder, once a session, only for a HEIC the browser cannot draw | already allowed for Leaflet, MapLibre and three.js |
| `*.supabase.co` (or the `/api/db` proxy) | the rows, the bucket, the signed links | already allowed |
| `www.dropbox.com`, `api.dropboxapi.com` | linking Dropbox, once, from the tab | only for whoever sets it up; the sync itself runs on GitHub |

## The checks

- **`npm run photos`** (test/) — `photo-meta.js` under Node against photos
  built byte by byte and the overlay formats above, then the app in Chromium
  against a fake project with the real OCR engine and the real HEIC decoder:
  eight files dropped at once and read, one placed by hand, the upload's order
  and records, the same photo refused three ways with its bytes taken back
  down, the library, the carousel by keyboard, Dropbox's PKCE link end to end,
  the map's pins and cones, the same pins tilted into 3-D and pressed there,
  the twin's markers on the ground, clicked and walked up to — and a real HEIC,
  which Chromium cannot draw, decoded, placed from its EXIF and uploaded as a
  JPEG whose pixels are the picture.
- **`tools/check_field_photos.sql`** — 0035's own rules against a real
  Postgres: the path and type rules, one live photo per hash, one row per
  Dropbox file, the nearest station and when it is picked again, who may read
  what (an editor, a stranger, anonymous, the secret key).
- **`tools/field-photos`: `npm test`** — the sync against a fake Dropbox and a
  fake project, with the real reader and the real OCR engine: a photo read off
  its overlay, one placed by its EXIF without the OCR asked, the second run
  importing nothing, a removed photo not brought back, a refused row's bytes
  taken down, a backlog worked through run after run, a reset cursor, a bad
  token.
