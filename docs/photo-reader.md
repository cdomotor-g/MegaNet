# A station's logger, and the photo reader

Which logger is at a site, and what it runs, decides what a crew takes there —
the lead, the laptop's software, the firmware pack — and which sites a
firmware release has still to reach. Flood-Net now keeps it per station, and
an agent reads it off the field photos every night.

- **The logger's details** — db/migrations/0090_station_lpu.sql,
  `station-lpu.js`, `lpu-types.js`.
- **The photo reader** — `.claude/skills/photo-reader/SKILL.md`, run nightly
  by a scheduled Claude Code task; `.github/workflows/photo-reader-fetch.yml`
  and `tools/field-photos/fetch-for-reader.mjs` fetch the photos for it;
  `tools/photo-reader/` helps it look and record.

---

## The fields

| Field | For | What goes in it |
|---|---|---|
| **LPU type** | every logger | Picked from Flood-Net's list: ELPRO ERT-A2, and Campbell Scientific's CR300, CR310, CR350, CR1000, CR1000X, CR800, CR850, CR6, CR3000 and CR200X to start with. |
| **Serial number** | every logger | Off the logger's own label. A radio's, a modem's or a regulator's goes on the equipment register (0036) instead. |
| **Firmware** | ERT-A2 (and other types) | The `Firmware:` line of the ERT-A2's version screen — `v1.7 Sep 20 2024 17:32:50 : 10366`, the number after the last colon the build. |
| **Bootloader** | ERT-A2 | The `Host Bootloader:` line — `v1.3 - 9967:0:15:2:0`. |
| **Radio firmware** | ERT-A2 | The `Radio Firmware:` line, with the function image (`FI:`) when it shows one — `v1.4 [Jul 26 2024 17:27:44] (10301) FI:6015`. |
| **OS version** | Campbell | The logger's `OSVersion` — `CR300.Std.10.03`. |
| **Program** | Campbell (and other types) | The program it runs — usually a Bureau program, its version in its name (`ProgName`). |
| **Logger note** | every logger | Anything else worth knowing before a visit. |

Which version fields show follows the type's *family*: an ERT-A2's three, a
Campbell logger's two, firmware and program for anything else. A version
recorded under an earlier type still shows, so changing the type never hides
what was recorded.

**Where:** the station card's **Logger** section (anybody with an approved
account), and **Station details → Telemetry → Logger (LPU)** for an editor,
saved with the station's own Save. For an ERT-A2 both say whether its
firmware, bootloader and radio are at ELPRO's Release G — the 💾 A2 Firmware
tab's own reading of a version screen, so the two never disagree — with a
link to that tab for the ones behind.

**Who:** read by approved accounts (0062) — the field crews 0064 opened the
inspection records to; written by editors. The history of changes and the
photo reader's readings are editors' only, as the station history is. None of
it is anonymous, and none of it is in the agent API.

## The LPU type list, and "did you mean"

