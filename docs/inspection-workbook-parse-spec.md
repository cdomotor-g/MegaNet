# Parsing `QLD All Site Inspections.xlsx`

This is the specification #123 (H1) exists to produce: the rules an extractor
has to implement to turn `archive/QLD All Site Inspections.xlsx` into rows, and
the reasons behind each one. It is written to be implemented from — #124 (H2)
should not have to open the workbook to guess at anything on this page.

It has four companions, all machine-readable, all written by
`tools/ingest/survey.py` and all re-derivable from the workbook:

| File | What it is |
|---|---|
| [`tools/ingest/inspection_sheet_manifest.json`](../tools/ingest/inspection_sheet_manifest.json) | one entry per worksheet — all 59 — with a disposition, the counts to reconcile against, the hidden-twin comparison, every cell comment, and the questions still open for @cdomotor-g |
| [`tools/ingest/inspection_field_map.json`](../tools/ingest/inspection_field_map.json) | the canonical field vocabulary, and every header label in the workbook mapped onto it — or listed unmapped, with a reason |
| [`tools/ingest/inspection_layouts.json`](../tools/ingest/inspection_layouts.json) | every distinct column layout, each column carrying its canonical field |
| [`tools/ingest/inspection_survey_counts.json`](../tools/ingest/inspection_survey_counts.json) | the headline counts, and how they reconcile against the figures quoted in #122 |

Run `python3 tools/ingest/survey.py` to rewrite them, or
`python3 tools/ingest/survey.py --check` to assert they still match the
workbook. Nothing in this issue writes to a database.

