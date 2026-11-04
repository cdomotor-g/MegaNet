# Station names Radio Mobile cut short

Radio Mobile keeps a unit's name in 20 characters, and the first import took
the network's station names from it. So *Augustus Downs Station* arrived as
`Augustus Downs Stati` and *Ainsworth Road (Middle Creek)* as
`Ainsworth Rd (Middle`. Some were shortened again after the cut (Road to Rd,
Creek to Ck, Bridge to Br), and the Road one was applied inside words as well,
which is how Broadwater became `BRdwater`. A few had their words squeezed
together to fit: `SuffolkPrk(ServoRd`.

On 4 November 2026 the 112 that could be completed were renamed in the
database. `review.json` is the record of that change.

| File | What it is |
| --- | --- |
| `review.json` | `names`: one row per renamed station — id, number, the name as it was, the name now, the list the full name came from and why. `left`: names that were looked at and kept, with the reason. `tools/ingest/truncated_names.py --sql` turns `names` into the SQL that was applied. |

## How a cut was found

A name is a cut when another list gives the station's number a longer name
whose first 20 characters, trailing space dropped, are the name, read with Rd,
Ck and Br spelled out. The lists are all in the repository: ARRO's sites
(`archive/z_Sensors_with_Database_IDs_by_View_NATIONAL.csv`, and the `site`
attached to each station), the site list in `archive/fred_sites_newfile.csv`,
the Bureau's QLD and NSW SLS schedules, its Queensland station lists, HDB's
flood peaks and the 2024 FldWarn KMZ. That test, and an open bracket, found
105 of the 112; the other seven turned up by eye.

The full name is ARRO's where ARRO writes it in mixed case, then the site
list's, then the Bureau's in title case. A trailing *Alert* became *AL* and
*Tm* became *TM*, as in the 2,200 other names that end in AL or TM.

Where no list had the number, or the lists did not give a longer name, the full
name was looked up by hand, and each reason is in `review.json`:

- Four had no station number. Each is a Radio Mobile unit standing on, or
  near, a numbered station whose lists give the full name: North Murwillumbah
  (Tweed River), Lismore (Browns Ck Pump Station), Macalister Bell Rd Jimbour
  Ck AL and Bloomfield River Bridge TM. **All four are probably stray copies of
  those numbered stations** (two have a longitude or position that is plainly
  wrong), so they are worth a look before anyone relies on them.
- *Capalaba Water Treat*: the Bureau's own station record is cut at 20 too. The
  gauge is at Seqwater's Capalaba water treatment plant.
- *HulbERRTS Br Tm* and *BRdwater Tm*: mangled by a find-and-replace, not cut.
- *Little RIver at Arthurville*: a typed capital, fixed while here.

Two names changed what they say, not only how much. The lists, and the site
list at the same position to the metre, name 140030 *Boyne River (McLaughlins
Rd) TM* and 140031 *Cherwell River (Highway Bridge) AL*. The Radio Mobile names
had said *Chahpin…* and *Rail…*.

## What was left

A longer name that only spells out an abbreviation Flood-Net uses on purpose is
not a cut: *Abergowrie Bridge AL* against the Bureau's ABERGOWRIE BRIDGE ALERT.
Nor is a short form with its bracket closed, such as *Tintot (Macintyre R)*: the
same style runs through names longer than 20. `left` in `review.json` lists
these and the two with nothing to go on: *Jubilee Pocket NEW T*, which no list
names, and *Proposed Gatton Auto*, a proposal entered in Flood-Net.

## Running it again

```bash
python3 tools/ingest/truncated_names.py --find   # names that still look cut, not yet decided
python3 tools/ingest/truncated_names.py --sql \
  | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
```

The SQL renames a station only while it still has the name the review found it
with, so a second run changes nothing and a name somebody has changed since
stays as they put it. Every rename is stamped `station names cut at 20
(claude)` and is in each station's history, from where it can be put back.
Refresh `stations.json` afterwards (`tools/snapshot_stations_json.py`).
