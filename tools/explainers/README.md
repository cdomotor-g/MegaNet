# 🎬 Videos — how one is written

The **Videos** tab (`explainers.js`) plays short drawn videos about Flood-Net
itself: a welcome for a first look or the start of a meeting, and how-tos that
each show one job (EPIC #262). It uses the 📺 Network Bulletin's player
(`makeShowPlayer`, `health-bulletin.js`), so a video is the same thing a
bulletin is: a small JSON file of scenes, each drawn as SVG in the browser
with its words revealed as they are said, voiced by the Droggies' cast through
ElevenLabs (`tools/voice/speak.mjs`).

The difference is how long it lives. A bulletin is voiced every morning and
gone in a fortnight; a video is voiced once and played for months. So the
rules below are about spending ElevenLabs credits once.

## The rules

1. **Evergreen.** Write it to be true next year. Nothing in the words about
   this week.
2. **Silent until final.** A video starts as `"voice": "draft"`. A draft is
   never voiced — it plays on its scenes' own seconds, the words shown as they
   would be said. It is voiced only when it is marked `"voice": "final"`, and
   only after the owner has OK'd the words.
3. **A scene at a time.** Each scene's voice is kept under a key made of who
   says it and what they say. Change one scene's words and only that scene is
   said again; the rest are joined from what was kept.
4. **Words that do not go stale.** Never *say* a number, a date or a tab's
   current label. Draw them: a `figure` counts the stations on file when it
   plays, and a `shot` shows the tab as it is (taken again when it changes —
   below). Say "every station on file", and show the number. The validator
   warns on a digit in a `say`, and on a long tab label said aloud.
5. **Short, by the clock.** How long a video runs is who says it: Graham
   about 2.2 words a second, Turbo 3.0, the Recruit 2.7 (measured off their
   bulletins; `PACE_OF` in `validate.mjs`). A welcome runs at most about two
   and a half minutes said, a how-to a minute and a quarter; the validator
   says how long each will run before a credit is spent. A run of names — the
   capabilities, the sources — goes to a quick voice (Turbo), not a slow one.
   Cut a scene before you thin every scene.
6. **A recast does not re-voice it.** A Droggie recast in the cast file
   reaches a video only when the voice workflow is run by hand with `force`.
7. **Estimate first.** `--dry-run` says which scenes would be said and about
   what they would cost, before anything is spent.

And as everywhere: the app is **Flood-Net**, never the repository's name; and
Flood-Net is **not a flood warning service**, so a video never says or
suggests that it warns anybody of floods.

## Who

- **The welcome**: Graham Watts, the Seasoned Hydrographer (he/him), alone.
  Calm, modest, dry; teaches by showing, not lecturing.
- **The how-tos**: the New Recruit (he/him, *keen but green*) on his first
  day, Graham showing him round. The Recruit asks, Graham shows. Two voices
  cost what one does — ElevenLabs charges by the character.

Every Droggie is in the player's `ROSTER` and `tools/bulletin/validate.mjs`
`PRESENTERS`; their canon (and pronouns) is in
[cdomotor-g/thedroggies](https://github.com/cdomotor-g/thedroggies). Never
mock the profession.

## The file

`data/explainers/<id>.json`; `<id>` is lower case, digits and hyphens, and is
the address's `?watch=<id>`.

```json
{
  "format": "floodnet-explainer/1",
  "id": "welcome",
  "kind": "welcome",
  "title": "Welcome to Flood-Net",
  "summary": "Ninety seconds on what Flood-Net is for, and where to start.",
  "presenter": "seasoned-hydrographer",
  "voice": "draft",
  "updated": "2026-11-03",
  "order": 1,
  "scenes": [ … ]
}
```

`kind` is `welcome` or `howto`. `order` sorts the cards (welcome first, then
how-tos by `order`). Every scene has `type`, `title` (≤ 70), `say` (≤ 420),
`secs` (3–30: how long it plays without its voices — about 2.4 words a second),
and may have `sub` (≤ 90), `presenter` (another Droggie says this scene) and
`stations` (up to 8 ids, shown as buttons that open the station on the map).
The first scene is a `cover`, the last a `signoff`.

| Type | Draws | Fields |
| --- | --- | --- |
| `cover` | the title card: a kicker, the title large, a line under it, a river drawn in, the presenter | `headline`? (else the video's title), `line`? (else its summary), `kicker`? |
| `shot` | **the app itself**: a screenshot of a tab (below), zoomed in on one part, its callouts each ringed, numbered and named as its cue is said; a phone's in a phone's frame | `shot` (a name in `tools/explainers/shots.json`), `focus`? (a part to zoom to), `zoom`? (1–4, the most it zooms), `callouts[]`? (≤ 4: {`target` (a part), `text` ≤ 60, `cue`?}) |
| `tally` | a quick run through a list: up to sixteen tiles, each popping up on the word that names it | `items[]` (2–16: {`text` ≤ 44, `icon`?, `cue`?}) |
| `feature` | a tab sketched — the bar of tabs, the banner's search box, the tab's heading, the shape of what it shows — with one part ringed, and up to three lines beside it (a `shot` shows the real tab; a `feature` is for a page that cannot be shot signed out) | `tab` (an id in `TABS`), `sketch`? (`map` `card` `chart` `list` `table` `player` `form` `tiles`), `lit`? (`rail` `search` `head` `main` `side`), `side`? (a side panel), `points[]`? (≤ 3, ≤ 70 each) |
| `figure` | up to three big numbers, counted up | `figures[]` {`of`? (`stations` `rain` `level` `repeaters` `tabs`: counted live), `value` (shown when there is nothing to count), `label` (≤ 40), `unit`?}, `note`? |
| `map` | the bulletin's map: every station on file, marks and areas | `marks[]`?, `areas[]`? (`sev` `info` or `ok`), `focus`? |
| `list` | the bulletin's list, a line each | `items[]` {`sev` `info` or `ok`, `text`} |
| `signoff` | the presenter, their line, and where to go next | `line`?, `next`? (≤ 60), `tab`? (draws that tab's icon and label) |

A **cue** is a word or a few from the scene's own `say` — `"cue": "link
budgets"` — and is when its callout or tile appears: on the word as the voice
says it, or, playing silent, as the words are revealed. Cues are found in
order (the validator refuses one that is not in the words, or out of order).
The walkthrough scene that drives the real app — opening the tab and ringing
the real control — comes with the first how-to (#265).

## Screenshots

A `shot` scene shows the app as it is, not a drawing of it (the owner, 3 Nov
2026: *"it just needs to look a bit more like the site"*). Each shot is a line
in `tools/explainers/shots.json` — its page (`path`, e.g. `?tab=stations&
station=brisbane_city_al`), `desk` or `phone`, what to wait for (`ready`), any
settings to store first (`store`), anything to hide (`css` — a ▶ in a still
that does not play), and its **parts** (`targets`: a name and a CSS selector
each, the things a scene may zoom to and call out).

```bash
node tools/explainers/shoot.mjs                 # every shot, from https://floodwarning.net/
node tools/explainers/shoot.mjs home health      # the ones named
node tools/explainers/shoot.mjs --tab stations  # every shot of a tab
node tools/explainers/shoot.mjs --probe home    # what is on its page, with boxes, to choose parts
# before a change is deployed: serve the checkout and shoot that
python3 -m http.server 8080 &  node tools/explainers/shoot.mjs --base http://127.0.0.1:8080/
```

It writes `data/explainers/shots/<name>.webp` (1920×1080 for a desk, 780×1688
for a phone) and `data/explainers/shots/index.json` (each shot's size, when
and where it was taken, and the box of each part). Taken **signed out**, so
nothing a signed-out visitor could not see is in a picture — no landholder
details, no site codes (CLAUDE.md, *Private data*).

**When the app changes, a shot does not.** So:

- taking one again is **free** — nothing is voiced, no credits — and needs no
  owner's OK unless the words over it are no longer true;
- `npm run explainers` opens each shot's page in the app as it is now and
  **fails a shot whose parts have gone**, naming the command to take it again;
- a change that moves or restyles what a shot shows takes that shot again **in
  the same push** (CLAUDE.md and AGENTS.md, *Videos*). A restyle the check
  cannot see is the author's to notice: look at the shots of the tab you changed.

If a change makes a final video's **words** wrong, say so on its issue: the
words are the owner's to approve again, and voicing the changed scenes spends
credits.

## The steps

```bash
cd /home/user/MegaNet && git pull --rebase origin main

# 1. Write data/explainers/<id>.json as a draft. Check it, and list it:
node tools/explainers/validate.mjs --write-index

# 2. Push it. It plays silent on the Videos tab at once — no credits spent.
#    Post the script on the video's issue, with the link
#    (https://floodwarning.net/?watch=<id>), and wait for the owner's OK.

# 3. With the OK, set "voice": "final", check it again, and see what voicing
#    it would cost:
node tools/explainers/validate.mjs --write-index
node tools/voice/speak.mjs data/explainers/<id>.json --dry-run --cast https://cdomotor-g.github.io/thedroggies/voices/cast.json

# 4. Push. The Bulletin voices workflow (bulletin-voice.yml) voices it and
#    commits data/explainers/voice/<id>.{json,mp3}, its kept scenes and the
#    index's length as said.
```

A push that touches only `data/explainers/` starts no web smoke test and needs
no version stamp: the page fetches the files fresh, and the service worker
keeps a copy for no signal.

To change a voiced video's words: edit the scenes, push. Only the scenes whose
words changed are said again. Turning it back to `"draft"` keeps its kept
scenes for when it is final again, and it plays silent meanwhile.

## On the site

- **🎬 Videos** lists the videos as cards; the one picked plays in the player.
- **⛶ Full screen** (or **F**) — for a meeting room: the picture fills the
  screen, the words large under it, the bar hidden while it plays. A
  presentation clicker's Page Down / Page Up (or the arrows) move a scene; Esc
  leaves.
- **🔗 Copy link** — `https://floodwarning.net/?watch=<id>` opens the video
  ready to play, and its first ▶ goes full screen.
- **📥 Keep for no signal** — fetches the video, its words and its voices so
  the device's saved copy has them, for a venue whose Wi-Fi cannot be trusted.

## The MP4

Every voiced video also gets an MP4 (#268): `tools/explainers/record.mjs`
opens the Videos tab in Chromium in its meeting layout and draws it **a frame
at a time on the player's own clock** — each scene's motion at that moment,
its words revealed as the voice file says them — piping the frames to ffmpeg
with the video's own MP3. No credits: the voices are the ones already made.

```bash
node tools/explainers/record.mjs welcome      # one video (1920×1080 at 30 fps)
node tools/explainers/record.mjs --pending    # every voiced video whose MP4 is missing or out of date
```

It writes `data/explainers/video/<id>.mp4` (H.264 + AAC, under 25 MiB),
`.vtt` (captions) and `.json` (the voice it was made from), and the index
offers ⤓ **Download MP4** only while that voice is the one there is now. The
**Video MP4s** workflow (`explainer-video.yml`) runs it after every Bulletin
voices run, so a video voiced again gets its MP4 again without anybody asking;
run it by hand with `ids: all` after a change to how the videos are drawn.
It is drawn with the tests' own network — the page from the checkout,
nothing off-site — so its counts and map are the committed station list's.

## Files

| File | What |
| --- | --- |
| `data/explainers/<id>.json` | a video |
| `data/explainers/index.json` | the list of them (`validate.mjs --write-index`; the voice workflow refreshes its lengths) |
| `data/explainers/voice/<id>.json`, `.mp3` | its voice: the MP3 and when each scene and word starts |
| `data/explainers/voice/clips/<key>.mp3`, `.json` | one scene as said, kept for the next voicing |
| `tools/explainers/shots.json` | the screenshots, and the parts of each |
| `tools/explainers/shoot.mjs` | takes them |
| `tools/explainers/record.mjs`, `.github/workflows/explainer-video.yml` | the MP4s |
| `data/explainers/video/<id>.mp4`, `.vtt`, `.json` | a video's MP4, its captions, and the voice it was made from |
| `data/explainers/shots/<name>.webp`, `index.json` | the screenshots, and where each part is on them |
| `tools/explainers/validate.mjs` | what a video may hold |
| `explainers.js` | the tab, its scenes and meeting mode |
| `test/explainers.mjs` | `npm run explainers` |
