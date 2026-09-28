# Field photos

Photos from the field, **filed by where they were taken** — and then shown
there: a 📷 marker standing on the ground in the **Digital Twin** where the
photographer stood, turned the way the camera faced; a pin on the **Stations
map**; and the **Field Photos** tab, where they come in by the handful, by the
folderful, or on their own from a Dropbox or Google Drive folder. Every one of
those opens the same viewer: a carousel over the photos taken at that spot,
with when, where, which way and how each of those was known.

It is `photo-meta.js` (reading a photo), `field-photos.js` (the tab and the
viewer), `photo-zip.js` (a zip of photos, opened in the browser),
`photo-equipment.js` and `photo-review.js` (reading equipment labels, and the
Review panel where what came in and what the labels say are looked over),
`map-photos.js` (the map's layer), the twin's markers in `digital-twin.js`,
`db/migrations/0035_field_photos.sql` (the table and its three doors),
`db/migrations/0036_photo_review.sql` (the upload log, the equipment register
and its suggestions, and who is an administrator), `tools/storage_bucket.sql`
(the private bucket) and `tools/field-photos/` with
`.github/workflows/field-photos-dropbox.yml` and `field-photos-gdrive.yml` (the
Dropbox and Google Drive syncs). `npm run photos`, `npm run photozip`,
`npm run photoreview`, `tools/check_field_photos.sql`,
`tools/check_photo_review.sql` and the sync's own tests hold it (see the end).

---

## Getting photos in

### Dropped on the tab

**Field Photos** is under *Site visits*. Signed in as an editor, the top panel
takes photos three ways — dropped on it, *📷 Choose photos or zips* (any
number), or *📁 Choose a folder* (everything in it, subfolders included). JPEG,
PNG, WebP and HEIC, up to 24 MB each (`meganet.attachment_type`, the same list
and the same limits the inspection forms' attachments use), and **zips of
them** (below); anything else in a folder is left out, and the line under the
drop zone says how many.

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

**A zip of photos** — dropped, chosen, or found in a chosen folder, on its own
or among loose photos — is opened in the browser (`photo-zip.js`), not
uploaded. Every photo in it joins the list exactly as if it had been dropped
on its own — the same hash, the same reading, the same placing and upload, and
the same "the same photo twice is one photo" — with *from pack.zip* under its
name. The zip gets a line of its own above the list: how many photos it held,
and what was left out and why — *not a photo*, *encrypted*, *compressed with
Deflate64* (or bzip2, LZMA, zstd: anything but the stored and deflate every
zip tool writes by default), *a zip inside the zip*, *over 24 MB*. Folders,
`__MACOSX/`, dotfiles and `Thumbs.db` are the zip tool's, not the crew's, and
are counted rather than listed. A whole zip is refused, in a sentence, when it
is ZIP64 (over 4 GB or 65,535 files), one part of a split zip (`.z01`), holds
more than 2,000 files, or more than 2 GB of photos.

A zip is never believed about its own contents: each photo is unzipped no
further than the size the zip declares for it (a 42 kB file claiming to be a
3 MB photo stops at 3 MB, not at the 4 GB it would have become), and its
CRC-32 checked, so a damaged zip is a refused photo, not a photo with a grey
band across it. Nothing holds the zip's contents: the photos are unzipped one
at a time as the list reaches them, let go once read, and unzipped again to
upload — a pack of two hundred photos is never two hundred photos in memory,
which on a phone is the difference between working and the tab being killed.

### From Dropbox, on their own

Photos saved into a linked Dropbox folder are imported by a scheduled GitHub
Actions workflow about every fifteen minutes, read by the **same**
`photo-meta.js` — EXIF first, then the overlay by OCR — and filed exactly as a
dropped photo is. The panel at the foot of the tab says when it last ran,
whose Dropbox it read, and what it did. *Linking a Dropbox folder* below is
the setup, click by click.

### From Google Drive, on their own

The same, from a Google Drive folder — one in somebody's *My Drive*, or in a
Shared Drive — shared with the sync's own Google account: a second scheduled
workflow, the same run, the same `photo-meta.js`. *Linking a Google Drive
folder* below is the setup. In either folder a **zip of photos** is opened and
each photo in it filed as one of its own (*Zip packs in a linked folder*).

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
of them in **one** request. *All*, *Unplaced (n)*, *From Dropbox*, *From
Google Drive*, and *At* a station (the station card's *📷 Field photos →* pill
opens the tab filtered to it).

**The viewer** is one dialog for every door. ← → (or swipe) through the photos,
Home and End, the strip of thumbnails under it; Escape or × closes it and the
focus goes back where it came from. Beside the picture: when, where (and how
that was known, and how sure), facing, altitude, the station and how far and
which way from it, the file, who added it. An editor can caption it, move it,
file it under another station, and remove it — which deletes the picture, not
just hides it, and keeps a tombstone so the Dropbox sync never brings it back.
*Open the original*, *On the map* (zoom 16 on the spot), *In the twin* (the
twin on its station, the camera standing behind the photographer looking the
way they looked), and *🔎 Read equipment labels* (see *Reading equipment
labels*, below).

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

## Reviewing what came in

The **Review** panel on the Field Photos tab (`photo-review.js`) is where what
came in, and what the photos say about the equipment in them, is looked over.
Signed-in editors see all of it; deciding what the equipment register believes
is an administrator's (below). Three lists:

1. **From this browser** — the list under the drop zone as it stands: each
   file, the zip it came out of, where it got to, and what happened to it. It
   is this tab's memory and goes with a reload; the next list does not.
2. **Recent uploads** — the last two hundred attempts to bring a photo in,
   from every way in: the tab, the Dropbox sync and the Google Drive sync.
   When, who, the file (and the zip it was in), the outcome and why, the
   station it was filed under, and *Show it* for the photo it became. Counts
   per outcome over those two hundred; filter by outcome (*Imported*,
   *Unplaced*, *Already in MegaNet*, *Refused*, *Failed*, *Skipped*) or by way
   in — in the database, so *Failed* is the last two hundred failures, not the
   failures among the last two hundred attempts.
3. **Equipment suggestions** — what the photos' labels say is fitted at a
   station, waiting for an administrator (below); the ones already decided
   folded under them.

### Recording what became of each upload

Every attempt is a row in `meganet.field_photo_upload`, written through
`meganet.log_field_photo_upload(p_rows)`: the tab writes one per file when an
Upload finishes — *imported* (in MegaNet, placed), *unplaced* (in, but nothing
could place it), *duplicate* (already in MegaNet — the row points at the photo
that is), *refused* (the reader, or a rule in the database, said no — with its
words), *failed* (the upload did not finish; sending it again may work) — and
every file the reading refused that had not been recorded yet. The syncs write
one per file they tried, *skipped* included. One press of Upload, or one run
of a sync, is one `batch_id`.

**Best-effort, on purpose.** A log that cannot be written never fails the
upload it is about: the photo is in MegaNet either way, and the Review panel
says the log could not be written, and why. A row per attempt, not per photo:
the same file sent twice is two rows, the second saying *duplicate* — the log
is what happened, and `meganet.field_photo` is what is true now.

Kept for review, not for ever. `meganet.prune_field_photo_uploads()` deletes
rows older than 180 days (never less than a week, whatever it is asked); run
it from the SQL editor now and then — nothing runs it on a schedule, because at
a few hundred photos a month the table grows by a few megabytes a year.

### Reading equipment labels

**🔎 Read equipment labels** in the viewer reads one photo; *Station to read* on
the Review panel reads a station's photos, the newest sixty, one at a time; and
*Read equipment labels after upload*, a box under the drop zone (off unless
ticked), reads each photo just uploaded that was filed under a station. All
three are the same reader:

- **The whole frame, then its four quarters**, by the same OCR engine the
  overlay uses (`PhotoMeta.ocrLabels`) — the overlay's bands are the wrong
  place to look, a logger's label is in the middle of the cabinet, and small:
  the quarters are read at the photo's own resolution (enlarged when it is a
  small photo), where a serial number's print is still big enough to read. Six
  passes at most, a few seconds each — which is why it runs when somebody asks,
  never on every upload.
- **What the text says** (`PhotoEquipment.parse`, `photo-equipment.js`): a
  dictionary of what this network fits — ELPRO's ERRTS ERT-A2 and the
  115E/215U/415U/905U radios, Campbell Scientific's CR300 family (CR310,
  CR1000X, CR800, CR200X…), Beam's Iridium SBD modems, Kisters' HS40 and HS40
  Compact bubblers, Victron's SmartSolar and BlueSolar MPPT regulators,
  Hydrological Services' TB3/TB4 tipping buckets and their tip size, and the
  level sensors (OTT, VEGA, Druck, WaterLOG) — each filed under a kind the
  inspection sheets already use (`meganet.equipment_kind`: logger, modem,
  ert_a2, tbrg, solar_regulator …). The OCR's usual confusions are allowed
  for — `CR3OO` is a CR300, `9O5U` a 905U — and a reading that needed them is
  trusted less. A serial number is what follows `S/N`, `SN`, `Serial No`,
  `SER NO`, `Serial Number` or `IMEI` (and `S|N`, `SIN`, `5/N`, which is what
  OCR makes of `S/N`), on the label's line or the next; where a make's serials
  have a known shape — Campbell's and ELPRO's digits, Victron's `HQ` and nine
  more, an Iridium modem's fifteen-digit IMEI — lookalike letters are put back
  to digits. The same unit read in two passes counts for more; read with two
  serials a digit apart, the majority wins and the other is named in the
  evidence.
