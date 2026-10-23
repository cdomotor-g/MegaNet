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

## Not applied, waiting on a decision

- Flood-Net's Mt Lowe AL (535128, near Emerald) carries Lower Springbrook's
  repeater: licence 11165505, 151.950, range 2277–2278. ACMA sites that licence
  at 2459 Springbrook Road, where the KMZ's Lower Springbrook paths end. Moving it
  changes an existing range.
- Laheys Lookout's range is 5389–5382, inverted in the document and in Flood-Net
  (`0002_stations.sql` explains why the schema keeps it). The KMZ sends Double
  Crossing Rd (5380–5382) through Laheys.
- Whether Flood-Net's "Fraser Coast Regiona" (260127) is the KMZ's FCRC Base
  Station, 3.4 km away.
- 60 numbered pins have no Flood-Net station and appear in none of the Bureau's
  September 2026 lists. 35 are read by hand; most look closed. They are in
  `kmz.json`.
- Recording manual or automatic from the KMZ's network column.
- The wider repeater-document problems. About 20 rows never became a repeater on
  any station, and at least six landed on a neighbour: Blackdown Tableland on
  Black Mt AL, Ballandean Hill on Ballandean AL, Emerald Radar on Emerald AL,
  Mt Macquarie on Port Macquarie (Golf) in New South Wales, Round Mt Res probably
  on Round Mountain AL, and Lower Springbrook above.

## Reproducing it

```sh
python3 tools/ingest/fldwarn_kmz_2024.py --extract ~/Downloads/FldWarn*.kmz
python3 tools/ingest/fldwarn_kmz_2024.py --sql \
  | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
python3 tools/snapshot_stations_json.py
```

The SQL moves a station only while it is still where the review found it. It
adds ranges only to a repeater that has none, and fills a frequency, network or
owner only where it is empty, so a second run changes nothing. Each write is
stamped `fldwarn kmz 2024 (claude)`, the name the station history shows. Three
history rows (Tallai, Mt Tamborine, Molendinar) read `postgres`: their radio
change came after their move in the same run, and the history credits a second
write under an unchanged stamp to the connection (`db/README.md`, *Station
history*).