> **Read [#122](https://github.com/cdomotor-g/MegaNet/issues/122) first.** It
> says why the backfill matters and which workbook is which — the *blank* form
> workbook `Inspection sheets for printing.xlsx` belongs to #78 and is a
> different job.

---

## What is actually in the file

59 worksheets, **45 visible and 14 hidden** (#122 says 44/15; the workbook's own
`state` attribute says otherwise — see *Reconciliation* at the foot of this
page). Four of them are skipped and one is deferred, which leaves **54 sheets
holding 1,420 station blocks and 20,407 dated inspection rows** between 1980 and
2024.

Two sheets are not blocks at all. `ALERTS` (228 rows) and `TM Only` (54 rows)
are flat tables: one header band at the top, one row per inspection under it,
the station named in a column. Everything else is **stacked station blocks** —
a basin sheet is dozens of independent mini-sheets glued vertically.

The anatomy of one block, from `Fitzroy!` row 1:

```
 1  Property Owner:            DERM/CHRC                      ← owner row (optional)
 2  ALERT INSPECTION SUMMARY   Station: Riley's Crossing       CBM NO. 535095
 3  ID's   Rn = 5858   Rv = 5859   Batt = 5860   Orifice level = 0.844metres…
 4  ALERT  │ Battery Voltage │ Consumption │ Solar │ Transmitter │            ← group row
 5  Station│ Inspect │ Canister │ Stand │ Under │ … │ 0 │ 1 │ 2 │ 5 │ Remarks ← header
 6         │ Date    │ No       │ -by   │ -load │   │ 0 │ 1 │ 2 │ 5 │         ← header (stacked)
 7  2010-05-31  5102431730  12.4  12.1  0.6  …                                ← inspection row
 …
22  ENTER ANY NEW DATA FROM THE ALERTS TAB                                    ← marker
23  #VALUE!                                                                   ← marker
30  END IF DATA IF FORMULA IS "SPILL" INSERT                                  ← marker
34  Property Owner: …                                                         ← next block
```

---

## 1. Block detection

**A block starts at a banner row.** The anchor is a cell matching

```
(ALERT|DATA LOGGER|CR800|RRDL3)\s+INSPECTION\s+SUMMARY
```

case-insensitively, anywhere on the row. There are 1,420 of them: ALERT 1,286,
DATA LOGGER 131, CR800 2, RRDL3 1 — which reproduces #122's breakdown exactly.

**A block ends at the row before the next banner**, or at the last used row of
the sheet. Do not end a block on a run of blank rows: the gap between blocks
varies, and some blocks have blank rows *inside* them — a station with a break
in its service history, or a spacer left by whoever pasted the block in.

**The banner is not always where the form family is.** Column A of the group
row often repeats it (`ALERT`, `TM`, `BASE STATION`), and `Closed stations`
carries Mace blocks under a `DATA LOGGER INSPECTION SUMMARY` banner —
distinguishable only by the columns (Mace No, sleep/operating/interrogation
current, phone socket voltage). Take the family from the banner, and take the
**configuration** from the resolved header. `FAMILY_TO_CONFIG` in `survey.py`
maps banner → `meganet.inspection_config.key`; a block whose header carries
`Mace No` is `mace` regardless of what its banner says.

**One block has no header of its own.** `Herbert!710` is a banner dropped into
the middle of another station's run of data rows — a station renamed partway
down. A block with no header row within six rows of its banner **inherits the
header of the block above it on the same sheet**. There is exactly one such
block in the workbook; if a second appears after a workbook refresh, the
extractor should say so rather than silently inheriting.

**A block can carry two header bands.** `Mary!600` has a header row, and then a
*second complete header* below it — a re-template where the old header was left
in place. The band nearest the data wins, because that is the one the rows below
were entered under. The tell is not the word "Date" (`Inspect` over `Date` is
one header split across two rows) but a full header row sitting directly under a
row of **group labels**. `is_second_band()` implements exactly that.

---

## 2. Block header extraction

Everything above the column header describes the station, not the visit.

**Station name.** A cell matching `^STATION\s*[:.]?\s*(.*)`. If the label cell
carries the name (`Station: Boompa Road`), take it from there; otherwise take
the next non-empty cell to the right that is not the CBM label.

**CBM number**, in three passes, in this order:

1. A cell matching `\b(CBM|CMB|BUREAU|BOM)\b\s*(NO\.?|NUMBER)?\s*[:.]?\s*(.*)` —
   note `CMB`, which is a typo the workbook has, and take the tail if the label
   cell carries the number (`CBM NO. 58206`).
2. Otherwise the next non-empty cell to the right of that label.
3. Otherwise — and this is the pass #122's survey lacked — **the rightmost bare
   4-to-8-digit token on the banner row.** `Ipswich` prints the number in a
   fixed column with no label at all, for all 27 of its blocks.

44 blocks still have no number after all three passes. They are not an error:
they are blocks whose banner never had one, and #125 resolves them by name.

The number is **text, not a number.** `040893` and `40893` are the same station
and the leading zero is real; `531043.2`, `531043.3` and `531043.4` are three
sensors at one site; `33205/33291` is one block covering two numbers. Never
coerce it, and normalise only for *comparison* (strip leading zeros, strip a
trailing `.0`) — never for storage.

**The `ID's` line.** Structured where the vocabulary is closed, raw otherwise:

| Field | Pattern | Example |
|---|---|---|
| `rain_alert_id` | `Rn = <digits>` | `Rn = 5858` |
| `river_alert_id` | `Rv = <digits>` | `Rv = 5859` |
| `battery_alert_id` | `Batt = <digits>` | `Batt = 5860` |
| `mace_id` / `logger_id` | `Mace = …` / `Logger = …` | `Mace = 7246` |
| `orifice_level_raw` | `Orifice level = …` | `Orifice level = 0.844metres/ 162.694m AHD as at Aug 2020` |
| `key_number_raw` | `Key# …` | `Key# DNR 20101` |
| `phone_no_raw` | `Phone No. …` | `Phone No. 07 5463 2831` |

The last three stay **raw strings**. `Orifice level = 0.844metres/ 162.694m AHD
as at Aug 2020` carries a level, a datum, a second level and a date, in prose,
in one cell; parsing it into fields would be inventing structure the workbook
does not have. The whole line is also kept verbatim as `ids.raw`, so nothing on
it is lost.

**Notes that ride on the group row.** Technicians parked per-station facts on
the header row, where they end up prefixed onto the column label underneath:
`Phone No: 07 4676 4290 Lithium Batter Voltage (v)` is one column and one fact.
The survey splits them (`strip_block_note`) and attaches the fact to the block:
36 phone numbers, 8 repeater windows, 55 ALERT-id notes (`Rain: 4004`), plus 139
notes that match no pattern and are kept as `group_row_note`.

---

## 3. Header-row resolution

**The stack.** The header occupies one to four consecutive rows, and a column's
label is the non-empty cells of those rows, top to bottom, joined with a space:
`Stand` + `-by` + `(mA)` → `Stand -by (mA)`. Repeated tokens are collapsed
(`Logger No` over `Logger No` is one label, not two).

**The group.** The row(s) between the `ID's` line and the header carry group
labels — `Battery Voltage`, `Consumption`, `Solar`, `Transmitter`, `TBRG`,
`River Calibration`. They are **merged cells**, and the merge span is the only
honest way to know which columns a group covers: left-anchored guessing gives
`Fade Margin` the group `Transmitter` on every `Fitzroy!` block, because the
merge ends at `Ref` and the guess does not. Read `mergeCells` from the sheet.

Three refinements, each of which the workbook forces:

- A group cell whose text is **only a number** is the stray duplicate of the
  calibration-point row (480 blocks have one). It is not a group label.
- A group cell that matches a **block-note** pattern (phone, key, repeater
  window, frequency) is a note, not a group. Check notes *before* groups.
- A column with no group whose label is **only a unit** (`(mA)`, `(v)`) takes
  the nearest group to its left. A unit is never a whole column name, and this
  is the one case where the merge span is missing rather than meaningfully
  absent.

**The canonical vocabulary.** 388 distinct labels survive resolution, and
[`inspection_field_map.json`](../tools/ingest/inspection_field_map.json) maps
every one of them onto **59 canonical fields** (56 of which the workbook actually uses), named the way
`db/migrations/0009_inspections.sql` names them wherever that migration already
has a column. The mapping is an ordered list of regular expressions, first match
wins, and the file records which label each rule caught — so a rule that stops
matching shows up in the diff rather than silently dropping a column.

Nine labels are **unmapped**, each with a reason, and they account for **3 of the
226 layouts and 3 of the 1,420 blocks**:

| Label | Why not |
|---|---|
| `Column4` … `Column10` (7) | Excel table placeholder headers over empty columns on `TM Only` |
| `Putty Log` | a note about how the reading was taken, not a reading |
| `Cons. (mA)` | `Burrum Cherwell!K240` — a bare consumption column with no group cell of its own; standby or transmit is not recoverable, so it is rejected rather than guessed |

**Concepts covered**, as #123 asks: station number, inspect date, canister/Mace/
logger number, battery standby and under-load voltage, lithium battery,
standby/transmit/sleep/operating/interrogation consumption, solar output, short
circuit, regulated voltage, charge current and step-up, mains charger,
transmitter forward/reflected/SWR/size/deviation, fade margin, RSSI, antenna
tests per frequency, decoder and receiver voltages and serials, TBRG
calibration, the river calibration grid, shaft-encoder increments/revs/result/
error, gas cylinder/feed pressure, bubble rate, gas consumption, DP counter,
phone socket voltage, and remarks.

### What #126 has to add

Three canonical fields have no home in `0009_inspections.sql` yet. They are
named here so #126 inherits a list rather than a surprise:

- **`river_calibration_point`** — `meganet.calibration_kind` has seven kinds and
  none of them is the river calibration grid these sheets print. It needs an
  eighth (`river_calibration`, section `water_level`), and `expected_result` /
  `result` are the right columns for (point, reading).
- **`consumption_standby_ma` and `consumption_transmit_ma`** —
  `meganet.inspection_power` has sleep, operating and interrogation, because
  that is what the *paper* form prints. The ALERT blocks print standby and
  transmit, on 881 and 834 blocks respectively.
- **A raw-string companion for every numeric column.** See §5.

---

## 4. The variable calibration block

River and gas calibration columns are **per-block**, not per-sheet. The survey
finds **52 distinct point sets**: `0,1,2,5,8,10,15,20,30` on 431 blocks,
`5,10,15,20` on 43, `0,1,2,5,10` on 20, and a long tail down to one block each.

Three rules:

1. **The points are the header labels.** A header column whose resolved label is
   purely numeric is a calibration point, and its value on a data row is the
   reading at that point. Land them as a list of `(point, reading)` pairs —
   never as fixed columns, and never assume the *n*th point is the same metres
   value in two blocks.
2. **The stray duplicate above the header is not the point set.** 480 blocks
   have a numeric row sitting on the group row. Ignore it; the row inside the
   header band is the header.
3. **A point row inside the data redefines the points below it.** `Fitzroy!`
   rows 19, 22 and 52 are `0 · 0.125 · 0.25 · 0.5 · 0.75 · 1` dropped between
   inspection rows, and the rows under them read `0 · 75 · 150 · 300 · 450 ·
   600` — the site changed instrument and the calibration scale changed with it.
   199 such rows exist. **A reading is paired with the most recent point row
   above it, and the block header only until the first one appears.** Getting
   this wrong silently rescales a station's river calibration history.

---

## 5. Value coercion

The governing rule is #122's acceptance, and it is absolute: **the source string
is retained in every case.** Every numeric column needs a raw companion — a
`text` column beside the `numeric` one, or a JSONB blob of raw cells per row —
because a fade margin of `>30` is a real observation, coercing it to null loses
it and coercing it to `30` invents precision.

Measured over the data rows of the 54 ingested sheets:

| Class | Count | What it is | Rule |
|---|---|---|---|
| `number` | 196,713 | a numeric cell | value + raw |
| `short_text` | 8,510 | a word or two | raw only |
| `prose` | 6,209 | over 40 characters — remarks | raw only |
| `qualified` | 3,302 | `<1`, `>21`, `>30`, `>9.0`, `<1ma` | **bound + raw, no point estimate** |
| `status` | 2,694 | `-`, `N/M`, `?`, `OK`, `N/A`, `U/S`, `reset`, `nil` | status code + raw, value null |
| `numeric_text` | 1,073 | a number stored as text | value + raw |
| `range` | 308 | `4/0.5`, `30/600` — two readings in one cell | raw only, flagged |
| `number_with_unit` | 253 | `10.4mm`, `13v` | value + unit + raw |
| `error` | 19 | `#VALUE!`, `#REF!` in a data row | raw only, flagged |

**Qualified values yield a bound, not an estimate.** Store the operator and the
number (`>`, `30`) and leave the numeric value null. A fade margin of `>30` means
the technician's meter stopped at 30 — the true value is unknown and any
"estimate" is fabricated. Reporting can decide what to do with a bound; the
loader must not decide for it.

**Status words are a closed list, and `-` is the commonest cell in the workbook
after a number** (1,984 of them). `-` means *not applicable or not measured*, and
it is not the same as an empty cell, which means *nobody wrote anything*. Keep
the distinction: it is the difference between "there is no TBRG here" and "we
did not get to it".

**Excel errors.** 707 `#VALUE!`, 22 `#NAME?`, 21 `#N/A` and 1 `#REF!` in the
workbook; only 19 are inside data rows and the rest are on the spill-formula
marker rows. A reader that treats an error cell as empty will silently pass
them; treat `t="e"` as its own kind, keep the error text, and flag the row.

**Prose in a numeric cell.** `Unable to access battery box` sits where a
transmit current should be. It is a `short_text`/`prose` value in a numeric
column: keep the string, leave the numeric null, and flag — it is usually the
most informative thing on the row.

---

## 6. Dates

Four forms reach the date column:

| Form | Rows | Precision | Notes |
|---|---|---|---|
| Excel datetime | 18,873 | day | the common case |
| Text `d/m/y` | 1,525 | day | 1,448 with a four-digit year, 77 with two |
| Year only | 9 | **year** | rows like `1990` beside "Station installed." |
| Unparseable | 40 | — | rejected, see §8 |

**The order is day/month/year, and the workbook proves it.** 1,058 text dates
have a first component over 12; **not one** has a second component over 12. A
month-first reading would require 1,058 impossible months and produce zero
impossible days, which is not what a real date set looks like. Two-digit years
pivot at 50 → 1950-2049, which comfortably covers the workbook's actual range.

**Year-only rows are not dated inspections.** Carry a precision alongside the
date. A row that says only `1990` should not appear in a history view as
"1 January 1990", and #128 needs to be able to tell.

**Implausible dates are rejected, not repaired.** Six rows fall outside
1980-2025:

```
Logan!991      '23/6/215'              → 0215-06-23      a dropped digit
Logan!886      '23/6/215'              → 0215-06-23      (the hidden twin of the same row)
Johnstone!459  '08/11/219'             → 0219-11-08
Johnstone!501  '15/10/208'             → 0208-10-15
Burdekin!162   '1900-01-03 21:00:00'   → 1900-01-03      Excel's zero-ish sentinel
Burdekin!136   '1900-01-03 21:00:00'   → 1900-01-03      (hidden twin)
```

Three are obviously `2015`, `2019` and `2008`, and it is obvious to a person
rather than to a rule. #122's non-goals are explicit that the historical record
is not corrected: reject them with the raw cell, and let a person decide.

Excel's own date arithmetic needs the 1900 leap-year bug (serial 60 is a day
that never existed); `tools/ingest/xlsx.py` handles it.