- **Proposed, never written.** Each candidate goes to
  `meganet.propose_equipment()` as `ocr`, with the text it was read from as its
  evidence and a confidence from 0 to 1. One already waiting, already on the
  register, or turned down before from the same photo is counted as known, not
  proposed again.

### Suggestions, and approving them

A pending suggestion shows the photo it was read off (click it for the
viewer), the text the OCR saw, **what the station's register says now**, and
the proposed kind, make, model and serial number. An administrator can
**correct any of them before approving** — the usual correction is a serial
digit the OCR misread — add a note, and approve or reject:

- **Reject** marks the suggestion and changes nothing else.
- **Approve** writes the station's equipment register
  (`meganet.station_equipment`) and marks the suggestion, in one transaction,
  keeping what was proposed and the corrections side by side. Where the unit
  goes: the same unit already on the register (same kind, same serial, however
  punctuated) is updated — the photo is fresher evidence of it; a unit of that
  kind whose serial was never known is taken to be this one and gets the
  serial; one other unit of that kind is taken to be the unit this one
  replaced — it is retired, pointing at the new one; with two or more of the
  kind (two solar panels) the administrator says which it replaces, or that it
  is *another one, alongside*, because a guess there retires the wrong one.
  Any other suggestion still waiting for the same unit is marked
  *superseded*.