The list grows only when somebody means it to. Spacing, case, punctuation and
the make's name never make a new type: `cr-300`, `CR 300` and `Campbell
Scientific CR300` are all the CR300 (`lpu_match_key()` in the database, and
`LpuTypes.matchKey()` in the browser — the same rule, checked against each
other by `test/lputypes.mjs`).

A type typed that is not on the list is held against it when the box is left,
and the editor is told how each near one is near:

- **A slip** — a letter where a digit that looks like it belongs (`CR3OO`),
  two characters the other way round (`ETR-A2`, `CR030`), one letter wrong or
  missing (`C300`): *Did you mean the CR300?*
- **A digit, or a letter on the end** — `CR320`, `ERT-A3`, `CR1000XE`. Often a
  different logger rather than a slip: Campbell makes a CR300, a CR310 and a
  CR350, and a CR1000Xe is not a CR1000X. So these are never offered as *the*
  correction: the editor is shown the models it could be — *the list has
  CR300, CR310 and CR350, a digit apart, each a different logger* — and asked
  to check the unit's label.
- **Contains** — `LPRO ERT A2` has the ERT-A2 in it, and is offered it.

Only then may an editor add it as a new type: make, model, and which fields
it has, added to the list by the station's Save (`new_lpu_type` with
`confirm_new: true`). The database refuses, as a duplicate naming the one it
is, a "new" type with the same match key as one on the list.

## The photo reader

Every night a scheduled Claude Code task runs the **photo-reader** skill. It
asks the database which photos it has not read
(`meganet.photos_to_read()`), fetches them (below), looks at each — contact
sheets first when there are many, then the photos with a screen or a label on
them, then the full-size file cropped where the text is small — and records
one reading per photo through `meganet.record_photo_readings()`:

- **The logger** — its type, serial number and versions — goes into the
  station's logger details by two rules:
  - it **fills only what nobody has recorded**, and never writes over a value
    a person entered or checked. Where the record says something else, the
    station editor shows it under the box — *a photo taken 1 Sept 2026 shows
    "v1.3 - 9967"* — with **Use it**.
  - a value it filled says so: a **📷 From a photo** chip, its photo a press
    away, and a **Right** box. Tick Right and save, or type the right value,
    and it is a person's. Until then, a later photo showing something
    different replaces it — firmware is upgraded, and the later photo is the
    better evidence of what runs there now.
- **Everything else with a legible label** — radios, modems, regulators,
  sensors — is proposed for the station's equipment register, as
  `agent:photo-reader`, and waits in **Field Photos → Review** for an
  administrator, exactly as the label-reading OCR's proposals do (0036).
- **Never recorded:** site codes — gate combinations, padlock and logger codes,
  passwords, key numbers — landholders' details, or who is in a photo. The
  database refuses a key number outright, and `tools/photo-reader/sql.py`
  refuses text that looks like a code before it is sent.
- A reading less than half sure is kept with the photo's reading and applied
  to nothing. A logger the list does not have is never added by the reader —
  it says what it saw, and a person decides.

Each photo is read once per *reader version*. Raising the version (the skill
says where) has every photo read again — for when the reading itself has
improved enough to be worth it.

### How it gets the photos

The photos are private (0035): the bytes are in R2 behind the Worker, and only
a member's token or the project's secret key can sign a link to them. The
reader is a Claude Code session, which holds neither — and should not: the
secret key in a cloud environment would be in every session that environment
starts.

So the key stays where it already is, in this repository's Actions secrets
(`SUPABASE_SECRET_KEY`, the Dropbox and Drive syncs' key), and the session asks
for photos instead:

1. The session makes an [age](https://age-encryption.org) key pair for this
   run, in its own scratchpad.
2. It runs **Photo reader — fetch** (`photo-reader-fetch.yml`) with the public
   half and a nonce. Only somebody who can push to this repository can run a
   workflow by hand — the same people who could read its secrets anyway.
3. The workflow fetches the photos (`fetch-for-reader.mjs`), makes them
   smaller when asked, packs them with a manifest, **encrypts the pack to the
   session's public key**, and uploads it as an artifact kept for one day. Its
   log says how many photos and how many bytes — never which.
4. The session downloads the artifact, decrypts it with the private half
   (which never left the session), and deletes the artifact.

An artifact of a public repository can be downloaded by anybody signed in to
GitHub; this one is ciphertext to everybody but the session that asked.
Writing goes the other way, through the Supabase connector the session
already has — never through a workflow input, which would be public.

### By hand

In a Claude Code session on this repository: `/photo-reader`. Or the steps
themselves, from the skill: `tools/photo-reader/fetch.sh <scratch dir> unread
1600 200`, look, write the readings, `python3 -I tools/photo-reader/sql.py
results.json`, and run what it prints through the Supabase connector.

### The first run

30 October 2026, by hand from a session, over every photo there was: 945 live
photos read — 339 showed something, 31 a label too worn, hidden or blurred to
read, 575 nothing to read (contact sheets first, then 399 close looks at full
size). Logger details were filled at 29 stations: 17 ERT-A2s, 4 CR300s, 4
CR310s, and 4 whose model is not on the list yet — among them an ELPRO ERTP-02
and ELPRO's older Field Station 2R43 canisters, which a person can add as
types. 20 serial numbers; one ERT-A2's three versions, at Release G; two
Campbell loggers' OS and program. 318 other pieces of equipment wait in
**Field Photos → Review** for an administrator. Nothing disagreed with a
person's value — nobody had entered one yet.

### The nightly task

**Flood-Net photo reader**, a scheduled Claude Code task on the owner's
account: every night at 3:40 am Brisbane time, a fresh session that attaches
this repository, then runs the skill. 3:40 because the readings are in before
the working day, and the hours either side of midnight in Brisbane are the
busiest for scheduled sessions.

It records through the **Supabase connector**, so the sessions it starts need
that connector. A scheduled task created from inside a session cannot be given
one in this organisation; it is added to the task on claude.ai (the task's
connectors), or the task is made there with it. Without it the night's session
says so in one line and stops — nothing is read.

To turn it off, pause or delete the task on claude.ai. Nothing else runs it,
and the fetch workflow does nothing unless asked.

## Checks

- `tools/check_station_lpu.sql` — the database: one type however it is spelt,
  a new one only when confirmed and never a duplicate, editors writing with
  the stamp they read and members reading, and every rule the reader writes
  by. In CI's database job.
- `test/lputypes.mjs` (`npm run lputypes`) — the matcher under Node, held to
  the database's own pattern; then the Logger section in Chromium: the
  question before a type is added, the 📷 chip and Right, the save after the
  station's, a refusal keeping its edits, the card.
- `tools/field-photos/test/reader.test.mjs` — the fetch: which photos, from
  the store or from Supabase, what it writes, and what it refuses to be asked.