---

## 7. The `ALERTS` tab and its basin twins

`Master (2)` says **"ENTER ANY NEW DATA FROM THE ALERTS TAB"**, and that
instruction and its companions account for 1,856 marker rows across the
workbook. The process was: enter on the flat `ALERTS` tab, then copy the row
down into the station's basin block.

So rows exist twice, and the survey measured how often:

> Of the **228** rows on `ALERTS`, **221 are already on a basin tab** and **7 are
> not** (`ALERTS!87`, `94`, `171`, `200`, `210`, `224`, `230` — mostly 2024
> visits, one of which has `#N/A` where its station number should be).

**Matching rule:** two rows are the same inspection when the **visit date** is
equal and **either** the station name (lowercased, non-alphanumerics stripped)
**or** the station number (leading zeros stripped) matches.

**The basin block wins.** It is the canonical home the workbook's own
instruction names, and it carries the full column set. The seven unmatched
`ALERTS` rows are ingested from `ALERTS` — they are the only record of those
visits — and marked with their origin so the asymmetry is visible later.

---

## 8. Rows that are not inspections

Inside a block, every row that is not an inspection gets classified. This is
what makes #122's "no silent drops" acceptance checkable — the classes sum to
the block, and the extractor's rejects file should carry the same labels.

| Class | Count | What to do |
|---|---|---|
| `marker` | 1,856 | ignore — `ENTER ANY NEW DATA…`, `END IF DATA…`, `STATION CLOSED …` |
| `error_only` | 630 | ignore — the `#VALUE!` under a spill formula |
| `next_block_owner` | 592 | the following block's `Property owner:` row; attach it to that block |
| `annotation` | 336 | **keep** — "Station not inspected by BoM in 2020 due to COVID restrictions", "No maintenance agreement - not inspected since commissioning", "Station ownership handed over from LVRC to SEQWater". These are the reason a gap exists, and they exist nowhere else |
| `calibration_point_row` | 199 | §4 rule 3 — redefines the points below |
| `unresolved` | 75 | **reject with the row reference** |
| `undated_data` | 55 | **reject** — readings with no date at all (`Brisbane!312` has a full row of readings and a remark, and no date) |
| `malformed_date` | 40 | **reject** — a date cell that no parser should accept: `"9/11/2004` with a stray opening quote, `12/5//97`, `4/1/2/2012` |
| `repeat_header` | 5 | ignore — a header repeated mid-block |