The register keeps every unit ever known at a station; the live ones are on
the **station card** (Stations map → a station → *Equipment*), for signed-in
editors: kind, make and model, serial number.

### Administrators

Approving and rejecting are for an **administrator**: an editor whose row in
`meganet.app_user` says `role = 'admin'` (`meganet.is_admin()`, 0036 — the first
thing to read the role column 0005 created). Being an editor comes first: an
address taken off `meganet.editor_allow` stops being an administrator with it,
without anyone having to remember a second list. The service key is one, and
so is the owner at a `psql` prompt.

To make somebody an administrator, once they have signed in to MegaNet at
least once (which is what creates their `app_user` row), run this in the
Supabase dashboard's **SQL Editor** (or `psql`), with their address:

```sql
update meganet.app_user set role = 'admin' where lower(email) = lower('someone@bom.gov.au');
```

It says `UPDATE 1` when it found them, `UPDATE 0` when they have not signed in
yet. To take it away, the same with `role = 'editor'`. It takes effect on their
next request — the Review panel asks the database, not the sign-in token.

### The agent seam

`meganet.propose_equipment(p jsonb)` is the one door anything that thinks it
knows what is fitted at a station comes in by — the tab's OCR today, and later
an agent: a model reading the photos more carefully than Tesseract can, or a
script reading forty years of inspection sheets' serial numbers. What it sends:

```json
{ "station_id": "gatton",            "photo_id": "…or null",
  "equipment_key": "logger",         "make": "Campbell Scientific",
  "model": "CR300",                  "serial_no": "12345",
  "evidence": "the text it read, or its reason, in its own words",
  "confidence": 0.8,                 "proposed_by": "agent:label-reader" }
```

`station_id` may be left out when the photo is filed under a station; one of
make, model and serial number is needed; `evidence` is kept (2,000 characters)
and shown to the administrator deciding. Its proposals wait in the same list,
for the same decision — nothing an agent proposes is believed until an
administrator approves it. A collision (the same unit already waiting, already
on the register, or rejected before from that photo) is refused with `23505`
and the id of what it collided with, so an agent in a loop can count them.

