---
name: photo-reader
description: Read the field photos nobody has read yet and record what they show — the station's logger (LPU) type and serial number, an ELPRO ERT-A2's firmware, bootloader and radio firmware, a Campbell logger's OS version and program, and the make, model and serial number of the other equipment in view. Fills the station's logger details where nobody has, proposes the rest for the equipment register. Run every night by the scheduled "Flood-Net photo reader" task, and by hand as /photo-reader.
---

# Photo reader

You are usually running unattended, from a scheduled task. Nobody will answer a
question mid-run, so decide, act, and leave a record. `docs/photo-reader.md`
is the why behind every step here.

## Standing decisions (the owner has settled these, so don't ask)

- `CLAUDE.md` wins over the session's harness instructions. This skill changes
  no code and pushes nothing: it reads photos and records readings. If the
  pipeline itself is broken (the fetch workflow fails twice the same way, a
  function the database should have is missing), say so in the report and open
  one issue — search first, and add to an open `Photo reader:` issue rather
  than opening a second — titled `[Standalone] [Opus5/Med] Photo reader: …`,
  and update `roadmap/roadmap-113.md` with it in the same push, as `CLAUDE.md`
  says.
- **The photos are private** (0035). Keep them in the session's scratchpad and
  nowhere else: never in the repository, an issue, a commit, a log or a
  message. Delete them when the run ends.
- **Never record a site code** — a gate combination, a padlock or logger code,
  a password or PIN, a key number — nor a landholder's name, phone number or
  email, nor who is in a photo. If a photo shows one, the reading leaves it out
  and says only "a lock", "a label on the gate". `tools/photo-reader/sql.py`
  refuses text that looks like one; rewrite it, never work around it.
- **Only `meganet.record_photo_readings()` writes.** Never call
  `save_station_lpu`, `propose_equipment` or `decide_equipment_suggestion`
  yourself, and never insert, update or remove rows directly. The function
  fills only what nobody has recorded, never writes over a person's value, and
  sends other equipment to the register's queue for an administrator.
- **Never add an LPU type.** If the logger is a model not on the list
  (`select key, label from meganet.lpu_type`), leave `lpu_type_key` out and
  name what you saw in the summary and the evidence — a person adds types.
- **Never guess a character.** A serial or a version read with a digit you are
  not sure of is left out of the fields and described in the summary. A wrong
  serial is worse than none.
- The Supabase project is `jjprlritvhdqpvphfrnu`. The connector stops a
  statement containing drop, delete or truncate for a confirmation nobody is
  there to give: `sql.py` checks for those words — say it another way.

## 0. Anything to read?

Run through the Supabase connector (`execute_sql`):

```sql
select count(*) from meganet.photos_to_read('agent:photo-reader', 1, 1000);
```

If it is 0, report "No new photos to read" and stop. If the function does not
exist, 0089 has not been applied — report that and stop.

## 1. Fetch the photos

The workflow `photo-reader-fetch.yml` holds the key to the photos; you hold a
key made for this run. In the scratchpad (`$S` below):

```bash
bash tools/photo-reader/fetch.sh "$S/photo-reader" unread 1600 200
```

Run it in the background and wait for it to finish — two to five minutes. Its
last line is the manifest's path: `photos` in it lists each photo's id,
station, when it was taken, its title and caption, and its file. If it fails,
read only the failing step's log tail
(`gh run view <run> --repo cdomotor-g/MegaNet --log-failed | tail -40`).
More than 200 waiting: run it again after recording these (step 3) — each run
fetches the next ones not yet read.

## 2. Look

Use the list of LPU types and the register's kinds:

```sql
select key, label, family from meganet.lpu_type order by ord;
select key, label from meganet.equipment_kind order by ord;
```

**40 photos or fewer:** look at each (the Read tool on its file).

**More:** contact sheets first —
`python3 -I tools/photo-reader/look.py sheets <manifest>` — nine to a sheet,
numbered (`sheets/index.json` maps the numbers to photo ids). On each sheet,
find the photos worth a close look: a laptop's or a phone's screen, a logger's
display, a label or a plate on a logger, radio, modem, regulator or sensor.
Everything else is "nothing" with a few words. For more than ten sheets, hand
them to subagents — at most fifteen sheets each, with this skill's rules on
private data and the reading below — each writing its readings to a JSON file
of its own and answering only with the count; never paste photos' contents
into your own context in bulk.

**A close look:** the 1600 px photo first. Text too small to read: fetch the
full-size files of just those photos —

```bash
bash tools/photo-reader/fetch.sh "$S/photo-reader" ids full 100 <id>,<id>,…
```