**170 rows need a reject reason**, against 20,407 that load. That is the number
#124 reconciles: loaded + rejected = every row inside every block, with nothing
in between.

---

## 9. Threaded comments

62 cell comments across 12 sheets, 8 of them threaded. They are technician notes
that exist in no cell — *"HS3 - Should have been recalibrated."*, *"expected
41.5"*, *"Can't power through solar plug in the top. It locked up the canister in
test mode."* — and they are invisible to anyone not opening the file in Excel.

**Extract them.** They attach to a cell, so they attach to (block, row, column),
which resolves to an inspection and a field. Where the row is not an inspection
row, attach to the block.

Excel writes a threaded comment **twice**: the real text under
`xl/threadedComments/`, and a legacy stand-in in `xl/comments*.xml` beginning
*"[Threaded comment] Your version of Excel allows you to read this threaded
comment…"*. A naive reader gets the boilerplate. `tools/ingest/xlsx.py` reads
both and the manifest carries the real text, with the author where the legacy
part records one.

---

## 10. Provenance

Every extracted row carries where it came from, and the identifier is stable
across re-runs so that a second run updates rather than duplicates —
`meganet.inspection.source_ref` already has a unique index for exactly this.

```
qld-all-site-inspections:<sheet>:<banner row>:<row>
```