**What an agent needs to call it is a person's decision, and is not made
here.** A signed-in editor may propose only as themselves or as `ocr`;
proposing as `agent:<name>` takes the service key (the one the syncs hold,
which can write past every editors-only rule) — or a narrower credential that
does not exist yet: a Postgres role for agents, granted `propose_equipment` and
nothing else. Which of those an agent gets, where its key lives and who can
revoke it are for the owner to choose.

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

The upload log, the equipment register and its suggestions (0036) are editors
only as well, for a sharper reason: serial numbers have only ever been in the
inspection records, which are editors-only, and a list of what radio is at
which unattended site is a shopping list. They are written only through their
functions — the log, a proposal, a decision — never a grant.

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

## Linking a Google Drive folder

About fifteen minutes, once. It needs someone who can share the Drive folder
the photos will be saved to, a Google account to make a Google Cloud project
with (the same person will do, and it costs nothing — the Drive API is free),
and someone who can add secrets to this repository on GitHub.

The sync signs in to Google as a **service account**: a Google Cloud identity
that belongs to a project rather than to a person, and that can read only what
is shared with it. Nothing about it expires, nobody's password is in it, and it
keeps working when whoever set it up moves on. (Signing in as a person, the way
Dropbox is linked, would go through a Google app still in *Testing* — nobody
has had it verified — and the sign-in Google gives such an app lapses after
seven days.)

### Which folder

One folder and everything under it, as with Dropbox: a folder in somebody's
*My Drive* (`Field photos`, say), or a folder in a **Shared Drive**. Crews save
photos into it from the Google Drive phone app (*＋ → Upload*), Drive for
desktop or the website — zips of photos too. Everything in it is imported, so
make it a work folder, not somebody's camera roll.

The sync walks the whole folder every run (*How the sync runs* says why), so
link the folder the photos go into, not the top of a large drive: past 1,000
folders, 20 folders deep or 50,000 files it stops and says the folder is too
big to walk.

### 1. Create a Google Cloud project, and turn the Drive API on

1. Open <https://console.cloud.google.com/> and sign in — with a work Google
   account if you have one (but see the note at the end of step 2).
2. In the project picker at the top of the page, press **New project**.
   *Project name*: `MegaNet Field Photos`. Leave *Location* as it is and press
   **Create**; when it is made, choose it in the project picker.
3. Open <https://console.cloud.google.com/apis/library/drive.googleapis.com>
   (or ☰ → **APIs & Services** → **Library**, and search for *Google Drive
   API*), check the project picker names the new project, and press
   **Enable**.

### 2. Create the service account, and a key for it

1. ☰ → **IAM & Admin** → **Service Accounts** → **＋ Create service account**.
2. *Service account name*: `field-photos`. Press **Create and continue**.
3. *Permissions* and *Principals with access* are optional, and stay empty:
   the account needs no role in the project — what it may read is decided by
   sharing, in step 3. Press **Continue**, then **Done**.
4. Click the new account in the list. Its **email** is at the top of its page,
   `field-photos@<project-id>.iam.gserviceaccount.com`. Copy it; step 3 needs
   it.
5. Open its **Keys** tab → **Add key** → **Create new key** → **JSON** →
   **Create**. A `.json` file downloads. It is the account's password: keep it
   out of email and chat, and delete it from your computer once step 4 is
   done.

If **Create** is refused with *Service account key creation is disabled*, the
organisation your Google account belongs to forbids keys (a policy Google turns
on by default for organisations set up since 2024). Someone who administers
its Google Cloud organisation policies can lift it for this one project: ☰ →
**IAM & Admin** → **Organization Policies** → *Disable service account key
creation* → **Manage policy** → *Override parent's policy*, with a rule whose
enforcement is **Off** → **Set policy**. Failing that, make the project with a
Google account outside the organisation.

### 3. Share the folder with the service account

1. In Google Drive, right-click the folder → **Share** → **Share**.
2. Paste the service account's email, leave its role as **Viewer**, untick
   **Notify people** (nobody reads its mail), and press **Share**. If Drive
   warns that the address is outside your organisation, press **Share
   anyway**.
3. Open the folder and copy the address bar:
   `https://drive.google.com/drive/folders/1AbC…` — the part after
   `/folders/`, up to any `?`, is the folder's id. Either will do in step 4.