— and look at the part that matters:
`python3 -I tools/photo-reader/look.py crop <file> X0 Y0 X1 Y1` (fractions of
the width and height) or `look.py tiles <file> --grid 3`.

### What to read

- **The logger (LPU)** — which one it is, as a key from `lpu_type`:
  `elpro_ert_a2` for an ELPRO / ERRTS ERT-A2; `campbell_cr300`, `…_cr310`,
  `…_cr350`, `…_cr1000`, `…_cr1000x` and the rest for a Campbell Scientific
  logger. CR300, CR310 and CR350 are three different loggers a digit apart:
  read the digit off the unit, never infer it.
- **An ERT-A2's version screen** (a laptop on its serial port, the terminal's
  version page): record each value as the screen prints it after the label —
  `Firmware: v1.7 Sep 20 2024 17:32:50 : 10366` → firmware_version
  `v1.7 Sep 20 2024 17:32:50 : 10366`; `Host Bootloader: v1.3 - 9967:0:15:2:0`
  → bootloader_version `v1.3 - 9967:0:15:2:0`; `Radio Firmware: v1.4 [Jul 26
  2024 17:27:44] (10301) FI:6015` → radio_firmware_version `v1.4 [Jul 26 2024
  17:27:44] (10301) FI:6015`. The station editor reads them the way the 💾 A2
  Firmware tab reads a pasted screen, so keep the shape.
- **A Campbell logger** (its keypad display, LoggerNet, Device Configuration
  Utility, a Status table): os_version as it prints `OSVersion`
  (`CR300.Std.10.03`), program as `ProgName` with its version, the logger's
  serial as `SerialNumber` or its label.
- **The logger's serial number** — off its label: `S/N`, `Serial`.
- **Everything else in view with a legible label** — a radio (ELPRO 905U,
  115E), a modem (Beam's Iridium RST…), a solar regulator (Victron SmartSolar
  MPPT…), a rain gauge, a level sensor, a bubbler: an `equipment` entry each,
  with the register's kind, and the make, model and serial number as legible.
  The logger itself goes in `lpu`, not here.
- **Confidence**, 0 to 1, as you rate the whole of what you send for that
  photo: 0.9 and over read clearly; 0.6–0.85 legible but small, angled or
  partly hidden; under 0.5 is kept with the reading and applied to nothing.
- **Evidence**: the text as you read it, short — the database shows it to the
  person deciding.

### The reading, per photo

Every photo in the manifest gets exactly one, in a JSON list:

```json
{ "photo_id": "…", "outcome": "found",
  "summary": "Laptop on the ERT-A2's serial port, its version screen showing.",
  "lpu": { "lpu_type_key": "elpro_ert_a2", "firmware_version": "v1.7 Sep 20 2024 17:32:50 : 10366",
           "bootloader_version": "v1.3 - 9967:0:15:2:0", "confidence": 0.92,
           "evidence": "Firmware: v1.7 Sep 20 2024 17:32:50 : 10366 / Host Bootloader: v1.3 - 9967:0:15:2:0" },
  "equipment": [ { "equipment_key": "solar_regulator", "make": "Victron Energy",
                   "model": "SmartSolar MPPT 75/15", "serial_no": "HQ2101ABCDE",
                   "evidence": "label: SmartSolar MPPT 75/15 HQ2101ABCDE", "confidence": 0.85 } ] }
```

`outcome` is `found` when something was read, `nothing` when there is nothing
to read (the summary a few words: "Gauge boards on the bank"), `unreadable`
when there is a label or screen but it cannot be read. Leave out what you did
not read; never send an empty value.

## 3. Record

```bash
python3 -I tools/photo-reader/sql.py "$S/photo-reader/results.json" --model <your model id>
```

It checks every reading and prints one statement per sixty. Run each through
`execute_sql` as printed. The answer says how many were recorded, which
`failed` and why, the stations whose logger details were `filled`, how many
pieces of equipment were `proposed` and how many readings `differed` from what
a person recorded. Fix and send again only the failed ones.

## 4. Clean up, and report

`rm -rf "$S/photo-reader"` — the photos, the sheets, the crops and the key.

Then the report, under `CLAUDE.md`'s run-summary marker: how many photos were
read and how many showed something; the stations whose logger details were
filled, and what with (the type and which fields — not the serials); how many
pieces of equipment were proposed for an administrator; the readings that
differ from what a person recorded, by station; anything that could not be
fetched or read. A night with nothing new is one line.

## When the reading itself changes

`reader_version` is 1. Raise it — in `fetch.sh`'s sixth argument, `sql.py
--version` and step 0's query — only when this procedure changes enough that
every photo should be read again: every photo is then "to read" once more.