- **workbook** — the constant prefix, because a second historical workbook is
  not unimaginable.
- **sheet** — the worksheet name verbatim, `!` and trailing spaces included
  (`NSW Lismore ` has one, and `Logan` and `Logan!` are different sheets).
- **banner row** — the block's banner row number, which identifies the station
  block within the sheet.
- **row** — the 1-based worksheet row of the inspection.

Rejects carry the same identifier plus a reason, so a rejected row can be found
in Excel by opening the sheet and going to the row. `meganet.inspection.origin`
is `'import'` for everything this epic loads — 0009 already has the column, and
the point of it is that a backfilled row must never read as one somebody typed
today.

---

## Reconciliation against #122

| Figure | #122 | Survey | Agrees |
|---|---|---|---|
| Worksheets | 59 | 59 | ✅ |
| Visible / hidden | 44 / 15 | **45 / 14** | ❌ |
| Station blocks | 1,420 | 1,420 | ✅ |
| Banner families | 1,286 / 131 / 2 / 1 | 1,286 / 131 / 2 / 1 | ✅ |
| Free-text remark cells (>40 chars) | 7,932 | 7,932 | ✅ |
| `#VALUE!` / `#REF!` | 707 / 1 | 707 / 1 | ✅ |
| Distinct CBM numbers | 1,098 | 1,123 | ❌ |
| Blocks with no CBM on the banner | 55 | 44 | ❌ |
| Distinct station names | 1,083 | 1,067 | ❌ |
| Dated inspection rows | ~18,500 | 20,407 | ❌ |
| Distinct column-header layouts | 61 | 226 | ❌ |