**A folder in a Shared Drive** is shared the same way when the drive lets
folders be shared with people who are not its members. When it does not, add
the service account to the drive instead — the drive's name at the top →
**Manage members** → the email → **Viewer** → **Send**: it can then see the
whole drive, and the sync still reads only the folder you link.

**If Drive will not share with the address at all**, your organisation's
Google Workspace does not allow sharing outside it. A Workspace administrator
can allow it for the folder owner's organisational unit (Admin console →
**Apps** → **Google Workspace** → **Drive and Docs** → **Sharing settings** →
*Sharing outside of* your organisation). If that is not going to happen, keep
the photos folder in a Google account outside the organisation, or use the
Dropbox sync.

**Leave downloading on.** A photo whose owner has turned downloading off for
viewers — in the Share dialog's ⚙, or a Shared Drive's own settings — cannot
be read by a Viewer, the sync included; it fails with that reason in the run's
log.

### 4. Give GitHub the key and the folder

1. On GitHub, open this repository → **Settings** → **Secrets and variables** →
   **Actions** → the **Secrets** tab → **New repository secret**.
2. Name **`GDRIVE_SERVICE_ACCOUNT_JSON`**. For the value, open the downloaded
   `.json` file in a text editor, select all of it, and paste it in whole,
   braces and all → **Add secret**.
3. **`SUPABASE_SECRET_KEY`**, if it is not there already — the Dropbox sync
   uses the same one; step 3 of *Linking a Dropbox folder* says where it is.
4. The **Variables** tab → **New repository variable** →
   **`GDRIVE_FOLDER_ID`**, the folder's id or its address from step 3 → **Add
   variable**.
5. Delete the `.json` file from your computer, or put it in a password
   manager. A key that has got out is deleted in the Cloud console (the service
   account → **Keys** → 🗑), and replaced by making a new one and pasting it
   over the old in step 2.

The workflow never prints the key, and masks the service account's email in
its log.

### 5. Run it

**Actions** → **Field photos from Google Drive** → **Run workflow** → **Run
workflow**. When it finishes (a minute or two; longer for a big first import),
open the run → **sync** → **Sync**: its log names the folder, lists every file
and what became of it, and ends with the count (`12 seen, 12 imported (0
unplaced), 0 skipped, 0 failed`). The photos are in the Field Photos library.
From then on it runs every fifteen minutes on its own, seven minutes after the
Dropbox sync.

If it fails, the last line says why. The usual three: *Google Drive token:
invalid_grant — Invalid JWT Signature* — the key was deleted, or not pasted
whole (paste the whole file again, step 4); *there is no folder … that
field-photos@… can see* — step 3 is not done, or the id is not the folder's;
*Google Drive API has not been used in project … or it is disabled* — step
1.3.

Before the secrets and the variable exist, it does nothing every fifteen
minutes, and says so in a notice rather than failing.

---

## How the sync runs

Each run (`tools/field-photos/sync.mjs`, one Node process on a GitHub runner)
— Dropbox's, and Google Drive's is the same run (below):

1. **Where the last run got to** — a Dropbox cursor, kept in
   `meganet.field_photo_sync_cursor`, which only the secret key can read.
2. **What is new since**, in the folder and every folder under it, oldest
   first. Photos (`.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`, `.webp`), and zip
   packs of them (below).
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
   log (Actions → the run) lists every file and what happened to it. Each
   file it tried is also a row in `meganet.field_photo_upload` (0036) — best
   effort: a log that cannot be written is a line in the run's log, never a
   failed run.

A photo the sync could not place is in *Unplaced* like any other.

**From Google Drive** it is the same run with a different place to read
(`PHOTO_SOURCE=gdrive`: `lib/gdrive.mjs`, `field-photos-gdrive.yml`), and one
difference, in steps 1 and 2. Dropbox keeps a cursor that follows a folder;
Drive's changes feed follows an *account*, and would report a sub-folder
dragged in from elsewhere as one change, with none for the photos inside it.
So a Drive run walks the whole folder — a `files.list` for each folder, a
thousand files a page, eight folders at a time — and compares what it finds
with what the last complete walk found. That list, eight bytes a file, is the
cursor; what is not in it is new or changed, and from there it is the run
above, step for step: what came in before is skipped (a removed photo's
tombstone keeps the Drive file id), each file is dealt with once a version — a
photo that failed is tried again only once it changes, as with Dropbox — and
the cursor moves only when everything listed was dealt with. Google's own
documents, shortcuts (not followed: one can point anywhere in Drive) and the
bin are left alone. A quiet run costs the walk and nothing more, and the walk
stops, saying why, past 1,000 folders, 20 deep or 50,000 files. Its report is
`meganet.field_photo_sync`'s `gdrive` row: the folder's name, and the service
account for *whose*; its photos say *Google Drive — * the folder's owner (the
service account, for a Shared Drive's folder, which has none).

