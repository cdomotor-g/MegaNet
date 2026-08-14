# The MegaNet design system

Written for [#109](https://github.com/cdomotor-g/MegaNet/issues/109), the
foundation of [EPIC #107](https://github.com/cdomotor-g/MegaNet/issues/107).

Six per-tab issues (#136–#141) are about to do layout, mobile and accessibility
work on nineteen tabs, in parallel, in separate files. What stops that
producing six products in one window is that the decisions they share are made
once and are named. This document is where they are named.

**The one rule that makes the rest work:** if you need something that is not
here, you add it *here* and write down why — you do not make the decision
locally in your own tab. A number typed into one tab's CSS is a decision the
next tab cannot find.

Three files hold the system itself, and this document explains them:

| Where | What |
|---|---|
| `styles.css`, the block at the top | The tokens, and the contract in short form |
| `core.js`, `BREAKPOINTS` | The breakpoint scale — the only place the numbers exist |
| `core.js`, `announce()` | The live-region policy, stated above the function |

And one file checks it: `test/shell.mjs`, run as `npm run shell` from `test/`,
in CI on every push that touches the app. What it enforces is listed at the
bottom of this page. Every claim below that *can* be checked mechanically is
checked — this repo has a habit of that, and the reason is in constraint 1 of
[#113](https://github.com/cdomotor-g/MegaNet/issues/113).

---

## 1. Tokens

All of them are CSS custom properties on `:root`, with dark-theme values on
`[data-theme="dark"]` where the light value would be wrong.

### Colour

The palette that existed before #109 is unchanged — surfaces, text, station
roles, packet bit-fields, map lines, search hits. #109 added the three that
were missing, all three because a literal colour had been written into a rule
where a token belonged:

| Token | Light | Dark | What it is |
|---|---|---|---|
| `--ctl-border` | `#7f92a5` | `#6a7d92` | The edge of a button, input, select or textarea |
| `--primary` | `#107c10` | `#107c10` | The affirmative action — Save, Apply, Sign in |
| `--primary-text` | `#ffffff` | `#ffffff` | Text on `--primary` |

`--ctl-border` replaced `#b9c7d6` (buttons, `.btn-link`) and `#bfd0e0`
(fields). Neither had a dark-theme value, so every control in the app was
outlined in pale blue-grey on a `#18222d` panel. It is also *darker* than what
it replaced, deliberately: WCAG 1.4.11 asks for 3:1 between a control's
boundary and what is behind it, and `#b9c7d6` on white is **1.70:1**. The new
values are 3.20:1 and 3.81:1 against their own panel. This is the one change in
#109 that is visible on every tab at once.

`--line` was referenced three times (attachments, inspection history) and
**never defined**. An invalid `var()` invalidates the whole declaration, so
those three borders were not being drawn at all. They are `--border` now.

### Spacing — a 4 px base

`--sp-1` `.25rem` · `--sp-2` `.5rem` · `--sp-3` `.75rem` · `--sp-4` `1rem` ·
`--sp-5` `1.5rem` · `--sp-6` `2rem`

The app was writing `.3` / `.35` / `.4` / `.45` / `.5` / `.55` / `.6` / `.65rem`
for what are three distinct gaps. Existing rules are not being rewritten
wholesale — a U-issue converts its own tab as it goes.

### Type

`--fs-xs` `.74rem` · `--fs-sm` `.85rem` · `--fs-md` `.92rem` ·
`--fs-lg` `1.05rem` · `--fs-xl` `1.3rem`, with `--lh-tight` `1.25`,
`--lh-body` `1.5`, and `--font-mono`.

Again a naming of what was there: `.72`/`.74` were one step, `.84`/`.85` were
one, `.9`/`.92`/`.93` were one.

### Radius, elevation, motion

`--r-sm` `4px` (chip, `kbd`, swatch) · `--r-md` `8px` (button, field, note) ·
`--r-lg` `10px` (panel) · `--r-pill`.

`--shadow` is the panel's elevation and keeps its name. `--shadow-2` is the
raised one — drawers, modals, popovers — and was previously written out
per-component.

`--motion-fast` `.12s` · `--motion-rail` `.16s` · `--motion-slow` `.24s` ·
`--ease`.

⚠️ `--motion-rail` is load-bearing. `app.js` re-measures every Leaflet map
`NAV_TRANSITION_MS + 40` after a rail moves, because a map measured mid-slide
caches the wrong container width and then renders grey tiles and hands back
click coordinates that are offset. If you change the rail duration, change
`NAV_TRANSITION_MS` and `HELP_TRANSITION_MS` in `core.js` with it.

### Focus

`--focus` (the accent) · `--focus-width` `2px` · `--focus-offset` `2px` ·
`--focus-halo` (the page colour).

One ring, applied by a single zero-specificity rule:

```css
:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: var(--focus-width) solid var(--focus);
  outline-offset: var(--focus-offset);
  box-shadow: 0 0 0 calc(var(--focus-width) + var(--focus-offset)) var(--focus-halo);
}
```

`:where()` is 0-specificity on purpose: a component that needs a different ring
overrides it with one selector and no `!important`. What a component may **not**
do is remove it.

**Never `outline: none` without a replacement that is at least as visible.**
There are exactly two allowlisted exceptions in the app, both of which replace
the ring with a shape change on the element that has focus:

- `.map-split` — a 3 px hairline the height of the page. A ring around it reads
  as a second divider; focus turns the bar itself the accent colour instead.
- `.nv-node` — an SVG `<g>` has no box, so the browser rings the group's
  bounding box, which on a force-directed graph is a rectangle nowhere near the
  node. The node's own circle takes the accent stroke at 3 px.

`npm run shell` holds that allowlist. A third exception has to be argued into
it.

### Contrast

Every token pair that produces text on a background meets **WCAG AA in both
themes**, and this is checked rather than asserted: `npm run shell` renders the
app, reads the values the browser actually resolves for both themes, and
computes the ratio. A token added without a dark value fails there rather than
shipping as a light colour on a dark panel.

Non-text contrast (1.4.11, 3:1) is checked for `--ctl-border` against its
panel. Purely decorative dividers — `--border` between two surfaces — are not
in scope for 1.4.11 and are not checked.

⚠️ **A palette change does not reach the ARRO chart.** `ArroData` writes
literal colour values into its SVG rather than `var(…)` so the PNG export has
something to resolve. Change a colour here and that chart keeps the old one
until somebody edits it by hand, keeping `ArroData.repaint()` in step. #141
owns it. Flag any palette change loudly for this reason.

---

## 2. Breakpoints

**Six named steps, and no seventh.** They live in `core.js` as `BREAKPOINTS`,
which is the only place the numbers are written down.

| Name | Width | What happens |
|---|---|---|
| `xl` | 1400 | The widest layouts give up a column — the help panel narrows to 260 px, `.crud-layout` and the Workbench rail stack |
| `lg` | 1100 | Side-by-side becomes stacked — `.layout`, `.map-layout`, Radio Path Maps, the Workbench |
| `md` | 900 | **A tablet.** The nav auto-collapses to the icon rail, header buttons drop their labels, tables switch to automatic layout and scroll inside their wrapper |
| `sm` | 700 | Two-column content folds to one — forms, pickers, optional table columns |
| `xs` | 560 | **A phone.** The nav and the help panel stop being columns and become drawers over the page |
| `xxs` | 380 | The smallest phone. The banner shrinks its title rather than pushing a button off the edge |

They are in `core.js` and not in `styles.css` for two reasons. CSS custom
properties cannot be used inside a media query, so tokens there would look
usable and not be. And two of the steps are already load-bearing in JavaScript
— `NAV_AUTO_COLLAPSE_PX` is `md`, `isPhoneNav()` is `xs` — so the app was going
to hold the numbers regardless. `npm run shell` reads `BREAKPOINTS` out of the
running page and fails on any `max-width` in `styles.css` that is not one of
its values. That is what makes "U1–U6 must not introduce a new breakpoint" a
checked claim rather than an instruction.

### What was folded, and why

`styles.css` held 23 `@media (max-width:)` blocks across **nine** distinct
widths: 1400, 1200, 1100, 1000, 900, 720, 700, 560, 380. Three were folded
away; each fold carries its reasoning as a comment at the block it changed.

- **1200 → 1400**, folded *up* rather than down. `.crud-layout`'s columns are
  `minmax(320px,1fr)` and `minmax(360px,1fr)` with a 1 rem gap — 696 px of hard
  minimum. With the nav (236) and the help panel (260) both open, a 1200 px
  window leaves 704 px: it fitted by eight pixels. At 1100, the next step down,
  it would not have fitted at all. Folding up removes the marginal case instead
  of moving it.
- **1000 → 1100.** Between those two the Workbench was holding a 300 px rail
  beside a main column with about 204 px left. The step it lost was one it was
  not surviving anyway.
- **720 → 700.** The only one of the three with nothing behind it: two values
  twenty pixels apart, in a file where five other blocks already said 700.

Non-width queries have a policy too, and neither is a breakpoint:

- `(hover: hover)` — a control that appears on hover must also be reachable
  without one. There is one such rule (`.filter-only`) and it already pairs
  `:hover` with `:focus`.
- `(pointer: coarse)` — every text-entry control goes to exactly 16 px, because
  iOS Safari zooms the page when a smaller field takes focus and never zooms
  back out. Applies to controls, not to layout; a layout decision belongs to a
  width step.

### Widths to test

~375 px, ~768 px, and desktop — the three the epic's Definition of Done names.
Note that 768 sits *above* `sm`, so a 768 px tablet gets the two-column form
layout; that is intentional.

---

## 3. Component patterns

### Page

```html
<div class="page" style="--page-max:960px"> … </div>
```

Eight tabs opened with the same inline
`max-width:Npx;margin:auto;padding:1rem;display:grid;gap:1rem`, written out by
hand with four different maximums. `.page` is that, with `--page-max`
defaulting to 1100 px. **Inline styles are what U1–U6 are replacing; this is
the thing to replace them with** — an inline style is a decision no token can
reach.

### Panel

`.panel` is the card: `--panel` background, `--border`, `--r-lg`, `--shadow`.
`.panel-sub` is the same thing one level in. Both are `min-width: 0`, which is
not cosmetic — a grid item defaults to "never narrower than my content", so a
panel holding an 880 px table used to widen the whole document and scroll the
*page* sideways on a phone while the wrapper that should have scrolled sat
there with nothing to do.

`.panel-header` is a flex row, spaced apart, wrapping, with `h2`/`h3` margins
zeroed. A panel's heading and its count/actions go in it.

### Buttons

The base `button` is `--panel` on `--ctl-border` at `--r-md`. `button.primary`
is the affirmative action. `.btn-link` is a real `<a>` that reads as a button,
and is used where the action is "leave for another site" — an anchor keeps
middle-click, ctrl-click and "copy link address", which a button with a
`window.open` handler throws away.

### Form fields

`input`, `textarea` and `select` share one rule: full width, `--ctl-border`,
`--r-md`. `input[readonly]` is `--subtle` on `--muted` — still a field, because
it holds a value worth copying, but it must not look like somewhere to type.
Labels go in `.form-grid` / `.upload-grid`, which give a `label` a `display:
grid` with the control under the text.

### Tables — there is one pattern

Six issues are about to style tables. This is the answer all six inherit, and
it is mostly a description of what the app already does — which is the reason
to write it down rather than let each of them re-derive a different half.

1. **Every table is wrapped in `.table-wrap`.** The wrapper scrolls; the page
   never does.
2. **Wide by columns, not by page.** Below `md` the global
   `table-layout: fixed` is dropped inside a wrapper, so each column takes what
   it needs and the total scrolls sideways. The wrapper paints a shadow on
   whichever edge has more table behind it, because a sideways scroll is
   otherwise invisible until you try it.
3. **Column priority is opt-in, one class: `.col-optional`.** Below `sm` it
   hides the cell from sight and from the accessibility tree together, so
   nothing reads out a header whose cells are gone. Put it on the `<th>` *and*
   every `<td>` beneath it. A column carrying anything a field crew needs does
   not get this class — it scrolls instead.
4. **Stacked cards are not the house answer.** They were considered and are not
   used: these tables are read by comparing rows down a column — repeater
   counts, RSSI, addresses — and stacking destroys exactly that.
5. **`.bf-table` is the sanctioned exception** to `table-layout: fixed` and
   stays one: eight columns including a 16-character binary field, fixed at
   880 px, scrolling inside its wrapper. That is pattern 1 taken to its limit
   rather than a departure from it.
6. **Every table gets a `<caption>`**, `.sr-only` if the panel heading above it
   already says the same words. A table with no accessible name is what a
   screen reader lands in with no idea what it is reading, and it was the most
   common single finding in the audit behind #111. Headers get `scope="col"`.

### Charts, canvas and maps — the house answer

The map, the Ghosting Graph, the RF Changes timeline and the ARRO chart have no
DOM to annotate. #138 and #141 were told to agree a pattern with each other;
this is the pattern, so that they are agreeing to something rather than
inventing it.

**Three parts, and a graphic needs all three:**

1. **A name that carries the headline number**, on the graphic itself, updated
   whenever the graphic is. Not a fixed string. "Memory usage" told a screen
   reader the same thing whether the page was holding 4 MB or 40.
2. **A one-sentence summary of what it shows** — the shape of the answer, not
   the data. "Twelve repeaters, three of them outside every pass range."
3. **The data, as a real table, one activation away.** Not a second copy of the
   chart in hidden text — a `<table>` a sighted keyboard user can also reach
   and read. A `<details>` under the chart, or an existing panel that already
   lists the values.

The shell's own graphic is the worked example: the memory strip
(`mem-meter.js`) is seven coloured segments with no text at all. Its accessible
name now carries the total and the holder count (part 1 and 2), and the panel
it opens is the table (part 3) — which already existed, listing every holder,
its estimate and its Release button.

What **not** to do: `aria-label` on a `<canvas>` and nothing else; a hidden
`<div>` containing every data point as prose; `role="img"` on something
interactive.

---

## 4. Accessibility primitives

These are the app's, not any tab's. U1–U6 inherit them, do not restate them,
and do not opt out of them.

### Landmarks

`<header>` (banner) · `<nav id="tab-nav" aria-label="Sections">` ·
`<main id="main-content">` · `<aside id="help-panel" aria-label="Help">`
(complementary). Exactly one of each. A tab renders *inside* `main` and does
not add landmarks of its own.

### Skip link

First focusable thing on the page, invisible until focused. The nav is nineteen
buttons and a find box: without it a keyboard user had twenty-one stops before
the first control on the tab they came for, on every page load.

It calls `focusMain()` rather than relying on `href="#main-content"` alone —
a fragment jump scrolls the page but leaves focus at the top of the document in
Safari and Firefox, which is the half of the problem that matters.
`#main-content` carries `tabindex="-1"` so it can receive that focus, and
`#main-content:focus { outline: none }` with the ring restored on
`:focus-visible`, so a mouse click into the page does not paint a box around
everything.

### Focus management

| Moment | Where focus goes |
|---|---|
| Skip link | `#main-content` |
| Tab switch, from the nav or help panel | The new tab's own nav button — the element that just became `aria-current="page"` |
| Tab switch, on a phone | `#main-content`, because the drawer has closed and that button is off-screen |
| Tab switch, from anywhere else | Nowhere. It stays put |
| Nav collapse/expand | The toggle, through the re-render. On a phone collapse, the header's ☰ |
| Help collapse/expand | The help toggle, at every width |
| Modal open / close | The dialog card / whatever opened it. `Modal` already does this; `MemMeter` does now too |

The tab-switch rule exists because `renderTabs()` replaces the nav's
`innerHTML`: the button that was clicked no longer exists when the switch
finishes, and a keyboard user was left on `<body>` after every tab change. The
"from anywhere else" row is the guard — `switchTab()` is also called by
`Workbench.restoreFromUrl()` at startup and by deep-link buttons inside tabs,
and a page that grabs focus on load is worse than the problem being fixed.

### State on shell controls

`aria-current="page"` on the active nav item — exactly one, always.
`aria-expanded` + `aria-controls` on every disclosure: the header ☰, the nav
toggle, the help toggle, and the memory strip. If you add a control that opens
something, it says so and it says when.

### The live region

One polite region, `#app-status` in `index.html`. `announce()` in `core.js` is
the only thing that writes to it. The four rules are stated above that
function; in short:

1. Announce the **result of something the user did**, and nothing else.
2. **Never per-frame.** A stream is not an announcement. U5's three streaming
   surfaces announce when they start and stop and offer a summary on demand;
   the frames live in a log the user reads at their own pace.
3. **Polite, always.** `assertive` interrupts whatever is being read, which is
   right for one thing — an error that has just destroyed what the user was
   doing — and that case belongs to a modal or a visible banner, both of which
   move focus and so announce by themselves.
4. **Say what changed, not that something changed.** "Networks — Stations &
   networks" is an announcement; "updated" is a noise.

There is a fifth rule that falls out of the fourth: **do not announce what
focus already said.** A tab switch from the nav lands focus on the new tab's
button, and a screen reader reads it on arrival — "Networks, button, current
page". The live region stays quiet there, and speaks on every other route into
a tab: a deep-link button inside a page, a restore from the URL, and the phone
drawer closing to `<main>`, which has no name to read. Both halves are asserted
in `npm run shell`.

The nav's find box keeps its own `role="status"` region for the result count.
That is deliberate: it is a count attached to a list, and it is read where the
list is.

### Reduced motion

**One policy, one block**, at the foot of `styles.css`: anything decorative
stops, anything load-bearing keeps its duration. This used to be two blocks a
thousand lines apart, each turning off one rail's width transition while
everything else in the app animated regardless.

The second half is not a hedge. The rail transitions are named explicitly at
`transition: none`, because `app.js` waits `NAV_TRANSITION_MS + 40` before
re-measuring maps and a blanket `0.01ms` on everything is how that class of bug
comes back.

### Touch targets

`(pointer: coarse)` bumps every text-entry control to 16 px and gives range
sliders a 1.75 rem thumb. Header buttons are 2.4 rem square from `md` down and
2.15 rem from `xxs`. A U-issue adding a touch control on a phone matches those.

---

## 5. What `npm run shell` checks

From `test/`, and in CI on every push touching the app. It exists for the same
reason the other ten checks do: everything below is invisible to `npm run
smoke`, which opens all nineteen tabs and asserts a clean console.

- **The breakpoint scale.** Every `@media (max-width: N)` in `styles.css` has
  `N` in `BREAKPOINTS`. This is the check that makes the U-issue instruction
  enforceable.
- **Contrast.** Every text-on-background token pair, in both themes, against
  WCAG AA — computed from the values the browser resolves, not from the
  source, so a `color-mix()` or an inherited value is measured as rendered.
  Plus `--ctl-border` against its panel at the 3:1 non-text threshold.
- **The `outline: none` allowlist.** Two entries. A third fails.
- **Landmarks.** One `banner`, one `main`, one labelled `nav`, one labelled
  `complementary`.
- **The skip link.** Present, first in the tab order, and actually moves focus
  to `main`.
- **`aria-expanded`.** Every disclosure in the shell flips its state when
  toggled — the ☰, the nav toggle, the help toggle, the memory strip.
- **`aria-current`.** Exactly one, and it is on the open tab.
- **Focus on a tab switch.** From the nav, focus lands on the new tab's button.
  From nowhere in particular, it does not move.
- **The live region.** Present, polite, and a tab switch puts the new tab's
  name in it.
- **Reduced motion.** One `prefers-reduced-motion` block, and the rails are
  named in it.
- **No sideways scroll.** The document does not scroll horizontally at 375,
  768 or 1440, in either theme, on the shell and on the proving-ground tab.

## 6. What #109 deliberately did not do

The system is applied to the shell and to **one** tab — Networks, the smallest
in the app, which #137 owns afterwards. It is not rolled out across the other
eighteen. Doing that here would re-create exactly the contention the epic's
re-cut removed: three concerns in one file, three agents in the same lines. See
#107 and constraint 2 on #113.
