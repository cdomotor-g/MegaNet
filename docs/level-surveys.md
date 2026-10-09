# Level surveys

Three tabs under **Surveying** do a station's level survey on a phone:

| Tab | What it is for |
|---|---|
| 📏 **Level Survey** | The survey sheet: site, crew and kit, datum and benchmark, the rise-and-fall run, the water check, and the final field check. Sends the survey to Flood-Net; an administrator reviews it there and applies what it found to the station. |
| 🎯 **Two-Peg Test** | The level's collimation check, linked to the surveys done with that level. |
| 📖 **How to Survey** | A step-by-step refresher on both, with a worked example to practise on. |

Everything works with no signal. Nothing needs signing in until a survey is sent.

## On site

1. **Site** — pick the station by number or name, or press **📍 Near me** for the nearest stations to where the phone is. Not in Flood-Net's list? Type its number and name. Give the date, the purpose and any notes (what was missing from the site's information, anything unusual).
2. **Crew & kit** — the level operator, the staff holder and the organisation (remembered for next time). Pick the level and the staff from your list, or add them — **📷 Read the plate** reads the make, model and serial number off the label. Link the two-peg test done before the trip, or do one now.
3. **Datum** — AHD, assumed (the primary benchmark given 100.000) or the gauge's own. The primary benchmark: its name (`BM<station number>_<n>` is offered), its level, where that level came from, a description another crew could follow, its position (📍) and its photos. Gauge zero: given (Flood-Net's current figure is a tap away), or found from a gauge board you nominate.
4. **Level run** — one row per staff position, in the order read: the opening backsight, intermediates, change points (foresight and backsight on one row), and the closing foresight on the benchmark. Each row says what the staff is on (benchmark, change point, gauge board, CTR, cease to flow, water surface, …), its reading(s), sight distances, the time, a description, photos and — for benchmarks and the CTR — a position. The run is reduced as each sight goes in: rise or fall, the level, the level on the gauge, and any booking error on the row it happened on. **Show the run as a level book** lays it out as the printed columns.
5. **Water check** — the levelled water surface, the gauge board and the logger at as near one time as you can, and the differences; or why there is none.
6. **Check & send** — the final field check, ticked off as you go, each item saying which step fixes it; the points not surveyed, and why; the site overview photo; then **Send to Flood-Net** and the exports.

The limits a survey is held to start at: misclose ±0.003 m, a gauge board ±0.006 m from its face value, sights 30 m, back and fore sights within 5 m of each other, a two-peg test 0.003 m. Each survey can change them (Datum → *Limits this survey is held to*) where the site's figures differ.

## The reading camera

📷 beside any reading opens the camera with a frame the shape of a level's display. Fit the display in it and press the button:

- The picture is cut to the frame, then to the part with text in it, and read by the same OCR engine Flood-Net uses for field photos — in up to three passes: as it is, black-and-white with digits only, and with the strokes thickened, which is what a seven-segment display needs.
- What it read is shown with the picture. **Nothing goes in until you accept it.** A staff reading and a distance on the same display come in together. A decimal point the engine missed is offered back as a suggestion, marked as one.
- The picture is kept as **evidence**: grey, cut to the display, at most 960 px across, compressed to WebP (JPEG where the browser cannot write WebP), with a strip along its foot saying which row and sight, the value taken, when and where. Typically **15–40 kB** each — a hundred readings is three or four megabytes. A reading changed after it was taken says so on its thumbnail.
- Photos of points are kept whole, at most 1600 px, as JPEG — a few hundred kilobytes.
- No camera here, or permission refused: **🖼️** takes a picture with the phone's camera app or picks a saved one, and you drag a box over the display. **⌨️** types the number with no picture.
- The OCR engine is about 7 MB and is fetched once. Press **Get it ready** on the Level Survey tab while there is a signal and it works with none (the service worker keeps it).

## Kept on the phone, sent when there is a signal

Every change is written to the phone's own storage (IndexedDB) the moment it is made — the survey, the two-peg tests, the levels and staffs, and every picture. **Send to Flood-Net** marks a survey to go; it goes at once if the phone is signed in and has a signal, and otherwise by itself as soon as both are true — when the network comes back, when somebody signs in, or when the app is opened. In order: the level and staff (a unit another phone already filed is adopted rather than added twice), the linked two-peg test, the survey, then each picture. Every step can safely be sent again.

A practice survey or test is never sent.

Exports, at any time: an **Excel workbook** (the site and datum, the run with its sums as formulas and the closure, the gauge boards, the checks, the photos listed, and the two-peg test — it opens in Excel, Google Sheets and Numbers), a **CSV** (one row a sight, every column), a **survey file** (`.json`, to open the survey on another device) and a **package** (`.zip`: all of those and every picture). Files are named `floodnet-level-survey-<station>-<date>…`.

## The two-peg test

The level midway between two pegs about 50 m apart, then close to peg A; the two differences A − B, and how far apart they are, which is the error. The tab works it out as the readings go in, holds it to its tolerance, says how far the line of sight rises or falls over 30 m and, for a level that fails, what it should have read on B from the second set-up. A survey links the latest test for its level; the final field check flags a test that failed or is more than 30 days older than the survey.

## Who may do what

| | Signed out | Signed in (on the editors list) | Administrator |
|---|---|---|---|
| Survey, reduce, export | ✓ | ✓ | ✓ |
| Send a survey or a test to Flood-Net | waits on the phone | ✓ | ✓ |
| See the surveys filed | | ✓ | ✓ |
| Apply a survey to its station; return one for completion | | | ✓ |
| Change a station's gauge zero, its datum or its dates in the station editor | | | ✓ |

An administrator opens a filed survey from the Level Survey tab's list. The **Apply to the station** panel sets what the survey found beside what the station holds — gauge zero, the benchmarks, the sensor reference, cease to flow, the gauge boards, and the offset correction the water check implies — ticked by default only where it is new and the run closed within its limit. Applying writes them in one transaction and logs each change with what it replaced:

- **gauge zero** becomes a new row of the station's gauge survey from the survey's date, the open row closed the day before — so the station's flood peaks are put into AHD through the new zero from then on;
- **points** (benchmarks, CTR, cease to flow, boards) supersede the station's current point of the same kind and name, keeping the old one;
- an **offset correction** is recorded with the offset after it, where known, and the sensor.

An applied survey is a record and no longer changes; a correction is a new survey. **Return it for completion** sends a survey back with a note; its crew finishes it and sends it again.

## What the database keeps

`db/migrations/0060_level_surveys.sql` — the levels and staffs, the two-peg tests (their error and pass worked out by the database from the four readings), the surveys (the whole document, with ΣBS and ΣFS summed by the database; a survey that says it closed must carry the misclose its own readings give), the pictures' records, what a station holds once applied, and every decision. All of it is readable by editors only. The pictures themselves are in the private `level-surveys` storage bucket, which `tools/storage_bucket.sql` creates. `tools/check_level_surveys.sql` proves the rules against a real Postgres; `test/levels.mjs` holds the arithmetic, the sheet, the camera's readers and the exports.

Until 0060 and the bucket are applied to the live project, surveys work in full on the phone and say they are waiting for Flood-Net to be ready for them; exports work as normal.