**Why a scheduled workflow and not a server.** The job is "look at a folder
now and then", and GitHub already runs things now and then for this
repository: nothing to host, a log of every run, and *Run workflow* for an
import right now. A photo waits at most a quarter of an hour. Dropbox can call
a webhook the moment a file lands, and a route on the Worker could start the
workflow from it — a refinement for later, not a reason to have a server.

### Zip packs in a linked folder

A `.zip` saved into either folder is opened (`lib/zip.mjs`), and each photo in
it filed as one of its own: its own name for a title, the zip's file id and
its path in the zip for its `origin_ref` (`<id>#DCIM/IMG_0042.jpg`), and
`meta.dropbox.archive` or `meta.gdrive.archive` saying which zip and where in
it. The rest of a zip — folders, a readme, the `__MACOSX` resource forks macOS
adds beside every file — is left alone.

Stored and deflate, which is what every zip tool writes unless asked
otherwise. A zip with a password, a ZIP64 archive (over 4 GB or 65,535 files)
or one split across several files is skipped with that reason, and so is a
photo in one compressed any other way. A zip is never believed about its own
size — at most 2,000 files, 2 GB of photos and 24 MB a photo, none inflated a
byte past what the zip declares — and each photo's checksum is checked, so a
damaged zip fails the photo rather than filing a broken one.

A zip is dealt with once, like any file: the cursor moves past it. Changed
later, it is opened again, the photos from it already in MegaNet are skipped
and the new ones imported; a photo from it that somebody removed stays
removed. Its photos count against a run's 150 like loose ones, and a run that
stops partway through a big zip downloads it again next run and carries on
where it stopped.

---

## The schema

`db/migrations/0035_field_photos.sql` and `0036_photo_review.sql`;
`db/README.md` has the table list.

