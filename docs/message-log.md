# The Message Log

*The arrival log: every message the datastore accepted, newest first, one row
per reading.* This page is the long form of the tab's help panel — what each
column means, what the tab is for, and where its edges are.

The Message Log reads `meganet.reading` — the same table the
[Field Data](../README.md#field-station-telemetry) tab charts — but asks it a
different question. Field Data asks *what did this station's sensor do over
time*; the Message Log asks *what arrived, when, and by what path*. Same rows,
two readings of them, joined in both directions (see
[Crossing to Field Data](#crossing-to-field-data-and-back)).

---

## What it is for

**Watching messages arrive.** Fade-margin testing, part swaps, antenna work
and new-site commissioning all end with somebody in the field asking "did that
one get in?". Filter to the station (or leave the filter open), switch
**follow** on, and the table re-asks the datastore every 30 seconds. A test
transmission either lands as a row within a minute or it did not arrive —
and if it landed, the row says which base heard it and how many copies came in.

**Identifying the ingress pathway.** Which base station a message came in at
(`path`), which wire protocol it spoke (`protocol`), which transport delivered
it (`source`), and which *other* paths delivered further copies (`dup_paths`,
in the row's detail). This is the tab that answers "is Mount Tabletop actually
hearing this site, or is everything coming in direct?".

**Verifying field calibrations onto the data trace.** A gauge tipped by hand,
a probe lifted a known distance — the point of the exercise is that the change
arrives in the database. The raw value is the headline column because raw is
what was transmitted; the converted value and the rule that produced it sit
beside it when the datastore recorded one.

**Reviewing history in the office.** The same filters serve data validation
and network-performance review: a window, a pasted list of addresses or
station numbers, a protocol, an ingress path, quality, "heard more than once",
"unresolved address only". Note the retention edge below before reaching back
too far.

## Reading the table

One row is **one reading, not one transmission**. The datastore deduplicates
on (address, instant, value) and counts the further copies — a reading heard
direct and via two repeaters is one row saying **× 3**, and the detail drawer
lists the paths. That count is the network's real path redundancy, visible
nowhere else.

| Column | Meaning |
| --- | --- |
| **Time** | `reading_ts` — when the device says it read. Field clocks drift; the detail drawer shows the gap to our clock. |
| Received | `received_at` — when the datastore stored it. This is the clock you can trust. |
| Stn # | The station number the message carried, or the resolved station's. |
| Station | The resolved station — see the note on resolution below. |
| AlertID | The ALERT address the message was addressed to. Empty for satellite/cellular messages, which report under a station number and channel. |
| Channel | Which sensor spoke, for station-number-addressed messages. An ALERT address *is* the sensor, so radio rows have no channel. |
| **Raw** | `value_raw` — as transmitted, before any interpretation. |
| Value | The conversion, when one was recorded, with its unit. Display only. |
| Quality | What the source said about the reading. `unqualified` means nobody said anything — not that anybody checked. |
| Protocol | The wire protocol decoded from — `alert`, `alert2`, `arro` (backfill). |
| Source | The transport — `http`, `mqtt`, `manual`, `backfill`, `serial`. |
| Path | The repeater or base that delivered the kept copy, when the adapter knew. |
| Copies | How many times the reading was heard in total; hover for the paths. |

**Station names are a resolution, not a claim the message made.** The address
is the identity (a packet carries an address; which station that is may be
unknown). Where the datastore has backfilled `station_id`, that wins; failing
that the tab matches the ALERT address, then the station number, against the
loaded station file. 604 of 5,122 ALERT addresses belong to more than one
station, so an address match names the first candidate and says how many more
share the address. A relayed ALERT2 row matches on its **station address**
instead, which one station holds and no other may, so that tier never reports a
tie. An **unresolved** row is not an error — a new site reports before anyone
adds it to MegaNet, and the reading is kept rather than dropped. The
*unresolved address only* filter is how those are found.

### Claiming one

Open an unresolved row and its detail drawer offers **Attribute to a station…**
— a search box over the station list, the same one the Inspection History and
Maintenance tabs use. Picking a station is the reverse of the way this has
always worked: instead of remembering the address, going to the Stations tab,
finding the station and typing it in, the message names the station it came
from.

Three things are worth knowing about what that click does.

**It claims the address, not the row.** A message is one instant; the thing that
wants claiming is the identity every message like it shares. So the write
back-fills every reading already stored under that address, and the tab reports
how many — *"relayed ALERT2 station 1003 attributed to Loudoun Br. 183 readings
claimed."* Readings that arrive afterwards resolve on their own.

**It writes the registry, not the readings.** `reading.station_id` is resolved
from the address and never taken from a payload. The claim puts the address on
the station — an ALERT2 station address on the station itself, an ALERT address
as a sensor row — and lets resolution follow.

**It will not create an ambiguity.** Two stations on one ALERT address resolve
to neither, so claiming an address another station already holds is refused, and
the message says which station holds it. Moving one is the station editor's job.
A relayed ALERT2 station is refused the same way, and the datastore's
`claim_a2_station(…, p_replace => true)` is what deliberately moves it.

Signed out, the drawer says so rather than offering a button that would produce
a 401. What a relayed row claims is the **whole ALERT2 station**, not the one
sensor slot on screen — which slot is which is then named on the station card,
where the slots that station has actually been heard on are listed for you.

## Narrow and wide

Two views of the same table. **Narrow** opens with the field set — time,
station number, station name, AlertID, raw value — for a phone held in a
paddock; **wide** opens with the full record. The **Columns** button decides
what each view keeps, per view, remembered on this device; the station-name
column is width-capped so one long site name cannot spend the whole of a small
screen. **Export CSV** always writes every column of every fetched row,
whatever the views are hiding — the narrow view is a reading aid, not a
statement about the record.

## The tray — the map

Collapsed by default, so the log is what the tab opens on. Tick rows in the
table (the leftmost checkbox; the header checkbox takes the whole fetch) and
open **Map**. It follows the Stations tab's own rules: every pin stays on the
map, ghosted; the stations behind the selected rows come up at full opacity
with their names; and the repeaters whose pass ranges carry them are pulled
in **dashed cyan** with a dashed line to each station they serve — cyan
meaning *a pass range named it*, never *you named it*.

The tray used to be half a value-against-time plot beside a half-width map.
The plot answered a question this tab does not ask — raw values across a
window are Field Data's whole subject, and every row's detail drawer has a
button that opens exactly that reading there. The map has the width now.

## The detail drawer

Click a row (or its time-cell button) and the whole record opens: the
identity and how it resolved, both clocks and the gap between them, the raw
value and the conversion rule, the pathway in, the duplicate copies and their
paths — and the decode:

* **ALERT** rows show the address and value in binary and offer **Rebuild the
  frame on the ALERT Packets tab**, which prefills the encoder with this
  address and value so the framing, check bits and bit map are on screen. The
  stored record is the *decoded* address and value; the framing is the
  encoder's to reconstruct.
* **ALERT2** rows point at the A2C layout, and — once the submission is
  fetched and carries a wire frame — offer **Decode it on the ALERT2 tab**,
  which hands the frame to the tab that decodes whole ERT-A2 lines.
* **The submission as received** (`meganet.reading_raw`) is the payload
  exactly as the adapter posted it, plus the wire frame when one was given.
  It needs a signed-in session — a submission is whatever a device sent,
  which is not something to publish unread — and it ages out at ~30 days.
  A dangling reference means "aged out", and the reading itself is unaffected.

## Crossing to Field Data, and back

Each data point can be looked at on either page, so each page carries a door
to the other:

* **Message Log → Field Data**: every row's detail drawer has *Chart this
  address around this reading* — the Field Data tab opens with the address
  picked, a day either side of the moment, at raw resolution.
* **Field Data → Message Log**: click a point on the Field Data chart; the
  pinned inspector has *Open this reading in the Message Log* — the log opens
  filtered to the address, an hour either side, with that reading's row
  opened and selected. Rollup points name no single message, so only raw
  points carry the door.

## Edges worth knowing

* **Raw readings age out at ~90 days.** A window into last winter comes back
  empty here; the hourly and daily rollups that survive are on the Field Data
  tab, which knows how to widen. The row cap (5,000 per fetch) is stated on
  screen when it bites, with *load more* for the next page.
* **Reading needs no sign-in.** The log, like the station list, is public by
  design; only the raw submissions behind it are gated.
* **This is the MegaNet datastore only.** ARRO's numbers live on the ARRO
  Data tab and the two are never combined — different source of truth,
  different retention, different trust.
* **Follow is polling, not push.** Every 30 seconds while the tab is open,
  stopped the moment you leave it. It is for watching a test land, not for
  leaving a wall-screen running against the free tier.

The schema behind all of it — the dedup key, the address shapes, retention and
the rollups — is `db/migrations/0006_telemetry.sql` and
[`db/README.md`](../db/README.md).
