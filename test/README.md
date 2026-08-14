# `test/` — the web app's safety net

Built for [#130](https://github.com/cdomotor-g/MegaNet/issues/130), which gates the
`app.js` decomposition ([#129](https://github.com/cdomotor-g/MegaNet/issues/129)).

Before this existed, the entire mechanical check available to anyone editing the
front end was `node --check app.js`. That proves the braces balance. It cannot
see a function that moved out of scope, a namespace that lost a member, a
duplicate top-level name quietly overwriting a helper, or an `onclick` naming an
identifier that no longer resolves — which is every failure mode the split
risks, and the two live TDZ crashes in
[#131](https://github.com/cdomotor-g/MegaNet/issues/131) besides.

## Running it

```sh
cd test
npm install                       # once
npx playwright-core install chromium   # once, if no browser is present
npm run all                       # the twelve that run in CI
```

| Command | What it does |
|---|---|
| `npm run check` | `node --check` over every script `index.html` loads |
| `npm run names` | no duplicate top-level declarations across those scripts |
| `npm run toplevel` | `init.js` is still the only file that executes at load |
| `npm run smoke` | loads the page in Chromium, opens all 19 tabs, asserts a clean console, audits every rendered `on*=` handler, and clicks the RF Changes / Workbench controls |
| `npm run registry` | every Leaflet map and every tab teardown is registered by the file that owns it — and actually fires |
| `npm run nav` | every tab is in the left nav exactly once, under one heading, and findable by its own label and by what it does |
| `npm run shell` | the shell's landmarks, skip link, focus policy and disclosure state; the six-step breakpoint scale; and WCAG contrast for every token pair in both themes |
| `npm run tabs` | EPIC #107's per-tab Definition of Done, per tab that claims to have been through a U-issue: no inline styles, tables wrapped/captioned/scoped, scroll regions named, clickable rows keyboard-reachable, landmarks and controls named, headings stepping by one, and no sideways scroll at 375/768/1440 in both themes — plus the two pattern-level claims (the basin drawing's shortcut condition, and the ARRO chart's palette round trip) |
| `npm run help` | every tab's help entry is real content, every link out of the panel lands, and each walkthrough names itself and fits the rail |
| `npm run insp` | the Inspections form renders what `meganet.inspection_form` says, on all six sheets — with the datastore answered out of the migration |
| `npm run maint` | the Council Maintenance Tasks form renders what the workbook's own filled sheet says — with the fixture read out of the `.xlsx` |
| `npm run history` | a saved record reads back as the sheet it was written on, and exports as it reads — with the records written by the app during the run |
| `npm run concat` | byte-exact concat-and-diff against a recorded snapshot (milestone tool) |
| `npm run all` | the twelve that run in CI |

`npm run smoke -- -v` also prints which off-origin hosts were blocked;
`toplevel`, `registry`, `nav`, `shell`, `tabs` and `help` take `-v` too, to list what
passed as well as what did not — `shell -v` prints every contrast ratio it
measured, in both themes, which is the fastest way to see how much headroom a
colour has before it stops clearing AA, and `nav -v` prints what each search
probe actually found, which is the fastest way to see why a `find` word is not
doing its job.

CI runs `check`, `names`, `toplevel`, `smoke`, `registry`, `nav`, `shell`, `help`, `insp`, `maint` and `history` on every push that touches a root `*.js`,
`index.html`, `styles.css`, `stations.json`, `db/migrations/`, `test/` or the
inspection workbook in `archive/` — see
`.github/workflows/web-smoke.yml`. The `*.js` glob is deliberate: the app's
script list grew as `app.js` was split up — `core.js` and `init.js` in M1, ten
module files in M2, fourteen more in M3, `rf-changes.js` and `workbench.js` in
M4 — and a filter naming each file would have to have been edited by every
milestone. Twenty-six scripts were added across those four and not one of them
changed a line in this directory except the two baselines, which is the claim
the glob was put there to make good.

## Why this is not at the repo root

`docs/floodwarning-net.md:90` states the deployment decision: *"MegaNet is static
files with no build step. An empty build command is correct, not a placeholder."*
A root `package.json` would put that at risk. So the harness has its own
`package.json` down here, and `test/node_modules/` is gitignored. Cloudflare
Pages still sees a repo of static files.

Nothing in `test/` is a runtime dependency of the app. Deleting the whole
directory would not change what a browser loads.

## Decisions worth knowing before you edit these

### The page is served over HTTP, not `file://`

`file://` is a supported mode for the app and deliberately so — it is a field
tool, and someone opening `index.html` off a laptop with no server is
anticipated. But it is a bad mode to *test* in: over `file://` the bundled
`stations.json` is unreachable (`autoLoad()` says so at `app.js:188`), so
`state.data` stays null and twelve of the nineteen tabs render the empty state
instead of themselves. A smoke test that never draws a station table proves very
little.

So `lib/server.mjs` serves the repo root on a loopback port and the test loads
that. Real data — currently ~3,100 stations — through the real render paths.

### Everything off-origin is blocked, except Leaflet

`lib/network.mjs` aborts every request that is not to the loopback origin: the
Supabase datastore, GitHub raw, Overpass, the basemap tile servers. Leaflet is
the one exception, fulfilled from the pinned `leaflet` devDependency rather than
from unpkg.

Three consequences, all intended:

1. `autoLoad()` falls through the datastore to the bundled `stations.json`. The
   run is deterministic, uses committed data, and exercises the fallback path
   rather than the happy one.
2. A run needs no network at all, so it behaves the same on a laptop, in a
   sandbox, and on a CI runner.
3. Blocked subresources appear in the console as `Failed to load resource`. Those
   are the policy working, not the app failing, so `smoke.mjs` filters exactly
   that pattern and nothing else.

#130 asked for one of three approaches here to be picked and documented. This is
the pick: vendor Leaflet, block the rest.

### `pageerror`, not just `console.error`

The single most important line in `smoke.mjs`. An uncaught `ReferenceError`
during script evaluation never reaches `console.error` — it surfaces as
`pageerror`. A test watching only the console would miss the entire class of bug
this exists to catch. `pageerror` is never filtered.

### Opening a tab is not enough — the handler audit and the click phase

Added by [#135](https://github.com/cdomotor-g/MegaNet/issues/135), which pulled
111 top-level names inside two namespaces and needed something that could tell
whether it had broken anything.

An inline `on*=` attribute is a string. The browser compiles it and resolves its
identifiers against the **global** scope, and it does that **at click time**. So
a function moved inside an IIFE stops being reachable from `onclick="foo()"`
with no error at load, no error at render, and nothing thrown until a person
presses the button. `node --check` cannot see it. The duplicate-name check
cannot see it. Neither could this smoke test, which opened every tab and clicked
nothing inside one. `lib/controls.mjs` closes that, two ways:

**`auditHandlers()`** reads every `on*=` attribute the tab rendered, pulls the
callee paths out of it and asks the page whether each resolves to a function.
One `evaluate()` per tab, so it runs on all nineteen — 313 distinct handler calls
across 5,578 attributes on a full pass. It is exhaustive over whatever is on
screen, which is its advantage and also its limit: a control that did not render
is a control it did not check.

Two false positives are filtered, and both are worth knowing about before you
add a third: `document.getElementById('x').click()` reads as a call to a global
`click`, so a match preceded by `)`, `]` or `.` is skipped; and a station called
`Fitzroy River (Qld)` sitting in a handler argument reads as a call to `River`,
so string literals are blanked (to the same length, keeping offsets) before
scanning. It is a reachability check, not a JavaScript parser.

**`exerciseSurface()`** clicks. The script is keyed by the handler each control
names — `Workbench.saveCase`, not `.wb-case-bar button:nth-child(2)` — which
makes it a direct statement about a module's public surface rather than about
its markup, and means a renamed member fails loudly instead of silently
matching nothing. It reports what it could not reach rather than skipping it, so
a control that quietly stopped rendering shows up in the run.

Both were confirmed to go red before being trusted, and they catch different
things:

| Break | audit | click |
|---|---|---|
| a member dropped from the namespace's return object | ✓ `RfChanges.sort()` does not resolve | ✓ `TypeError: RfChanges.sort is not a function` |
| a handler string left naming the now-private function | ✓ `rfcCardFor()` does not resolve | ✓ no control names the member any more |

**Adding to the click script.** Each entry is `{ member, how, note }` plus
optional `needs` (a member that must fire first for this one to be on screen),
`prep` (a field to type into before pressing), and `soft` (the control may
legitimately not render — reported as "not reached" rather than failed). Use
`soft` sparingly: it is the escape hatch that lets a genuinely broken control
pass. Exactly one entry uses it, `RfChanges.focusAnchor`, which only renders when
two or more pasted series resolve to real stations that share one repeater which
is itself in the ACMA threat layer — driving that would pin the test to whichever
stations are in `stations.json` this month.

### The duplicate-name check is separate from the smoke test on purpose

A duplicate top-level `const` throws at load, so the smoke test catches it. A
duplicate top-level `function` **does not** — the later declaration silently
overwrites the earlier one and every caller of the first starts calling the
second. This was verified: adding a second `function esc()` to a split file
leaves the smoke test fully green and only `npm run names` goes red.

With several agents adding helpers to different files during #129, this is the
one genuinely new failure mode the split introduces.

### `toplevel.mjs` — the load order, made checkable

`index.html` loads thirty classic scripts in a fixed order, and the only reason
that order is safe to add to is that **`init.js` is the only file that executes
at load**. A file that merely declares can sit anywhere, because nothing it does
is observable until something calls it. One top-level statement that runs on
sight takes that back — silently, with every other check still green.

Three milestones raised an ordering worry that measuring dissolved in minutes
(`Alert2` ↔ `Serial`, `PathProfile` ↔ `LinkBudget`, `RfChanges` ↔ `Workbench`),
each time by writing this check by hand and throwing it away. #142 needed it a
fourth time, so it is a script.

Inert means: declarations (initialisers are not inspected), `return` inside a
module IIFE, and `window.X = X` exports. The check **descends into module
IIFEs**, which is where every module in this app lives and where a stray
registration would hide. Three statements in the app do run at load; each is
listed in `ACCEPTED` at the top of the file with the reason it has to, and one
of them — core.js's Leaflet canvas patch — genuinely is load-bearing and says so
in its own comment. Adding an entry there makes that file's position mean
something, so say why.

### `registry.mjs` — the half smoke cannot see

Smoke opens all nineteen tabs. It never *leaves* one, so a tab that forgot to
register its Leaflet map or its teardown passes: the tab itself is fine. It is
the leaving that isn't, and it fails in silence — a map missing from the
re-measure list renders at the wrong size after a nav collapse, a module missing
from the stop-list keeps its frame loop or its `ResizeObserver` running behind
whatever tab replaced it. Nothing throws.

Two phases. **Static**: parse every script and require that a file calling
`L.map()` also calls `registerLiveMap()`, `registerTabTeardown()` and
`removeMap()`. This is the one that catches the next tab, the one nobody has
written yet, because it never has to be told the tab exists. **Runtime**: open
the map tabs, spy on `invalidateSize`, collapse the nav and assert every live map
got the call; then leave each map tab and assert its map is actually gone, and
come back and assert it works again. Both phases were confirmed to go red by
deleting `bit-flipper.js`'s registration.

The teardown clause and the re-entry assertions are #143. Until then, three of
the five map tabs — Stations, Bit Flipper and the Workbench — registered no
teardown at all, so their maps outlived the div they were built on and were
still being re-measured on a nav collapse from tabs that could not show them.
`registry.mjs` is what made that legible and is now what keeps it fixed. The
re-entry half is asserted deliberately: a teardown that runs too eagerly breaks
the tab rather than leaking memory, which is the worse of the two failures.

See #142 for why the two registries were inverted in the first place, and #143
for why `removeMap()` exists rather than a bare `map.remove()` — a zoom in
flight when the map goes throws from a timer, where no `try`/`catch` at the call
site can reach it.

### `nav.mjs` — the half smoke never opens

Smoke reaches every tab by calling `switchTab(id)`. It never touches the nav, so
everything about the nav is outside it: a tab could be missing from every group
in `TABS`, or permanently filtered out of the rendered list by the find box, and
all nineteen tabs would still open and still render clean. A user has no
`switchTab()`.

Four claims, and each one is invisible from anywhere else:

- **Coverage.** Every tab in `TAB_LIST` has exactly one button, under exactly one
  heading, in a group labelled by that heading. No group holds more than six
  tabs — a ceiling rather than a style rule, so the next tab has to be filed
  rather than dropped on the end of the biggest pile. That was the state #108
  found: eight of nineteen under one heading.
- **The find box.** Every tab is found by typing its own label, and a table of
  probes asserts that the words people actually type — "packet decoder", "com
  port", "contrail", "pdf", and the two labels #108 renamed — land on the tab
  they describe *and* are the match Enter takes.
- **Its rule.** Best score wins: narrows as a second word is typed, survives a
  word that is on no tab, returns nothing for a query that means nothing, and
  matches from the start of a word rather than anywhere inside one.
- **Its exits.** Picking a tab clears the query, and so does collapsing to the
  rail — where the box that would clear it is not rendered.

This file wrote the matching rule rather than checking one that already existed.
The first implementation required every typed term to match, and the probe for
#108's own example — *"the RF Environment view"* — went red on it: three terms,
no single tab carrying all three. The second matched bare substrings, and the
same probe pulled in the Interference Workbench, because "the" is inside
*hypotheses* and "rf" is inside *interference*. Both are assertions here now.

### `shell.mjs` — the half that renders perfectly and cannot be used

Every other check in this directory asks whether the app *works*. This one asks
whether it can be operated by someone who is not looking at it with a mouse in
their hand, and whether the design decisions six parallel issues are about to
inherit are the ones actually in the file.

Nothing above it can see any of that. A page opens all nineteen tabs with a
clean console just as happily with no skip link, no landmark structure, a focus
ring that disappears on half its backgrounds, a nav that drops focus on `<body>`
every time you change tab, and a dark palette that fails contrast. None of it
throws.

It is also the check that turns #109 from documentation into a contract. Six
per-tab issues (#136–#141) are each told: use the tokens, do not add a
breakpoint, do not remove the focus ring, do not invent a table pattern. Those
instructions are worth exactly what they can be checked against.

Seven claims:

- **The scale.** Every `@media (max-width: N)` in `styles.css` has `N` in
  `BREAKPOINTS`, which is read out of the *running page* rather than re-typed
  here — so the CSS, `NAV_AUTO_COLLAPSE_PX` and `isPhoneNav()` cannot drift
  apart. Both directions: an unnamed width fails, and so does a named step that
  no rule uses, because an unused step is one somebody will "helpfully" pick.
- **Contrast.** Twenty-five text pairs and four control-boundary pairs, in both
  themes, computed from the values the browser resolves rather than from the
  source — so a `var()` chain, a `color-mix()` or a missing dark value is
  measured as rendered. A sentinel colour distinguishes "this token resolves to
  black" from "this token does not exist and the declaration was discarded",
  which is not hypothetical: `--line` was referenced three times and never
  defined, so three borders were not being drawn at all.
- **The focus ring.** `outline: none` appears in the file exactly where an
  allowlist in `shell.mjs` says it may, and every allowlist entry corresponds
  to a rule that still exists. A stale exemption is a licence nobody is using
  and the next person reads as precedent.
- **Landmarks and the skip link.** One banner, one main that can take focus,
  one labelled nav, one labelled complementary — counted *outside*
  `#main-content`, because five tabs render an `<aside>` of their own inside it
  and naming those is each U-issue's job, not this one's. The skip link has to
  be present, first in the tab order, visible when focused, and actually move
  focus rather than only scroll.
- **Disclosure.** Four shell controls open something; each is toggled and its
  `aria-expanded` re-read. Exactly one nav item is `aria-current`.
- **Focus and voice on a tab switch.** Focus lands on the new tab's own nav
  button — `renderTabs()` replaces the nav's `innerHTML`, so the button that
  was clicked is gone by the time the switch finishes, and a keyboard user was
  left on `<body>` every single time. And the guard on the other side: a switch
  from *outside* the shell must not move focus at all, because `switchTab()` is
  also called at startup by `Workbench.restoreFromUrl()`.
- **Sideways scroll.** The document does not scroll horizontally at 375, 768 or
  1440, in either theme, on the shell and on the proving-ground tab. Not all
  nineteen: that is U1–U6's Definition of Done, and asserting it here would be
  claiming work #109 did not do.

Two things this check taught its own author, both recorded in the file. The
first `--ctl-border` candidate cleared 3:1 against `--panel` (3.20) and missed
it against `--bg` (2.98) — a near-miss no eye catches, on a token that is drawn
on both surfaces. And the sideways-scroll assertion went red at 768 px in one
theme and green in the other, which is not a theme bug: crossing the `xs` step
turns both rails from drawers into columns over a 160 ms transition, and the
check was measuring inside it. It waits the transition out now, for exactly the
reason `app.js` does before it re-measures a map.

### `tabs.mjs` — a list rather than a sweep, and two blind spots in it

`shell.mjs` holds #109's system against the shell **and one tab**, deliberately
and by its own comment. `tabs.mjs` (#137) is the other half: the same system
held against every tab a U-issue claims to have converted, named in `CONVERTED`.
A list rather than a sweep, on purpose — a tab nobody has converted does not
fail a check for work nobody has done, and a U-issue's landing commit adding its
ids is what puts it under the check.

**Two ways this check was quietly passing tabs it should not have**, both found
by #141 and both fixed there:

- **It read the whole document's heading outline**, so every tab got five free
  `h2`s: #108's nav group headings sit ahead of `<main>` in the DOM. A tab whose
  own first heading was an `h3` — three of #141's four — followed an `h2` and
  passed. It reads the shell's `h1` plus the headings inside `#main-content`
  now, which is the outline that actually belongs to the tab. Confirmed red by
  putting one heading back.
- **It checked two tabs in a state they are almost never in.** ARRO Data draws
  nothing until a CSV is dropped on it and Field Data draws nothing until the
  datastore answers — which under this harness it never does. Both were passing
  on an empty state and a paragraph while the toolbar, the chart, the legend,
  the readout and the readings table went unmeasured. A `CONVERTED` entry can
  carry a **`seed`** now: source for a function run in the page right after
  `switchTab()`. It builds two series through the module's own boundary
  (`seriesData` → `adoptSeries`) rather than out of a fixture file, so what the
  check draws is what the app draws, and it opens the `<details>` panels because
  a closed one is `display: none` and everything inside it filters out as
  invisible. The seeded ARRO Data tab checks 61 controls and 2 tables; before
  it, **one control and no tables**.

The generalisable half is the same shape as `maint`'s and `history`'s findings:
*a check is only as good as the state it is run against*. Uniform fixtures hide
rules about the non-uniform case; empty states hide everything.

### `inspections.mjs` — the half the network policy hides

`registry.mjs` exists because smoke opens every tab and never leaves one. This
one exists because of the opposite problem: smoke *blocks* the datastore, and
the Inspections tab renders **from** it.

Which sections each of the six inspection forms prints comes out of
`meganet.inspection_form`, and every pick-list on the form comes out of a lookup
table (#115). Under smoke's policy those reads are aborted, the tab correctly
renders "the form itself could not be loaded", the handler audit finds six
handlers on an error panel, and a form of some 1,500 lines that nobody drew
passes. That is a true result about the failure path and says nothing at all
about the form.

So this check answers the datastore instead of blocking it — installing its
route *after* `applyNetworkPolicy`, so Playwright reaches it first, and serving
only the paths this tab asks for. Everything else still falls through to the
abort, which is what stops the test quietly depending on a request nobody meant
to make.

**The fixture is parsed out of `db/migrations/0009_inspections.sql`, not copied
from it.** That is the part worth keeping if this file is ever rewritten. The
form's whole claim is that it renders what the database says; a test that
renders it against a hand-written copy of what the database says is testing the
copy. Parse the migration, and a matrix the form cannot render fails here. It is
also why `db/migrations/**` is in the workflow's `paths:` filter.

What it asserts, for each of the six configurations: the sections on screen are
the matrix's, in the matrix's order; the ones it does not print are *named*
under "Not on this form"; every rendered handler resolves; no calibration block
is offered that the section guard in 0009 would refuse; the Serial Numbers panel
is that sheet's own after a configuration change; and the printed tip-test
reference values are filled in. Then, once: the printed 6% rule computes and
reads the right way either side of the threshold, and a save sends a document
with no section the form does not print and with the untouched grids pruned out.

Confirmed red on three deliberate breaks before being trusted — offering a
calibration block the guard would refuse, dropping a section from the render,
and sending the document unpruned. #146 added a fourth and a fifth: deleting the
Base Station Time box, and offering it on all six sheets rather than the one that
prints it.

### `maintenance.mjs` — the same blind spot, a different claim

The Site Maintenance tab is invisible to smoke for exactly the reason the
Inspections tab is: it renders from the datastore, and smoke blocks it. So the
first half of this check is `inspections.mjs`'s — the ten vocabularies are
parsed out of `0009` by `lib/migration.mjs`, which both files now share.

The second half is different, and it is the interesting one. The inspection
form's claim is *the matrix decides which sections print*, so its test renders
the matrix. The Council form has no matrix — there is one sheet, and its layout
does not vary. Its claim is **fidelity to a piece of paper**, and the paper is
in the repo: `archive/Inspection sheets for printing.xlsx` holds the blank
template and `Council Maint Tasks Mt Kanigan`, the same sheet filled in at a
real station.

So `lib/xlsx.mjs` reads the workbook — a zip of XML, both halves of which are in
Node's standard library, which is why this needed no new dependency — and the
check drives the filled sheet through the form. Two assertions come out of that
which a hand-written fixture could not make:

- **Every cell where the filled sheet differs from the blank template is either
  mapped onto a column or named in `UNMAPPED` with the reason.** A value
  somebody wrote on that sheet cannot go missing quietly, and replacing the
  workbook with a fuller example fails this until somebody has looked at the new
  cells. (There is one entry: an unlabelled "HS" in the Rainfall panel that has
  no printed box to be the value of.)
- **Every printed pick-list word resolves against the migration's own `label`.**
  That is #117's "one source of truth, not a parallel list" as a check rather
  than a claim: the workbook says `Poor (add comments below)`, so does
  `meganet.condition_rating`, and that is why the key is `poor`.

The rest: the nine sections render in the sheet's print order, a blank form
materialises the three asset panels and the two data-quality rows, no panel
offers a box its check constraint would refuse, no section states an uncaptured
box, every filled value is read back **out of the DOM** rather than out of
`state`, a save round-trips it and prunes the panels nobody filled in, and the
printed cross-reference works in both directions — the outstanding list starts a
linked form, and the button at the foot of a saved inspection that departed poor
lands on this tab with the link made.

One assertion here is worth knowing about because it exists to cover a hole in
the diff above. #148 gave the Comms and Power panel's Equipment and Power
sub-columns their own Condition and Owner, and the blank template and the filled
sheet carry the **same** words in those four cells — so mapping them changes no
difference between the sheets, and the diff assertion passes either way. What
proves that landed is the DOM: the panel prints three titled sub-blocks, and the
four new controls show what the sheet says. **A cell map is not a coverage
measure when both sheets agree on a cell**, which is the generalisable half.

#148 confirmed its three assertions red before trusting them: dropping the three
sub-headings, deleting one of the four new controls, and leaving a stale
uncaptured note on the panel.

`lib/xlsx.mjs` is not an xlsx library and does not try to be: cell references to
the text Excel would show, no styles, no formulas, no dates. It fails loudly on
anything else, which is the right failure for a fixture reader.

### `history.mjs` — the fixture the app writes itself

The Inspection History tab is invisible to smoke twice over: it renders from the
datastore *and* every record it renders is editors-only, so under smoke's policy
it correctly shows "sign in to read them" and a whole reader passes untested.

What is different about this check is where the fixture comes from. `insp` takes
its reference data out of `0009` rather than out of a copy of it; this takes the
**records** out of the app rather than out of a file:

1. It opens the Inspections tab, sweeps every box the Alert sheet renders and
   fills it in, and presses Save.
2. The fixture's `save_inspection` files the document it was sent.
3. The fixture's `inspection_doc` hands that same document back.

So what is under test is the round trip a person makes — fill in, save, come
back later and read it — rather than a reader agreeing with a fixture somebody
wrote to match the reader. It does the same with the Council sheet.

The assertion the design rests on is the first one: **a saved visit reads back
with exactly the sections the editable form printed, in the same order.** The
read-only view is one walk over the same `FIELDS`/`SECTIONS` tables the form
renders from, and a section in one and not the other means it is not. The CSV is
written from that same walk, and the check asserts that too, as a superset:
every (section, label) pair on screen has a row in the file.

Three things it covers that are specific to reading a record back rather than
writing one:

- **A printed section with no row saved against it says so** rather than
  printing a grid of empty boxes that reads as unfilled. That is 0009's
  decision 2 one level down — "nobody filled this in" is no row — and it is why
  the check leaves the gas section untouched before saving.
- **Pick-list values read back as their labels, not their keys.** Every select on
  the sheet is set by the sweep, so a model that skipped the lookup puts keys on
  screen; the check collects every value from the boxes *and* the grids and
  fails on any that is a known key.
- **The CSV names a photo by its object path and never by a signed URL.** #149's
  rule only bites in an export, because an export outlives the session that made
  it — a signed URL in a file somebody mails around is a private bucket with the
  door propped open.

The Council half asserts that the Comms and Power panel reads back as three
titled sub-blocks with three Conditions. #148 repaired that as a *writer* bug;
this is the reader not quietly re-creating it, which it could do while passing
every other assertion in the file.

Seven deliberate breaks were confirmed red before any of it was trusted: dropping
a section from the model, returning a key instead of a label, printing boxes for
an unrecorded section, dropping blank boxes from the CSV, putting the signed URL
in the CSV, collapsing the comms panel to one block, and sorting the timeline
oldest first.

**One of those seven did not go red the first time, and that is the part worth
carrying forward.** Dropping blank boxes from the CSV passed, because the sweep
had filled every box on the sheet — so there were no blank boxes on screen for
the superset assertion to miss. The fixture now leaves every fourth box blank on
purpose, and asserts that it did. *A check whose fixture is uniform cannot see a
rule about the non-uniform case*, which is the same shape as `maint`'s finding
that a cell map is not a coverage measure when both sheets agree on a cell.

### `lib/storage.mjs` — the upload path, faked, and what it refuses to fake

Both form checks grew an attachments section at #149, and neither owns the
fixture for it, for the same reason `lib/migration.mjs` is shared: two copies of
an upload fake would be two things to keep in step, and the half that drifts is
always the compensating delete.

What it does is serve `…/storage/v1/**` — the upload, the signed URL, the GET of
that URL (a one-pixel GIF, so a thumbnail does not 404 into the console the check
reads) and the delete — plus the three RPCs `0010` adds, and **record** all of it.

What it deliberately does not do is re-implement `meganet.attach_file()`. Every
rule that function enforces — the path prefix, the uuid leaf, the extension
against the content type, the size against the type's own limit, the role, that
the owner exists and is not soft-deleted — is proven against a real Postgres by
`tools/check_attachments.sql`, 47 checks of it. A JavaScript copy of those rules
here would be exactly the "fixture that tests the copy" that `lib/migration.mjs`
exists to avoid: it would pass while the database refused, or refuse while the
database accepted, and either way the check would be about the fixture.

So the browser's half is what is asserted, and it is the half only a browser can
answer: that an unsaved record offers no uploader at all (the attachment is a
foreign key and needs a row to point at), that a type or a size the vocabulary
refuses is refused **before** anything is uploaded rather than after, that the
bytes go up before the index row and a refused index row takes the bytes down
again, that the object is named with a generated uuid under the record's own
prefix rather than with the camera's filename — a private bucket read through
signed URLs is only as private as its paths are unguessable — that the file's own
name survives as the title, that each panel lists only its own role, and that
removing takes the index row first and the object second.

The type vocabulary comes out of `0010` the same way everything else comes out of
`0009`: parsed, not copied. That needed one extension to the reader — `array['jpg',
'jpeg']` is the one value shape `0009` never used, and without bracket-depth
tracking the extensions column parses as two half-columns and every column after
it shifts by one.

Confirmed red on three deliberate breaks before being trusted — naming the object
after the file, offering the uploader on an unsaved record, and skipping the size
check.

### `help.mjs` — the check for content, not for code

Every other check in here is about whether the app *works*. This one is about
whether what it says is still true, and it exists because #105 wrote nineteen
help entries and every way they decay is silent.

Smoke already asserts that each tab has a key in `HELP`. That is the check that
stops the rail rendering blank, and it says nothing at all about what is behind
the key. The three failures that actually arrive later all render a
perfectly good-looking panel:

- **A doc link that 404s.** Nine of these were added at #105, out to `docs/`,
  `db/README.md` and two bundled specification PDFs. Rename one of those files
  and the panel still draws the link, in the right place, with the right words
  on it. This is the load-bearing assertion here, and it is a filesystem check
  rather than a fetch — "is that file in the repo" is the same answer on
  GitHub Pages, and it is the only answer available for the `.md` ones, which
  `docUrl()` sends to GitHub's renderer and the network policy cannot reach.
- **A *see also* naming a tab that no longer exists.** The renderer drops it in
  silence: `TAB_LIST.find()` returns undefined and the map contributes an empty
  string. Rename a tab id in `TABS` and it quietly loses every route into it.
- **A placeholder that shipped.** #105's acceptance is real content on every
  tab, and the only way that stays true of tab twenty is if something checks it.

Two more about the walkthroughs, which are the one thing in the panel that the
prose around them does not also carry: an inline SVG with no `<title>` is an
empty box to a screen reader, and one carrying its own `width` is right in
exactly one of the three widths the rail is ever at. Both are asserted against
the **rendered** drawing rather than the source string, because what the panel
does with it is the question.

Two things it prints rather than asserts, on the no-silent-caps principle: how
many tabs have a walkthrough (two of nineteen, which is the intended result and
should be a stated number rather than an inferred one), and which *see also*
links are one-way. The second is deliberately not a failure — the Stations tab
is worth reaching from nearly everywhere and does not point back at everywhere —
but a missing return route should at least be visible.

Ten deliberate breaks were run before it was trusted and all ten went red on the
assertion they should have. Two of those were the halves of `docUrl()` that
#105 had to add: a fragment surviving (`db/README.md#…` did not match a plain
`/\.md$/`, so the useful link was being served as a download) and the space
encoding for the PDFs.

## Using `concat-verify.mjs` across a split

The only claim that matters when a milestone cuts `app.js` is *the split lost
nothing*. Concatenating the pieces in `index.html` order and comparing the bytes
against the file before the cut is what proves it, and it is the only check that
reliably catches the **4 NUL-byte hazard**: literal `U+0000` characters inside
string literals, used as compound-key separators (see #129). `app.js` no longer
carries any: three left with `NetworkView` in M3 and are now `network-view.js`
lines 504 and 568×2, and the fourth left with `Alert2` in M2 and is
`alert2.js:857`. (All four were in `app.js` at 7895, 7959×2 and 19504 before M1,
at 7047, 7111×2 and 18583 between M1 and M2, and at 6154, 6218×2 and
`alert2.js:857` between M2 and M3 — they move whenever code moves out above them,
which is why the check counts them over the whole concatenation rather than
looking them up.) A tool that round-trips one of these files as text and
normalises control characters destroys those keys invisibly. A byte comparison
does not care what the bytes mean.

```sh
npm run concat -- --update    # 1. before cutting, record the baseline
                              # 2. cut the file, wiring each piece into index.html
npm run concat                # 3. after cutting — identical bytes or it failed
                              # 4. land it, then re-record for the next milestone
```

You can also compare straight against a file instead of the recorded baseline:

```sh
git show <ref>:app.js > /tmp/pre-split.js
npm run concat -- --against /tmp/pre-split.js
```

A milestone that also *edits* code cannot be verified this way. That is the
point: do the move and the edit as two commits.

It is not in CI. The baseline is a snapshot of a moment, so any honest change to
`app.js` makes it stale; as a per-push gate it would train everyone to re-record
without looking, and a verifier nobody looks at verifies nothing.

## When the tests need updating

- **A tab was added or removed.** `smoke.mjs` asserts `TABS` holds 19 entries, so
  that a tab added without a `renderMain()` case fails here rather than in front
  of an operator. Give the new tab a `renderMain()` case and a `HELP` entry, then
  bump `EXPECTED_TABS`. The `HELP` entry has to be *written*, not stubbed —
  `npm run help` fails a summary under 140 characters and any of the usual
  placeholder words, which is what stops "every tab is documented" quietly
  becoming untrue at tab twenty. It also needs a **group, an icon nothing else
  uses, and `find` words**, or `npm run nav` goes red: a tab with no group is a
  tab with no route to it, and a tab whose only find words restate its label is
  findable only by people who already know what it is called. If the new tab
  takes a group past six, that is the check asking where it actually belongs —
  see #108 for how the current five were cut.
- **A tab was renamed.** Change `label` in `TABS` and leave `id` alone: the id
  keys `HELP`, `renderMain()`, the teardown registry and everything in
  `localStorage`. Add the old label to that tab's `find` words as the separate
  words it was — `npm run nav` matches from the start of a word, so `networkview`
  would only ever be reached by typing it as one — and update the tab's own
  heading in its module, or the nav and the page it opens disagree.
- **A script was added to `index.html`.** Nothing to do. Every check reads the
  script list out of `index.html`, so the split milestones are picked up
  automatically — M1 added `core.js` and `init.js`, M2 added ten module files, M3
  added fourteen and M4 added two, none of them touching a line of test code. A
  file added to the repo but not wired into `index.html` is invisible to the
  tests exactly as it is invisible to the app. The two baselines under
  `baseline/` do have to be re-recorded, since both name the script list they
  were taken over.
- **The top-level declaration count moved.** Reported, never enforced — a check
  that goes red for ordinary work gets switched off. Re-record with
  `npm run names -- --update` when it drifts. A *drop* of a hundred in a split
  commit means a file stopped being loaded — or, as in M4, that a hundred names
  went private on purpose, which is why it reports rather than enforces.
- **A tab grew a Leaflet map, or something that has to stop when you leave it.**
  Call `registerLiveMap(name, () => …)` where the map is built, and
  `registerTabTeardown(name, stop)` from the module's `init()`. Both are in
  `core.js`; `npm run registry` fails if a file builds a map and does not do
  all three. Register the *getter*, not the map — a teardown that nulls the slot
  has to be visible to the shell. Take the map down with `removeMap()` rather
  than `map.remove()`, and register the teardown *before* the early return that
  skips building a map, so a render that finds no container still leaves one
  behind for the render that does.
- **A module needs something to happen at load.** It goes in `init.js`. Anywhere
  else and `npm run toplevel` goes red, which is the point: everything else
  declares, and that is what makes the load order safe to add to.
- **A form tab grew a field.** `npm run insp` and `npm run maint` both take
  their fixtures out of files in the repo — the migration and the workbook — so
  a new column with a seeded vocabulary needs nothing here. A new *box on the
  paper* does: add its cell to the map at the top of `maintenance.mjs`, or the
  diff assertion will report it as unaccounted for, which is the intended
  behaviour and not a nuisance. If the blank template and the filled sheet agree
  on that cell the diff will stay silent, so add a DOM assertion too — see the
  note under `maintenance.mjs` above. On the inspection side, a box that only
  some of the six sheets print belongs in the per-configuration box assertion in
  `inspections.mjs`, which checks both that the sheets printing it show it and
  that the others do not.
- **A form tab grew a section, or a section grew a box, and you want to know
  whether the history view followed.** Nothing to do — that is what
  `npm run history` is for. It compares the read-only record against the
  *editable* form's own section list, and the CSV against the read-only record,
  so a section added to either sheet turns up in all three or the check goes red.
  What does need an edit is the fixture's skip list, if the new section must be
  left unrecorded to keep the "nothing was recorded in this section" assertion
  meaningful.
- **A section grew an attachment panel.** `Attachments.sectionHtml()` is the
  whole of it, and `lib/storage.mjs` already serves the routes — but the panel
  list assertion in `maintenance.mjs` is exact, so a third panel on that tab is
  an edit there. That is intended: an attachment panel appearing somewhere
  nobody expected it is worth failing over.
- **A tab needs a width that is not on the breakpoint scale.** It does not get
  one. `npm run shell` fails any `@media (max-width:)` outside `BREAKPOINTS` in
  `core.js`, which is the whole point of #109: nine ad-hoc widths became six
  named steps, and the instruction to #136–#141 not to add a tenth is only
  worth something because this check enforces it. If a step is genuinely
  missing, add it to `BREAKPOINTS`, say what it means in
  `docs/design-system.md`, and use it — a change to the system, made in the
  open, rather than a number typed into one tab's CSS.
- **A colour was added or changed.** `npm run shell` computes WCAG contrast for
  every pair in its contract, in both themes, so a new token needs a
  dark-theme value *and* a line in `TEXT_PAIRS` or `NONTEXT_PAIRS` in
  `shell.mjs` naming what it is drawn on. Two of #109's own colours moved
  because of that check rather than because anyone looked at them. ~~And if the
  colour is one the ARRO chart draws, `ArroData` writes literal values into its
  SVG for the PNG export and does not pick up a token change.~~ **Closed by
  #141** — the chart's twelve colours are `--ad-series-1…12` and it resolves
  them off the document at draw time, so a palette change reaches it on the next
  `repaint()`. `tabs.mjs` holds that round trip; break it and two assertions go
  red. The twelve are categorical and deliberately *not* in the contrast
  contract, the same argument as `--maps-region-*`.
- **A U-issue landed a tab.** Add its tab id to `CONVERTED` in `tabs.mjs`, in
  the same commit. If the tab renders nothing worth checking until something is
  loaded, give the entry a `seed` — source for a function run in the page right
  after `switchTab()` (#141). Two of the nineteen are like that and they are the
  same module: ARRO Data draws nothing until a CSV is dropped on it, and Field
  Data draws nothing until the datastore answers, which under this harness it
  never does. Both were passing as an empty state and a paragraph while the
  toolbar, the chart, the legend and the readings table went unmeasured. Seed
  through the module's own boundary rather than a fixture file, and open any
  `<details>` you want checked — a closed one is `display: none`, and everything
  inside it is filtered out as invisible. That list is what the per-tab Definition of Done is asserted
  against, and a tab left off it is a tab nobody is holding — the check will go
  green all the way through a conversion that dropped half of it. The reverse is
  deliberate too: a tab nobody has converted yet does not fail a check for work
  nobody has done, which is why this is a list rather than a sweep over all
  nineteen.
- **A tab needs a pattern that is not in the design system.** Add it to
  `docs/design-system.md` §3 and check it here, in that order. #137 added two
  (a scrolling `.table-wrap` is a named region; a clickable row carries a real
  button) and a third that is a condition rather than a shape (a graphic marked
  `role="img"` as a shortcut must have every operation it offers on a named
  control beside it — `tabs.mjs` asserts that every region on the basin drawing
  has a chip). A pattern nobody can find is a pattern the next five tabs will
  re-derive differently.
- **A control needs a different focus ring.** Override it; one selector beats
  the `:where()` rule with no `!important`. What you may not do is remove it:
  `outline: none` outside the two-entry allowlist in `shell.mjs` goes red, and
  an entry whose rule no longer exists goes red too.
- **A member was added to `RfChanges` or `Workbench` that an `on*=` attribute
  names.** Add it to `CONTROL_SCRIPT` in `lib/controls.mjs`. Nothing forces you
  to; the coverage line at the end of the run (`controls: workbench — 18/18
  fired`) is what makes the omission visible. The same applies to any module that
  grows a click script later.

## What this found on the way in

A pre-existing crash on `main`, and a good demonstration of why the harness was
worth building: leaving and re-entering the Stations tab threw an uncaught
`TypeError` out of Leaflet's `Canvas._clear` roughly half the time.

Leaflet 1.9.4 removes a map's layers in stamp order, and the shared canvas
renderer is a layer like any other — so it can be destroyed while paths that draw
on it are still coming off, leaving an animation frame that fires after the
context is gone. With ~7,000 station and link paths on that map it lands about
half the time. Cancelling the pending frame at teardown does not fix it: the
frame that survives is not reliably the one the renderer still holds an id for.
The fix is at the bottom of `core.js` — a redraw with no context returns instead
of throwing. It only has to be installed before the first `L.map()` call; core.js
loads before every module and before `init.js`, which is the only file that
renders a tab at load, so that is the one place it cannot be reordered out of.
