# The 2024 FldWarn KMZ

`FldWarn Stations and paths 2024.kmz` is the Google Earth file the Bureau's
Queensland flood warning team kept in 2024: 2,348 station pins in 30 basin
folders, and 180 radio paths in nine folders named for their frequency. It was
checked against Flood-Net on 23 October 2026 and what it taught was written into
the database the same day. The KMZ itself is not here: it is somebody else's
export, the same rule as the basin and hub KMZs (`db/README.md`, *Where a station
is*).

| File | What it is |
| --- | --- |
| `kmz.json` | The KMZ as written: every pin (number, what it observes, how it reports, position, whether it was placed by hand, its pushpin colour) and every path (sender, receiver, frequency, ends). `tools/ingest/fldwarn_kmz_2024.py --extract` writes it. |
| `review.json` | What was decided, one row per station with the reason, and every value the database was given. `--sql` turns it into the SQL that was applied. |
| `../repeater-document.json` | The original repeater document's 129 rows, each on its home station with what that station needed. `tools/ingest/repeater_document.py --sql` writes it. |

## What the KMZ is

The pins are the Bureau's own list of the time, to the second of arc, and some
were later dragged in Google Earth to where the station really is. A dragged pin
is the only kind that does not land on a whole second, so 88 of them can be told
from the rest. Each description reads `number : observes : reports`, for example
`540322 : RN : ALERT`: `RN` rain, `RV` river; `ALERT`, `TELEMETER` and `AWS`
report by themselves, while `ROT` and `SYNOP` are read by hand.

The folder named `Frequency = 125.400 Mhz` is 152.400 with its digits swapped.
ACMA licenses the Bureau on 152.400 at exactly the five sites those paths join,
and Flood-Net already had O'Reillys and Laheys sending on 152.4.

## How each pin was judged

Every pin with a Bureau number was matched to Flood-Net by that number (leading
zeros ignored), and three positions were compared: the KMZ, the Bureau's
September 2026 lists (`data/river-height-stations.json`) and Flood-Net. 1,898 of
2,278 matched pins were already within 30 m.

A station a person had moved in Flood-Net stayed where it was. Where the sources
disagreed by more than 80 m, each candidate position was scored against
references neither came from: ACMA licence sites for radio sites, Queensland's
gauging stations and mapped watercourses for river gauges, terrain for hilltops,
and aerial imagery for the hardest dozen. A pin dragged by hand in the KMZ was
taken as a correction unless that evidence said otherwise. It did for four:

- **Coulson TM:** Flood-Net is on state gauge 145031A, this TM's AWRC number.
- **Tallebudgera Ck Rd AL:** Flood-Net is on its ACMA licence site.
- **Wilsons Peak AL-P:** Flood-Net is on Seqwater's licensed Mt Wilson site.
- **Wivenhoe Dam HW AL-P:** the KMZ copies the state gauge's rounded
  coordinates into a paddock.

| Applied | Stations |
| --- | --- |
| Moved where independent evidence backs the KMZ (ACMA site, state gauge, the station's own river, or a gross error such as Palen Creek's longitude typed as 142.7) | 28 |
| Moved to a pin placed by hand in the KMZ | 40 |
| Moved where the KMZ matches the Bureau's 2024 and 2026 lists to the second and Flood-Net's coarser position came from elsewhere | 50 |
| Sharpened by under 80 m: Flood-Net had them rounded to 3 decimals | 189 |
| Moved on the owner's call: Cressbrook Dam ALERT to the intake tower (the KMZ), Kiamba TM to state gauge 141001A | 2 |
| Left as Flood-Net had them, each with its reason in `review.json` | 73 |

A modelled height (Elvis) follows its pin, so 290 heights were read again at the
new positions. A surveyed height belongs to the station, not the coordinate, and
stays. Seven stations changed basin, all of them big moves (Palen Creek,
Moggill AL-P, Mt Beatrice, Peak Vale and others). No hub changed.

## Radio

Flood-Net does not store links; the map draws them from pass ranges. So the
paths came in as repeater roles, frequencies and ranges. No range Flood-Net
already held was changed.

- **Frequencies** on two repeaters that had ranges and no channel: Tallai
  151.500/151.500 (ACMA 433855) and Mt Tamborine 151.500 in, 152.400 out
  (ACMA 1410739).
- **Repeaters from the original repeater document** (`data/ALL_REPEATERS.csv`),
  which the first import never attached to their stations: Molendinar, Middle
  Creek, Wilsons Peak (on the `wilsons_peak` radio unit, licence 1410738) and
  Barradeen. The KMZ draws 29 paths into these four.
- **Repeaters inferred from the KMZ** with no document behind them: Westcourt,
  Ularunda, Glengarry, Sommariva and Arabella, the relay chain the KMZ draws from
  Abbieglassie toward Charleville. Each passes the ALERT addresses upstream of
  it, from 1073–1074 at Westcourt to 1073–1084 at Arabella. Each says so in its
  notes.
- **Mt Glorious** (`mt_glorious_al_rptr`) as Seqwater's hub on 151.525 MHz,
  passing 4000–4099 and 6500–6799. This is a best guess, and the station's notes
  say so:
  - Seqwater's documented repeaters pass within those blocks.
  - Flood-Net's own receivers heard 4000–4095 and 6526–6778 on 151.525 in
    October 2026.
  - Its other Seqwater channels (152.4625, 151.425, 152.25, and the 151.5375 link
    to Ipswich and Brisbane) are listed as frequencies.