The five that agree exactly are the five that need no interpretation, which is
reassuring about both readers. The six that differ — five of them, since the CBM
count and the count of blocks without one have the same cause:

**Visible/hidden (45/14, not 44/15).** The workbook's `state` attribute is
unambiguous. The fourteen hidden sheets are the thirteen legacy twins #122
lists — `Barron`, `Burdekin`, `Burrum Cherwell`, `Don`, `Haughton`, `Herbert`,
`Logan`, `Mary`, `Master`, `Moonie`, `Pioneer`, `Redlands`, `Townsville` — plus
`SLS 26092023`. #122's own list has thirteen names in it.

**CBM numbers (1,123 distinct, 44 unlabelled).** This survey's third pass finds
the number on sheets that print it with no label (§2). More blocks resolve, so
fewer are unlabelled and more distinct values appear — 1,035 if the values are
also normalised for leading zeros and `.0` suffixes, which brackets #122's
1,098. The number to trust is the rule, not the count; §2 states it.

**Station names (1,067).** Same extraction question plus whitespace
normalisation, which collapses `Station:  LOAMSIDE ALERT` and
`Station: LOAMSIDE ALERT`.

**Dated rows (20,407, not ~18,500).** #122's figure is marked approximate and
appears to count only cells Excel stores as dates — which is 18,873 here, within
2% of it. The remainder is **1,525 text dates** (`16/03/06`), **9 year-only
rows**, and the **282 rows on the two flat tabs**, which have no banner and so
were never in a block for a block-based reader to find.

