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
npm run all                       # the five that run in CI
```

| Command | What it does |
|---|---|
| `npm run check` | `node --check` over every script `index.html` loads |
| `npm run names` | no duplicate top-level declarations across those scripts |
| `npm run toplevel` | `init.js` is still the only file that executes at load |
| `npm run smoke` | loads the page in Chromium, opens all 16 tabs, asserts a clean console, audits every rendered `on*=` handler, and clicks the RF Changes / Workbench controls |
| `npm run registry` | every Leaflet map and every tab teardown is registered by the file that owns it — and actually fires |
| `npm run concat` | byte-exact concat-and-diff against a recorded snapshot (milestone tool) |
| `npm run all` | the five that run in CI |

`npm run smoke -- -v` also prints which off-origin hosts were blocked;
`toplevel` and `registry` take `-v` too, to list what passed as well as what did
not.

CI runs `check`, `names`, `toplevel`, `smoke` and `registry` on every push that touches a root `*.js`,
`index.html`, `styles.css`, `stations.json` or `test/` — see
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
`state.data` stays null and eleven of the sixteen tabs render the empty state
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
One `evaluate()` per tab, so it runs on all sixteen — 313 distinct handler calls
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

Smoke opens all sixteen tabs. It never *leaves* one, so a tab that forgot to
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

- **A tab was added or removed.** `smoke.mjs` asserts `TABS` holds 16 entries, so
  that a tab added without a `renderMain()` case fails here rather than in front
  of an operator. Give the new tab a `renderMain()` case and a `HELP` entry, then
  bump `EXPECTED_TABS`.
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