- **Seven base stations** the paths end at: City of Gold Coast at Carrara, Ashmore
  and Bundall; BoM Mt Stapylton; Scenic Rim (SRRC); Murweh Shire at Charleville;
  and Dalby Base Station (41555).

Six names the Bureau's 20-character field had cut short were completed from the
KMZ, for example "Windorah (Lignum Cha" became "Windorah (Lignum Channel) TM".

## Round two: the owner's answers

The first round left six questions open. They were answered the same day and
applied:

- **Lower Springbrook.** Flood-Net's Mt Lowe AL (535128, near Emerald) carried
  Lower Springbrook's repeater (licence 11165505, 151.950, range 2277–2278). That
  row is now on Lower Springbrook AL, where ACMA sites the licence and the KMZ's
  paths end. Mt Lowe AL carries its own row from the document (151.500, ranges
  1151–1164, 5954–5956 and 5970–5977, network Emerald).
- **Laheys Lookout** passes 5380–5382, not the inverted 5389–5382 the repeater
  document and Flood-Net had. The KMZ sends Double Crossing Rd (5380–5382)
  through it.
- **FCRC Base Station** is Flood-Net's "Fraser Coast Regiona" (260127). It moved
  3.4 km to the KMZ's hand-placed pin, became a base (Fraser Coast Regional
  Council's), and lists 151.500 as the channel the KMZ's paths reach it on.
- **The 60 pins Flood-Net had no station for** were all added, but not all
  switched off. 28 are in the Bureau's December 2025 service level specification
  (`data/sls-qld.json`), so they are current even though the September 2026
  river height lists leave them out. Those 28 are switched on. Six of them carry
  the SLS's newer name, for example Hattonvale Store as "Hattonvale O'Shea Rd".
  The other 32 are in neither list and are switched off, as probably closed.
  Each station's notes say which case it is. Nine have the Bureau's 2014 flood
  classifications.
- **Manual or automatic** is now recorded as the station's type (`station_type`)
  on 4,239 stations. Only 9 had one before. The evidence is taken in this order:
  1. the station's live sensors (a station that reports itself is automatic);
  2. the SLS;
  3. the KMZ's network column.

  It is a water level station if its sensors or the SLS show a river gauge;
  otherwise it is whatever the first source to say gives.
  `review.json` has the rule (`round2.station_type_rule`) and, for each
  station, its type and where the type came from. 666 field stations have no
  evidence of what they are and stay blank. Where the sources disagree, the
  newer one wins. That made 25 stations automatic that an older list calls
  manual: 24 by the 2024 KMZ, and Cressfield by the SLS. Eidsvold Bridge and
  Ripple Downs AL, for instance, now report automatically: Eidsvold Bridge's
  rainfall, water level and battery come in as ALERT 773–775. The sources
  disagree on water level against rain for another 13 stations; each has its
  disagreement listed.
- **The repeater document** is reconciled row by row, not just the four rows
  round one found. See below.

### The repeater document

`data/repeater-document.json` puts every one of the 129 rows of
`data/ALL_REPEATERS.csv` on the station it belongs to. It was matched by name,
ACMA licence site and the KMZ's paths, and the evidence for each placement is
in its notes. `tools/ingest/repeater_document.py --sql` writes it.

| Outcome | Stations |
| --- | --- |
| Already right | 82 |
| Repeater added to the station the row belongs to | 28 |
| Empty channel, licence or network filled | 5 |
| Ranges somebody had edited since the document, left as they are (Mt Kanigan, Mt Petersen, Middlemount, Florence Vale) | 4 |
| New repeater units at the licence's ACMA site, for a site's second repeater (Mt Stuart #3/#4, Saddle Mountain #2) or a site with no station (Baroon Dam) | 3 |
| The wrong row replaced with the station's own (Mt Lowe AL) | 1 |

Five stations carried a repeater that was not theirs, put there by the first
import's loose name match. Their repeater came off, each with a note saying
where it went:

- Black Mt AL (Blackdown Tableland's row);
- Ballandean AL (Ballandean Hill's);
- Emerald AL (Emerald Radar's);
- Port Macquarie (Golf), in New South Wales (Mt Macquarie's);
- Round Mountain AL (Round Mt Res's).

These removals, and Mt Lowe's replacement, went through
`meganet.save_station()`, the editor's own write path. That is the same as
unticking "repeater", or editing the ranges, in the editor. The only other
range changed is Laheys Lookout's, above, on the owner's say-so.

## Reproducing it

```sh
python3 tools/ingest/fldwarn_kmz_2024.py --extract ~/Downloads/FldWarn*.kmz
python3 tools/ingest/fldwarn_kmz_2024.py --sql \
  | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
python3 tools/ingest/repeater_document.py --sql \
  | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
python3 tools/snapshot_stations_json.py
```

The SQL moves a station only while it is still where the review found it. It
adds ranges only to a repeater that has none, fills a frequency, network,
owner or type only where it is empty, and adds a station only if its id is
free, so a second run changes nothing. Each write is stamped `fldwarn kmz 2024
(claude)`, the name the station history shows.

366 history rows read `postgres` instead. The history credits a second write
under an unchanged stamp to the connection (`db/README.md`, *Station
history*):

- Tallai, Mt Tamborine and Molendinar, whose radio change came after their
  move in round one;
- 18 rows from the repeater reconciliation;
- 345 type writes on stations round one had already moved.

A later pass should use a stamp of its own.