**Header layouts (61 → not reproducible).** #122 does not record how a layout
was counted, and no natural definition lands on 61. Measured here:

| Definition | Count |
|---|---|
| Distinct sets of column positions | 87 |
| Distinct anchor-header-row text | 140 |
| Distinct anchor-header-row text, with column letters | 152 |
| Fully resolved header — group label + stacked rows, per column | **226** |

The count was never the artefact. `inspection_layouts.json` carries all 226 with
a canonical field per column, and 223 of them map completely — which is the
claim #123's acceptance actually rests on.

---

## Open questions

Recorded rather than resolved, per #123's acceptance. All three are also in
`inspection_sheet_manifest.json` under `open_questions`, so the artefacts carry
them and not just this page.

**1. `SLS 26092023` (hidden) — ignore, like `SLS OCT23`?** Both are marked
`skip`/`defer`. Neither is an inspection tab: they are a 34-column station
registry (basin, agency number, flood classes, priority, gauge/telemetry/sensor
type, LGA, owner, maintainer, schedules, hub) which would write to the station
table, not to `meganet.inspection`. **Nothing in this epic is blocked by the
answer** — but the registry overlaps #115's lookup work and may be worth a
separate issue.

**2. Hidden legacy sheets versus their visible `!` twins.** Measured rather than
guessed. Once station identity is normalised (name, or CBM without leading
zeros), **the visible sheets are near-perfect supersets**: across all thirteen
pairs, 1,682 visits exist only on the visible sheet and only **222 exist only on
the hidden one — and those 222 fall into just 18 station keys**, every one of
which is an identity artefact rather than missing history (`c:34029/34097` is a
block covering two CBM numbers, `c:040868.` has a trailing dot, `c:040931key92268`
has a key number in the CBM cell, `n:mtkanigantmalert` is one station named
differently on the two sheets).

> **Recommendation, not a decision:** ingest both and deduplicate on (station,
> visit date). The dedupe collapses almost everything, the visible sheet is
> effectively authoritative, and the 18 odd keys get looked at rather than
> discarded. **#124 should not proceed on this without a yes** — it changes
> whether ~10,000 rows are loaded once or twice.

**3. NSW tabs — in scope, or QLD only?** `NSW Lismore `, `NSW McIntyre`,
`NSW Tweed!` and `NSW Richmond!` are marked `ingest`: 41 blocks, 31 inspection
rows, the same form family and the same crews. Excluding them loses history no
other system holds, and including them costs almost nothing. Flip them to `skip`
in `SKIP_REASONS` if the answer is QLD-only.

---

## For #124

In dependency order:

1. Reuse `tools/ingest/xlsx.py` — it already reads errors, dates, merges and
   both flavours of comment, with no dependencies.
2. `find_blocks()`, `resolve_header()` and `read_rows()` in
   `tools/ingest/survey.py` implement §1-§4 and §8. They are survey code, not
   loader code, but the rules are the same rules and lifting them is cheaper
   than rewriting them.
3. Reconcile against `inspection_survey_counts.json` **before** loading
   anything: 1,420 blocks, 20,407 inspection rows, 170 rejects. A different
   number means one of the two readers changed, and that is worth knowing while
   the table is still empty.
4. Land the staging rows with the raw string beside every value (§5) and the
   provenance identifier on every row (§10).
5. Do not decide open question 2 by writing code that assumes an answer.