| | |
|---|---|
| `meganet.field_photo` | one row per photo: the object and its thumbnail, the file (type, size, SHA-256, pixels), title and caption, when (local and instant, and from what), where (lat/lon, how placed, accuracy), altitude and its datum, heading and its reference, pitch, field of view, the station (and whether by distance), `meta` (the camera, the OCR's readings, the Dropbox or Google Drive file), where it came from (`upload`, `dropbox`, and since 0036 `gdrive`) and who added it; soft-deleted |
| `meganet.field_photo_origin`, `meganet.field_photo_placement` | the two vocabularies |
| `meganet.field_photo_sync` | the sync's report, one row per source |
| `meganet.field_photo_sync_cursor` | where the sync got to — RLS on, no policy: the secret key only |
| `add_field_photo(p_photo jsonb)`, `update_field_photo(p_id, p_patch jsonb)`, `remove_field_photo(p_id)` | the three doors |
| `field_photo_station_for(p_lat, p_lon, p_within_m default 1000)` | the nearest live station within a distance |
| `meganet.field_photo_upload` (0036) | a row per file per attempt, from every way in: when, the way in (`upload`, `dropbox`, `gdrive`), the batch, the file and its zip, hash and size, the outcome and why, the photo it became or already was, the station, who |
| `meganet.field_photo_outcome` | the outcomes, and which of them are a photo in MegaNet (`has_photo`) |
| `log_field_photo_upload(p_rows jsonb)`, `prune_field_photo_uploads(p_older_than interval)` | write up to 500 outcomes, all or nothing (editors and the syncs); take out the old ones (the secret key or the owner) |
| `meganet.station_equipment` | a station's equipment register: each unit, kind, make, model, serial, note, how it was known (`equipment_source`), the photo and suggestion it came from, and — retired — when, by whom, and what replaced it |
| `meganet.equipment_suggestion` | a proposed change to a register: station, photo, kind, make, model, serial, evidence, confidence, who or what proposed it, and the decision — `pending`, `approved`, `rejected`, `superseded` — with its note and the corrections made |
| `propose_equipment(p jsonb)`, `decide_equipment_suggestion(p_id, p_decision, p_note, p_patch)` | the seam anything proposes through (editors, the secret key for an agent); the administrator's decision |
| `is_admin()` | may this request decide — an editor whose `app_user.role` is `admin`, the secret key, or the owner |

The bucket, `field-photos`, private, 25 MB an object, editors only for all
four operations, is `tools/storage_bucket.sql` — run once per project, after
the migration, like 0010's.

## What the network has to allow

| Host | For | Notes |
|---|---|---|
| `unpkg.com` | the OCR engine, once a session, only for a photo with no GPS; the HEIC decoder, once a session, only for a HEIC the browser cannot draw | already allowed for Leaflet, MapLibre and three.js |
| `*.supabase.co` (or the `/api/db` proxy) | the rows, the bucket, the signed links | already allowed |
| `www.dropbox.com`, `api.dropboxapi.com` | linking Dropbox, once, from the tab | only for whoever sets it up; the sync itself runs on GitHub |
| `oauth2.googleapis.com`, `www.googleapis.com` | the Google Drive sync: its hour's token, and the folder's listing and files | from GitHub's runners only — nothing in the browser talks to Google |
| `console.cloud.google.com`, `drive.google.com` | linking a Google Drive folder, once | only for whoever sets it up |

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
- **`npm run photozip`** (test/) — `photo-zip.js` under Node against zips
  built byte by byte (stored and deflated entries, a folder, `__MACOSX` junk,
  UTF-8 and CP437 names, a data descriptor, something in front of the zip),
  and every refusal — a password, a method a browser cannot unpack, ZIP64, a
  split zip, too many files, a bomb that lies about its size, a bad checksum;
  then the tab in Chromium: a zip dropped with loose photos, its photos read,
  placed and uploaded exactly as dropped ones are, and the pack's line saying
  what was left out and why.
- **`npm run photoreview`** (test/) — `PhotoEquipment.parse` under Node against
  what OCR makes of real labels, clean and garbled; then the Review panel in
  Chromium against a fake project: the three lists, an administrator and an
  editor who is not one, an approval with a correction sending exactly that
  correction, a rejection, the outcomes logged after an upload, the labels of a
  drawn equipment label read by the real OCR engine and proposed, and the
  station card's Equipment section.
- **`tools/check_field_photos.sql`** — 0035's own rules against a real
  Postgres: the path and type rules, one live photo per hash, one row per
  Dropbox file, the nearest station and when it is picked again, who may read
  what (an editor, a stranger, anonymous, the secret key).
- **`tools/check_photo_review.sql`** — 0036's: who is an administrator (an
  editor made one, one taken off the editors list, a stranger, anonymous, the
  secret key); the log's rules, all or nothing; proposing, and each collision
  refused with what it collided with; approving with and without corrections,
  rejecting, replacing and retiring, a second of a kind added alongside, the
  ambiguous case refused, superseding; and who may read what.
- **`tools/field-photos`: `npm test`** — the sync against a fake Dropbox and a
  fake project, with the real reader and the real OCR engine: a photo read off
  its overlay, one placed by its EXIF without the OCR asked, the second run
  importing nothing, a removed photo not brought back, a refused row's bytes
  taken down, a backlog worked through run after run, a reset cursor, a bad
  token, a zip's photos coming in as photos of their own. Then Google Drive
  against a fake Google, whose token endpoint checks the JWT's RS256 signature
  against a key pair the test makes: the folder walked, sub-folders and pages
  of it included, and no Google Doc, shortcut or binned file read; a zip's
  photos imported, and a run that stops inside the zip carrying on from it;
  the second run downloading nothing; a removed photo not brought back when
  its file changes; what could not be taken (over 24 MB, a password) dealt with
  once, not every run; a Shared Drive listed from its drive; the upload log's
  rows, and the run succeeding without it; a key Google refuses, a folder not
  shared, and missing or wrong settings each failing in a sentence with no key
  in it. And `lib/zip.mjs` against a zip Info-ZIP wrote, then the same bytes
  altered for each thing it refuses — a password, ZIP64, a split zip, a zip
  bomb, a bad checksum, a method it does not read.
  **Google itself is never called.** Nothing that runs these checks can reach
  it, so every Google call is tested against that fake, built to Google's
  documented answers; the first run against the real thing is step 5 of
  *Linking a Google Drive folder*.
