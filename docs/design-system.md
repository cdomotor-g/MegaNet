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

And two files check it: `test/shell.mjs` (`npm run shell`) holds the system
against the shell, and `test/tabs.mjs` (`npm run tabs`, added by #137) holds it
against every tab a U-issue has converted — **all nineteen (plus the two tabs
born converted), 336 assertions, as of #136**. Both run in CI on every push that
touches the app; what each enforces is listed in §5 and §6 at the bottom of this
page. Every claim below that *can* be checked mechanically is
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
There is exactly one allowlisted exception in the app, and it replaces the ring
with a shape change on the element that has focus:

- `.nv-node` — an SVG `<g>` has no box, so the browser rings the group's
  bounding box, which on a force-directed graph is a rectangle nowhere near the
  node. The node's own circle takes the accent stroke at 3 px.

There were two until #165. The other was `.map-split`, the Stations tab's
draggable divider — a 3 px hairline the height of the page, where a ring read as
a second divider. The divider went with the two-pane split and its exception
went with it, **and the check is what remembered**: `npm run shell` fails on a
stale allowlist entry exactly as it fails on an unlisted `outline: none`, so
deleting the rule could not quietly leave the exception behind.

`npm run shell` holds that allowlist. A second exception has to be argued into
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

⚠️ ~~**A palette change does not reach the ARRO chart.**~~ **Closed by #141.**
`ArroData` still writes literal colour values into its SVG rather than `var(…)`
— the PNG export has to have something to render, and a `var()` resolves to
nothing once the picture has been handed to a canvas — but the literals now
come from `--ad-series-1…12` (light and dark), resolved off the document at draw
time exactly as `--text` and `--panel` always were. A palette change reaches the
chart on the next `repaint()`, which `toggleTheme()` already calls, and
`npm run tabs` holds the round trip.

The twelve series colours are **categorical and deliberately out of the contrast
contract**, for the same reason the eight region fills are: they say "a
different sensor", not "better or worse". What tells two series apart without
colour is the legend, the **dash pattern** on the line and the readings table
under the chart — see the chart pattern below. A colour the operator picks by
hand takes that series out of the palette permanently, in both themes.

### The categorical sets, and the ACMA boundary (#138)

There are now **four** categorical palettes, all built the same way and all out
of the contrast contract for the same reason:

| Set | Where it is drawn |
|---|---|
| `--maps-region-*` (8) | Radio Path Maps' basin drawing and its chips (#137) |
| `--ad-series-*` (12) | the ARRO / Field Data chart (#141), and the station card's inspection-history chart, which draws from the first eight |
| `--acma-mech-*` (7) | interference mechanisms — RF Environment, RF Changes, the transmitter card, the Workbench, the Stations map (#138) |
| `--rfc-series-*` (8), `--rfc-class-*` (8) | the RF Changes timeline's data-quality series, and the snapshot-diff change classes (#138) |

The mechanism set is the one that crosses tabs, so **which of two helpers to
reach for is the thing to know**, and `core.js` states it above `ACMA_MECH`:

- **`acmaMechVar(mech)`** returns `var(--acma-mech-…)`, for a CSS context — a
  `--dot` on a `.legend-sq`, a `fill:` in a stylesheet. The token reaches the
  element and the theme reaches it for free, with no repaint.
- **`acmaMechColor(mech)`** returns the value the token resolves to *now*, for
  an SVG presentation attribute or a canvas, where `var()` resolves to nothing.
  A theme change reaches it on the next draw.
- **`cssVar(name, fallback)`** is the general form of the second one. Six files
  had written that `getComputedStyle(…).getPropertyValue(…).trim()` line out by
  hand; it is one function now, with a fallback, because a token misspelt there
  resolves to the empty string and the attribute draws in black with nothing
  thrown.

`ACMA_MECH[k].color` **stays the light literal**, and that is not an oversight.
Five of its consumers are Leaflet options — `L.polyline({color})`,
`L.polygon({color})`, a divIcon's inline `background` — which become SVG
presentation attributes, and those do not take `var()`. Those five are the
Stations map layer.

**So the ACMA boundary #138 and #136 were told to agree is this**, and it is
drawn between *kinds of thing* rather than down the middle of one:

- **The palette is the system's.** #138 tokenised it, converted every swatch in
  the app to `--dot`, and left `.color` working untouched. #136 converts the map
  layer's five call sites to `acmaMechColor()` whenever it likes, or never.
- **The transmitter card is shared furniture, and it is done.** It renders on
  three tabs owned by three issues (Stations, RF Changes, the Workbench), so it
  is not any of theirs to style. #138 converted it once — tokens, `.link-btn`
  in place of six `<a href="#" onclick>`, a name, `role="dialog"`, focus in on
  open and back to the opener on Escape. #136 and #139 inherit it converted.
  Before this you could open a card on either long tab and, from a keyboard, not
  be able to shut it.
- **Everything else on the map is #136's**: the filters panel, the layer, the
  pins, the beams, the legend and the popup.

### Two colour decisions from the map's later overlays

**`--map-line-blocked`** is the crimson the line-of-sight layer paints a link
whose path the terrain blocks, and it is a token in the contrast contract
rather than a fifth categorical set: the colour *is* the verdict, which is
exactly the 1.4.11 case, so it holds 3:1 against `--panel` in both themes and
`shell.mjs` measures it. It is deliberately not a reuse of `--map-blast` — a
blast is something an operator armed and will disarm, an obstruction is a
property of the ground, and both reds can be on screen at once, which two
meanings on one token would forbid. The layer reads it through `cssVar()`,
Leaflet's path options being the consumer that cannot take a `var()`.

**The wind-region fills in `map-wind.js` are literal hexes**, and that is the
categorical doctrine applied rather than defied: they are Leaflet path
options, which cannot take `var()`; the ramp is the one AS/NZS 1170.2's own
map has taught, so the hues belong to the dataset rather than to the theme;
and at fill-opacity .2 over map tiles neither theme needs its own set. What
carries the meaning without colour is the region letter — in the switch's
legend, whose dots take the hex through `--dot` like every other swatch, and
in every station callout once the layer has loaded — the same argument
`--maps-region-*` records.

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

`.link-btn` is its opposite, added by #138: a `<button>` that reads as a link,
for the thing the app writes dozens of times as
`<a href="#" onclick="doSomething();return false">`. That is announced as a
link, offers a middle-click that opens a copy of the page, and navigates to the
top of the document if the handler throws before `return false`. The action is
in-page, so the element is a button. Not `.row-open` — that one is deliberately
styled as the *text* it replaces, because forty bordered controls down a name
column read as a form; this one is styled as the link it replaces.

### Rows of controls

`.panel-header`, `.header-actions` and `.button-row` are all "a row spread
across the panel" — `justify-content: space-between` is the point of them, a
heading at one end and its actions at the other. **`.button-group`** (#138) is
"these controls belong together": same gap, same wrap, no spreading. Reaching
for `.button-row` when you meant `.button-group` is a mistake that looks
deliberate — two buttons at opposite ends of a panel read as confirm and cancel.

**`.control-row`** (#138) is the filter bar above a table or a chart: a wrapping
row whose `label` children stack their text over their control, the way
`.form-grid` does. Six tabs were writing it out inline with four different gaps.
Under `(pointer: coarse)` its controls take the 44 px floor rather than the
app-wide 2 rem, because a filter bar is exactly the thing being tapped in a
vehicle. **`.field-num`** goes on a two- or three-digit input: `input` is
`width: 100%` by default, which in a wrapping row means "as wide as the row",
and every tab that needed a small one had written `style="width:4.5rem"`.

### Form fields

`input`, `textarea` and `select` share one rule: full width, `--ctl-border`,
`--r-md`. `input[readonly]` is `--subtle` on `--muted` — still a field, because
it holds a value worth copying, but it must not look like somewhere to type.
Labels go in `.form-grid` / `.upload-grid`, which give a `label` a `display:
grid` with the control under the text.

**`.check-label`** (#139) is a checkbox with its caption beside it — the one
label shape the stack-text-over-control grids get wrong. It was the third tab
to write it out by hand (`.check-inline` in the modal form and `.ml-check` on
the Message Log came first), which is the three-strikes sign it belongs here:
inline-flex, the caption in a `<span>` so the input does not stretch, the whole
label the pointer target, and the 2.75 rem floor under a coarse pointer. The
two older spellings stay where they are — converting other tabs' markup is not
what adding a primitive is for.

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
7. **A wrapper that can scroll is a named region** *(added by #137)*. A
   `.tall` or `.medium` wrapper caps its height, which means it scrolls, and
   `overflow: auto` on a div is keyboard-scrollable in Firefox and in nothing
   else — everything below the fold of one was unreachable without a mouse.
   Three attributes, and they go together:

   ```html
   <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="net-radio-h">
   ```

   `tabindex` alone buys a stop a screen reader announces as nothing;
   `role="region"` without a name is not exposed at all. Point the label at the
   panel heading that is already there rather than repeating its words — two
   names for one thing drift. Only on wrappers that actually cap their height: a
   short table in a plain wrapper is not a region and must not become a tab stop
   for nothing.
8. **A clickable row carries a real button** *(added by #137)*. `<tr onclick>`
   is a mouse affordance and nothing else — no tab stop, no role, no hint. Do
   not make the row focusable: a row is not a control, and `role="button"` on a
   `<tr>` destroys the table semantics around it. Put a `<button class="row-open">`
   in the row's *name* cell, with the row's own text inside it, and keep the
   row's `onclick` so the whole thing stays a pointer target. The button calls
   `event.stopPropagation()` so the two never both fire. `.row-open` is styled as
   the text it replaces, not as a button — forty bordered buttons down a column
   read as a form; hover and focus are what say it is a control.

9. **A status line's colour is a class, not an inline `color:`** *(added by
   #141)*. `.txt-ok` · `.txt-warn` · `.txt-bad` · `.txt-muted`. Four surfaces had
   each invented their own spelling of the same three statements — an inline
   `style="color:var(--ok)"` in `datastore.js`, `.ad-bad-txt` and `.ad-warn-txt`
   on the ARRO Data tab, `.hist-bad-text` on the history tab. The argument for
   the class over the inline colour is not tidiness: the status tokens are in
   the contrast contract `npm run shell` measures, and an inline `color:` is a
   decision no check can see. Three of the four are converted; `.hist-bad-text`
   is left where it is, because it also carries an `:empty` rule and the
   Inspection History tab is not #141's to restyle.

10. **A sortable column header is a button, and the `<th>` says which way it
    sorted** *(added by #138)*. Nineteen headers across the two RF tables were
    `<th style="cursor:pointer" onclick="…sort('score')">` — pattern 8's problem
    one row up. Every column on both tables could only be re-sorted with a
    mouse, and a screen reader was never told the table was sorted at all, let
    alone by which column.

    ```html
    <th scope="col" aria-sort="descending">
      <button type="button" class="th-sort" data-key="score" onclick="…">Score<span
            class="th-arrow" aria-hidden="true">▼</span></button>
    </th>
    ```

    `aria-sort` goes on the `<th>`, where the spec puts it, and **exactly one
    `<th>` in a table may carry it**. The arrow is `aria-hidden` because
    `aria-sort` has already said which way — this is the one place the visible
    text and the accessible name are allowed to differ, because a name reading
    "Score ▼" makes a screen reader pronounce the glyph. And the sort handler
    **puts focus back**: it replaces the header row's innerHTML, so the button
    that was just pressed no longer exists, and without a `data-key` to find its
    replacement by, a keyboard sort drops the user on `<body>` — exactly what
    `renderTabs()` used to do to the nav (§4).

11. **A graphic wider than its column scrolls in a named region** *(added by
    #138)*. Pattern 7a, applied to something that is not a table. Both RF charts
    sit in a `div` with `overflow-x: auto` and a `min-width` on the SVG inside —
    640 px on the strip plot, 720 px on the timeline — which on a phone is a box
    holding two thirds of a picture and no way to reach the rest without a
    mouse. Same three attributes, and the split #141 found is kept:

    ```html
    <div class="chart-scroll" role="region" tabindex="0"
         aria-label="Strip plot, 1.2 MHz wide — scroll sideways to read the whole span…">
      <svg role="img" aria-label="…12 licensed carriers within ±0.6 MHz…">
    ```

    The scroller is the **control** — it takes the tab stop and its name says
    what operating it does. The `<svg>` is the **picture** — `role="img"`, and
    its name carries the numbers. One job each.

    Text inside an SVG cannot pick up a colour from the design system by
    accident, so `.chart-text` / `.chart-muted` / `.chart-line` / `.chart-grid`
    / `.chart-mark` / `.chart-band` exist to be put on it. The alternative is
    `style="fill:var(--muted)"` on every label, which is an inline style the
    check cannot see past.

12. **A drag-resizable column is a grip in the header, writing to the `<col>`**
    *(added by the Message Log)*. The grip is a slim strip on the `<th>`'s
    right edge, `aria-hidden` and outside the tab order — pointer furniture,
    not a control with a keyboard duty, because the width it adjusts is a
    convenience whose no-pointer path already sits beside it (the Columns
    chooser, with a *Reset widths* button in it). While the pointer is held it
    writes the width straight to the `<col>` element — the one width channel
    `table-layout: fixed` reads, and the one inline style §6 already exempts —
    so a live drag costs no re-render; on release the width is committed to
    state and localStorage, **per view and keyed by column**, so narrow and
    wide keep their own shapes and a hidden column keeps its width for the day
    it returns. Three guards travel with the pattern: a floor per column so
    none can be dragged out of findability, any poll that re-renders the table
    checks for a held grip first (a repaint mid-drag yanks the header out from
    under the hand), and below `md` nothing has to be done at all — the
    `col { width: auto !important }` rule that makes pattern 2 happen
    neutralises the stored widths, and the grips hide with them.

13. **A wrapper that needs more height than the shared cap takes named steps,
    not a drag edge** *(added by the Message Log)*. A draggable edge on a box
    that already scrolls two ways is a fight with the scrollbar, so the height
    is a Short / Tall / Max switch — 42vh (the shared cap), 68vh, 85vh, with
    Max stopping short of the viewport so the panel header and filters stay in
    reach. The chosen step rides the wrapper as a custom property (`--ml-h` on
    the Message Log) — the `--dot` pattern again: a custom property is the
    system reaching the element — scoped under the tab's own class so every
    other `.tall` wrapper keeps the shared cap, and with the property's
    fallback equal to the default step so a wrapper missing it looks the same.

**An implementation note that bit #138, and will bit anything that puts a
`.sr-only` in a table cell.** `overflow` clips a descendant only when the scroll
container is that descendant's **containing block**, and an absolutely
positioned box's containing block is the nearest *positioned* ancestor.
`.table-wrap` was not positioned. So a `.sr-only` inside a cell — the word behind
a ✓, the caption of a table whose panel heading already says its name — was
positioned against the page, escaped the wrapper's clip, and put its static x
(490 px into an 880 px table) into the document's `scrollWidth`. **The page
scrolled sideways on a phone because a screen-reader-only span was doing it**,
which is a bug no screenshot shows and no eye finds. `.table-wrap` is
`position: relative` now, which is what makes `.sr-only` safe to use in a cell
at all.

**One implementation note that bit #137 and will bit the rest.** A
`<colgroup>` of percentage widths is still honoured under `table-layout: auto`,
strongly enough that Pass Ranges' six columns came out at 16% and 8% of a 340 px
wrapper — so pattern 2 was not actually happening on a phone, on any table with
a colgroup. `.table-wrap col { width: auto !important }` below `md` is what makes
it happen, and it is in the responsive block at the foot of `styles.css`. The
proportions still apply above `md`, where they are right.

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

**Two things #141 learned applying this to the biggest chart in the app**, and
both generalise:

- **The picture and the control are two elements, and keeping them apart is what
  makes part 1 possible.** The ARRO chart is an `<svg>` inside a focusable stage
  that pans, zooms and pins. The stage is a *control*: it is the tab stop and
  its name says what operating it does. The `<svg>` is the *picture*: it is
  `role="img"` and its name carries the numbers. Putting one name on the stage
  meant the interaction hint and the headline number competing for one string,
  and the number lost — the label was `"Sensor readings over time"` whether the
  chart held twelve readings or twelve thousand.
- **Rebuild the name where the view changes, not where the picture is drawn.**
  Computing it walks the readings in the window, and the chart redraws on every
  crosshair move. `ArroData.drawOv()` is the one function that runs on a view
  change and on nothing else, which is where the name, the readings table and
  the comparison panes are all refreshed from.

**A third thing, learned by the second chart to carry more than one unit.**
The Stations tab's inspection-history chart plots any of 37 recorded parameters
against time, and they are in volts, decibels, milliamps, watts and kilopascals.
Two answers were available and both are worse than the one taken:

- *One axis for everything.* Volts (11–14) and milliamps (0–500) on one scale
  draw a flat line under a mountain and imply the two are comparable.
- *Normalise each series to its own 0–1 band.* This fits any number of units on
  one picture, and the cost is that every gridline becomes a lie — the shape is
  then the only true thing left, and the numbers on the frame say nothing about
  any of the lines.

So: **one axis per unit, at most two — left and right — and a parameter in a
third unit is named under the chart as not drawn.** The bound is on the
*picture*, never on the data: the table under it lists every parameter the
operator ticked, drawn or not, which is what makes "not drawn" a routing
decision rather than a refusal. Same principle as the capped table below, one
level up.

**And part 3 has a floor: a capped table says so.** The readings table is up to
300 rows and the window can hold a hundred thousand; it prints which it is and
points at the two Export buttons for the rest. A table that silently showed the
first 300 would read as "these are the readings", which is a worse answer than
no table.

**Colour is never the only channel.** Two series drawn in two hues are one
series to a red-green dichromat and to a greyscale printer, which is what an
incident report usually is. `arro-data.js` carries six dash patterns and four
marker shapes cycled with the twelve colours — off when only one series is
shown, because a lone dashed line says "provisional" and means nothing of the
kind.

**A zoom gesture is a modifier first and a toggle second, and it commits
through controls that already exist.** The ARRO chart's two drag zooms — the
box, and the vertical band that rescales the y axis alone — each have a
toolbar toggle and a held key (Shift and Alt), and the keys outrank the
toggles, so neither gesture ever needs a trip to the toolbar mid-thought.
Neither leaves private state behind: both commit through the axis-mode
control the toolbar already offers — manual, with the min/max inputs holding
the dragged numbers — so the committed range is visible, editable, and honest
about what happened. Reset (double-click, or the 0 key) restores **both
axes** and the vertical mode the operator had chosen before the first
gesture; choosing a mode by hand drops that stash, because the operator has
spoken since and reset must not overrule them. And the second lesson above
applies verbatim as gestures accumulate: the stage's and the overview's
accessible names are rebuilt where the view changes, so a name that says what
dragging does goes on saying the truth after the gesture set has grown.

### …and the one graphic that is allowed to be `role="img"` while being clicked

*(Pattern 8, added by #137.)* The rule above has an edge, and Radio Path Maps'
Queensland basin drawing is standing on it: a hundred clickable polygons whose
only operation — filter the list to this region — is **already on eight labelled
buttons in the chip row directly beneath it**. Making each basin a tab stop
would be a hundred stops for something that is eight; leaving them unnamed and
unreachable is what it was.

So: **a graphic that is a shortcut for controls beside it is named as a picture,
and the controls are the operable path.** The conditions, all three:

1. Every operation the graphic offers is on a named control **in the same
   panel**. If one is not, the graphic is the sole route to it and `role="img"`
   is a lie.
2. Nothing inside the graphic is in the tab order.
3. Its accessible name still does parts 1 and 2 above — the headline number and
   what it shows — *and* says where the operable version is. The basin drawing's
   name ends "…which the region buttons below do as well."

Condition 1 is checked rather than promised: `npm run tabs` fails if a region
drawn on the basin map has no chip.

Colours inside such a graphic are tokens like any other. The eight region fills
were eight literals inside `network-maps.js`, written into `polygon.style.fill`
— which is why the largest surface on that tab stayed at light-theme saturation
on a `#0f1720` page. They are `--maps-region-*` now, with a dark set, and the JS
sets `--basin` to a `var(…)` rather than to a colour. They are deliberately
**not** in the contrast contract: a categorical palette forced to 4.5:1 against
two themes is eight near-blacks that no longer tell each other apart, and what
carries the meaning here is the region's name on the chip, not the hue.

### On-map controls — one icon, one flyout, one pin

*(Pattern 9, added by #164.)* Seven Leaflet maps, and every one of them wants
controls in its corners. There is one control for that: `MapChrome.panel()` in
`map-controls.js`, which the base-map picker and the Stations map's Map display,
Draw & measure and legend panels are all four built out of. A tab adding a fifth
uses it rather than writing a Leaflet control of its own.

**The rule it exists to enforce: on a map, an icon is all there is until
somebody asks for more.** A map is the one surface in this app where the content
*is* the whole panel, so a control permanently parked in a corner is permanently
in the way.

Three ways to ask, and they are three different users — a panel that answers
only the first is a panel a keyboard cannot open:

| in | what it is |
|---|---|
| `:hover` | the headline behaviour, on pointers that have one. Deliberately **not** reported by `aria-expanded`: nobody reading the page through a screen reader is hovering it |
| `.is-open` | a click, a tap, or Enter/Space on the icon — a plain disclosure, the same contract `<summary>` has. The JS owns this class and `aria-expanded` reports it, so the two cannot disagree |
| `.mn-mapctl-body:focus-within` | the safety net. While a panel is open on hover alone its controls are in the tab order; Tab into one, move the mouse, and without this it goes `display: none` **with focus inside it** — focus drops to `<body>` and the keyboard user is at the top of the document. #136 met this exact defect in a hover gate elsewhere. A `focusin` handler also promotes such a panel to `.is-open`, so the state catches up with the pixels |

**The `display: none` is load-bearing, in both directions.** A collapsed panel's
controls must not be tab stops for something invisible — which is why it is
`display: none` and not `opacity: 0` — and that is exactly what makes the
`:focus-within` net necessary once it *is* open.

**Two open states, and the difference is not decoration.** *Hovered* is a
flyout: absolutely positioned, opening leftward out of its own icon, so nothing
else moves. That is why these are not simply expanded in place the way Leaflet's
own layers control is — with four controls in one corner, expanding in place
shoves the three icons below down the screen the moment the pointer crosses the
first, and the icon you were reaching for is somewhere else. *Pinned* is docked:
back into the corner's own column, so two pinned panels stack instead of
overlapping, and the icon is dropped while it is docked. Pinning is remembered
(`state.mapPanelsPinned`, one localStorage key); nothing else about a panel is.

Three things that are not optional:

1. **The title is one string** — the button's `aria-label`, its tooltip and the
   panel's `<h3>`. Panel content supplies no heading of its own; `MapDraw` had
   one and lost it at #164, because two headings means the second is the one a
   screen reader reads.
2. **`L.DomEvent.disableClickPropagation` and `disableScrollPropagation` on the
   wrapper.** Without them, ticking a checkbox in the panel also drops a draw
   pin on the map underneath it, and scrolling a long panel zooms the map.
3. **Content keeps its own id.** `#map-display-block`, `#map-draw-panel` and
   `#map-legend` are what they were in the sidebar, so the functions that
   re-render them did not have to learn that they had moved.

Not a modal, and it does not trap focus: it is a disclosure, `aria-expanded`
says so, and Shift+Tab off the first control lands back on the icon.

### Full screen — fix the anchor, never reparent

*(Added by the Stations map's ⛶ button.)* When a surface needs to become the
screen, put a `position: fixed; inset: 0` class on its own positioning anchor
and take the class off to exit — never reparent it, and least of all into
`Modal`, which wipes its `innerHTML` down all three of its exits and would
destroy a live Leaflet map's DOM mid-flight. The Stations map's `.map-panel`
is already the containing block for everything that works over the map — the
match note, the ACMA and path cards, the corner controls — so one class takes
the whole working surface along and back with nothing moved or rebuilt; a
Leaflet map needs one `invalidateSize()` after the toggle and nothing else.

**z-index 1900 is the slot**: above the header (1300), the drawers (1200) and
the mem modal (1500), below `#app-modal` (2000), so a dialog opened over the
full-screen surface still opens on top of it.

The toggle carries `aria-pressed`, names both directions, and announces the
change through the live region (§4). **Escape exits, and defers to dialogs**:
`Modal`'s capture-phase handler claims the key first, so only an unclaimed
Escape drops the surface back into the page. The flag is session state, never
a preference — full screen is something an operator is *doing* — and the
Escape listener is transient by the teardown discipline: it dies with the
tab's teardown and is re-armed on init, so it cannot outlive the surface it
serves.

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

**Two floors, and which one applies.** The app-wide floor is **2 rem / 32 px** —
comfortably past WCAG 2.5.8 (AA, 24 px), and raising every button in nineteen
tabs was not #109's to do. EPIC #107's per-tab Definition of Done asks for
**44 px**, which is 2.5.5 (AAA). Where they differ, a U-issue's own controls
take 44: #137's chips, icon buttons and row-name buttons are at 2.75 rem under
`(pointer: coarse)`, because a map browser tapped on a phone in a vehicle is the
case the larger number exists for. Pair the height with `align-items: center` —
a 28 px chip in a 44 px box has its text at the top and the bottom 16 px of the
target reads as a gap between rows.

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

## 6. What `npm run tabs` checks

The twelfth check, added by #137, and the other half of `npm run shell`: that
one holds this document against the shell and **one** tab, deliberately and by
its own comment. Nothing was holding the other eighteen.

It runs per tab named in `CONVERTED` in `test/tabs.mjs` — the tabs that claim to
have been through a U-issue. **A U-issue's landing commit adds its tab ids to
that list.** Per tab:

- **No inline style**, except a declaration block that is *only* custom
  properties (`--page-max`, `--basin`, `--dot` — that is the token reaching the
  element) and a `<col>` width. DOM that a third-party library builds and owns
  inside its own container is outside the rule: Leaflet positions every pane
  and tile with inline styles, and that is Leaflet's decision, not the tab's —
  the check skips anything inside a `.leaflet-container`. (First needed by the
  Map Generator, whose view-picker map is up whenever the tab is; the earlier
  converted tabs only build their maps on interaction, so the check had never
  met a live one.) The rule still holds for every element the tab itself
  writes, including anything it appends *into* a Leaflet popup or control.
- **Tables** wrapped, captioned, every `thead th` scoped.
- **Scroll regions** — every `.tall` / `.medium` wrapper is `role="region"`,
  `tabindex="0"` and named (pattern 7).
- **Clickable rows** — every `<tr onclick>` holds a focusable control (pattern 8).
- **Landmarks** — every `<aside>` inside `<main>` has a name.
- **Names** — every visible interactive element has an accessible name.
- **Headings** step by one, over the shell's `h1` **plus the headings inside
  `#main-content`** — corrected by #141. It used to read the whole document in
  order, which handed every tab five free `h2`s: #108's nav group headings sit
  ahead of `<main>` in the DOM, so a tab opening at `h3` followed an `h2` and
  passed. Three of the four tabs #141 converted were doing exactly that.
- **No sideways scroll** of the document at 375, 768 and 1440, in both themes.

A converted tab may carry a **`seed`** — source for a function run in the page
right after `switchTab()` (#141). Two of the nineteen tabs have nothing to check
until something is loaded: ARRO Data draws nothing until a CSV is dropped on it,
and Field Data draws nothing until the datastore answers, which under the
harness it never does. Both seed a pair of series through the module's own
boundary (`seriesData` → `adoptSeries`), so what the check draws is what the app
draws, and both open the `<details>` panels — a closed one is `display: none`
and everything inside it would be filtered out as invisible.

Three things #138 changed about seeds, all of them because the two RF tabs are
lazy and each has two views:

- **A seed is awaited.** Both RF tabs fetch ~2 MB of ACMA JSON on open and draw
  "Loading ACMA interference data…" until it parses, which is far longer than
  two animation frames. A seed that is called and not waited for is a seed that
  checks the loading state.
- **A seed runs in the overflow pass too.** That loop used to measure whatever
  the tab shows on arrival — for these two, a one-line panel that could not
  overflow anything. It is also where the widest thing on RF Changes lives: the
  89-checkbox repeater picker, which only exists once something has opened it,
  and which used to scroll the page sideways by 520 px because an absolutely
  positioned list still counts toward its container's `scrollWidth`.
- **One tab may appear twice**, under two labels, when it has two views that
  cannot both be on screen. RF Environment draws a by-repeater summary table
  *or* — with a repeater chosen — a strip plot and its carrier table in place of
  it; RF Changes grows two columns, a shaded band, a legend, a lower band and a
  grouping table once an onset date and a pasted series exist. The default is
  the half with less markup in it, which is the half a single entry would check.

Plus two claims that belong to a pattern rather than to a tab:

- **Pattern 8's condition** — every region the basin drawing draws has a chip of
  its own, no polygon is a tab stop, and the drawing's name carries a number.
- **The chart palette is the document's** *(added by #141)* — the twelve
  `--ad-series-*` tokens have a dark set and it differs, each series is the
  colour its token resolves to in both themes, the SVG still carries literals so
  a PNG can render it, a colour chosen by hand survives a theme change, and two
  series carry different dash patterns. Without this, the sentence "a palette
  change now reaches the chart" is a claim about a second file that nothing
  holds.

## 7. What #109 deliberately did not do — and what the six U-issues then did

> **Complete as of #136.** The system was applied to the shell and one tab by
> #109; the six per-tab issues carried it across the other eighteen, and the
> last of them closed with #136. Everything below is the record of what each one
> found, kept because the lessons are about the *system* rather than about a
> tab — and the next thing built in this app will meet them again.

The system was applied to the shell and to **one** tab — Networks, the smallest
in the app. It was not rolled out across the other eighteen, because doing it
there would have re-created exactly the contention the epic's re-cut removed:
three concerns in one file, three agents in the same lines. See #107 and
constraint 2 on #113.

**#137 has since taken Networks, Pass Ranges and Radio Path Maps**, and left §6
behind so the next five are checked rather than reviewed.

**#141 has since taken ARRO Launcher, ARRO Data, Field Data and Export** — the
whole Telemetry-and-admin end of the nav. What it left the rest is in this
document rather than in its own four files: the chart pattern applied end to end
and the two lessons that came out of doing it (§3), the `.txt-*` status classes
(pattern 9), the series palette as tokens with the round trip checked (§1, §6),
the `seed` hook and the corrected heading assertion (§6).

**#138 has since taken RF Environment and RF Changes** — the two chart- and
table-heavy tabs in Radio investigation, and between them the densest markup in
the epic (3,133 inline styles the check could see, 628 clickable rows and marks
reachable by mouse alone, nineteen mouse-only sort headers). Almost none of what
it leaves behind is in its own two files:

- **Pattern 10**, a sortable header is a button and the `<th>` carries
  `aria-sort` — including the focus restore, because a sort replaces the header
  it was pressed on.
- **Pattern 11**, a graphic wider than its column scrolls in a named region,
  plus the `.chart-*` classes for text drawn inside an SVG.
- **`.link-btn`, `.button-group`, `.control-row`, `.field-num`** — four
  primitives the app had been writing out by hand.
- **The ACMA mechanism palette as tokens**, `acmaMechVar` / `acmaMechColor` /
  `cssVar` in `core.js`, and **the ACMA boundary settled** (§1) — including the
  transmitter card, converted once for the three tabs that render it.
- **`.table-wrap` is `position: relative`**, which is what makes `.sr-only`
  usable in a table cell without scrolling the page sideways (§3).
- **Three changes to `npm run tabs`** (§6): seeds are awaited, seeds run in the
  overflow pass, and a tab with two mutually exclusive views gets two entries.

**#139 has since taken the Bit Flipper and the Interference Workbench** — the
three-rail investigation surface, the hardest non-map layout in the app. What
it leaves the rest:

- **`.check-label`** — the checkbox-with-caption-beside-it primitive (§3, Form
  fields), the third tab to have written it out by hand.
- **A divIcon marker is a keyboard stop, and Leaflet's `alt` option cannot
  name it** — `alt` reaches only IMG icons; a div icon takes `tabindex="0"`
  and announces as nothing. Set `aria-label` on `marker.getElement()` after
  adding it. The Workbench's ACMA threat squares are the worked example.
- **A CSS-only tooltip is silent** — `::after` content from a `data-*`
  attribute never reaches the accessibility tree. The Workbench's education
  terms carry the tip as `.sr-only` text inside the term as well, so the first
  tier of progressive disclosure reads to exactly the reader it exists for.
- **A bare re-render-boundary div between `.page` and a panel needs
  `min-width: 0` of its own** — the `.panel` rule cannot see through it, and
  its min-content (an unwrapped control row) becomes the page's width on a
  phone. Found on the Bit Flipper's `#bf-results`.
- **The three-rail small-screen model, documented** in `workbench.js`'s
  header: three columns at `xl`, the right rail dropping to a full-width band
  to `lg`, then one column in investigation order — nothing collapses away.

**#140 has since taken ALERT Packets, the ALERT2 / ERT-A2 decoder, the Serial
Monitor and the Ghosting Graph** — the four protocol tabs, where the app draws
bytes rather than stations. What it leaves the rest:

- **A `<div>` with an `onclick` that opens a card is a `<details>`.** Both
  decoders had one, and neither was a tab stop, had a role, or announced its
  state. `<details class="fmtcard"><summary class="fmthead">` is the same card
  with the disclosure a keyboard and a screen reader get for free — and the
  `[open]` attribute replaces the `.open` class the CSS was toggling.
- **`role="img"` over a graphic whose children are focusable is a lie that
  costs you the children.** The Ghosting Graph's SVG carried it while its
  nodes carried `tabindex="0"` and an `aria-label` each: `role="img"` makes the
  whole subtree presentational, so every one of those names was thrown away.
  `role="group"` keeps them. If the picture has tab stops in it, it is not an
  image.
- **A force-directed graph needs part 3 of the graphic pattern like any chart
  does** (§3). The Ghosting Graph now renders *the addresses in view, as a
  table* — same `nv.vis`, so it cannot drift from the drawing — and every row
  carries the same select the node does. That is the difference between a
  picture that is described and one that is optional.
- **Colours that paint their own ground still have to be measured.** The nine
  packet bit-field pairs (`--c-*` / `--c-*-t`) are theme-independent by
  construction, which is exactly why nobody had ever checked them: three were
  under AA on 11–13 px type, and the white ink on the packed-byte gradient was
  too. All twelve pairs are in `shell.mjs`'s contrast contract now.
- **…and a scale drawn *on* the page has to be measured per theme.** The
  ERT-A2's five RSSI bands were literals in `alert2.js`; two of them were under
  1.4.11's 3:1 on the dark panel, one on the light. They are `--rssi-*` tokens
  now, stated per theme, read as `var()` by the CSS and resolved through
  `cssVar()` for the one consumer that cannot take one — Leaflet's pin fill.
  That is the *fifth* time a palette in a JavaScript file could not follow the
  theme.
- **A live surface announces its start and its stop, and nothing in between**
  (§4). The Serial Monitor's stream and the ALERT2 tab's file watch both do;
  the log itself is a named `role="region"` read on demand, never a `role="log"`
  that would narrate every frame.
- **A test seam is usually a missing feature.** `Serial.addDemo()` exists
  because a headless browser has no serial port — and because a person on a
  machine with no device, or behind a blocked picker, could not see what the tab
  does either. It is a button on the tab now, and the sample bytes run through
  the real pipeline, so what the harness holds to the Definition of Done is the
  live card rather than a mock-up of it.

**#136 has since taken Stations** — the largest and most interactive surface in
the app, and the last of EPIC #107's nineteen. **The epic is complete.** What it
leaves behind:

- **`.legend-dot` takes `--dot` now, everywhere.** The Stations legend and the
  filter rows' role swatches were the last callers writing a literal
  `background:`, so the scoped `.wb-page .legend-dot` override #139 needed is
  gone with them — and `roleVar()` / `roleColor()` join `acmaMechVar()` /
  `acmaMechColor()` in `core.js`. That was the **fifth and last** palette in a
  JavaScript file that could not follow the theme.
- **A categorical palette has no single legible ink.** The ACMA map popup wrote
  `color: #fff` over all seven mechanism hues and four of them failed AA doing
  it; white fails four, near-black fails three, and there is no third option.
  Each hue now carries a paired `--acma-mech-*-ink`, picked per colour, the way
  `--c-*-t` is paired with `--c-*`. If you are filling a shape with a
  categorical colour and writing on it, the ink is part of the token, not a
  decision you get to make once.
- **`1fr` is `minmax(auto, 1fr)`, and that is a trap for any grid holding a
  control.** `width: 100%` sets the used width and leaves the intrinsic minimum
  alone, so a `<textarea>`'s `cols` default — about 426 px — became the width of
  a one-column form grid inside a 375 px phone. Two fixes, both kept: the
  responsive override says `minmax(0, 1fr)` like the base rule always did, and
  every control in the shared input rule now carries `min-width: 0`.
- **`visibility: hidden` is not "invisible", it is "gone".** The filter rows'
  *only* shortcut hid that way under `@media (hover: hover)` with a
  `.filter-only:focus` rule meant to bring it back — and that rule could never
  fire, because a visibility-hidden element cannot take focus. On every
  hover-capable device, which is every desktop, the shortcut was unreachable by
  keyboard. `opacity: 0` keeps it focusable; reveal on `:focus-visible`.
- **A canvas map answers the chart pattern by naming what it draws and
  pointing at the text.** The Stations map has ~3,174 pins and no DOM to
  annotate, so its accessible name carries the counts, rebuilt on every layer
  refresh, and an `aria-describedby` note says in as many words that the
  station table below is the same filtered set, row by row, with a button on
  each row that selects it on the map.
- **Name a slider once, not on every step.** Rolling a live readout into a
  control's label renames the control as it is dragged, where the value is
  already announced as the value. The readout is `aria-hidden`, the control
  carries a stable `aria-label`, and the units go in `aria-valuetext`.
- **Say where keyboard parity stops.** `map-draw.js`'s header now does: every
  shape that exists is fully operable, and every shape can be *created* by
  typing its geometry — what has no keyboard equivalent is dragging a pointer
  over a map to place something by eye, which is a feature rather than a fix.

**All nineteen tabs are converted.** What follows applies to whatever comes
next rather than to a tab still waiting:

- **The heading assertion was blind, and probably still is in your tab.** It
  read the whole document, and the nav's five `h2`s meant a tab opening at `h3`
  passed. It does not any more. If your tab's first heading is an `h3`, it is
  going to fail now, and it was wrong before.
- **A tab that renders nothing until something loads was checked as an empty
  state.** If yours has a populated view the harness cannot reach — a query, an
  upload, a device — give it a `seed` rather than accepting the pass. If it has
  two views that cannot both be shown, give it two entries.
- **An inline `color:` is invisible to the contrast check.** That is the real
  reason pattern 9 exists, and it applies to any status line, not just the four
  #141 found.
- **A palette in a JavaScript file cannot follow the theme, and this has now
  been true four times** — the region fills, the ARRO series, the ACMA
  mechanisms, the RF Changes series. If your tab draws a colour it typed itself,
  that is the fourth-time-lucky sign it belongs in the token block.
- **`.button-row` spreads its children apart.** #138 used it for a group of two
  and got a confirm/cancel pair at opposite ends of a panel. `.button-group` is
  the one that packs.
- **Every `.legend-sq` in `app.js` takes its colour as `--dot` now**, including
  the two on the Stations map — the map legend and the ACMA filter panel. They
  are #136's tab, but they are the *palette*, and the palette is the system's;
  a one-token swap that makes a swatch follow the theme is not a layout
  decision. **Five surfaces #138 deliberately left**, all of them somebody
  else's and none of them broken today, because `.legend-sq` still lets a
  literal `background:` win:
  - ~~`workbench.js` — a `#7b1fa2` literal in its legend and two
    `ACMA_MECH[…].color` reads~~ (**done by #139**, plus the threat-square
    divIcon moved to `acmaMechColor()`).
  - `app.js` — the ACMA map pin's divIcon `background` and the popup's
    mechanism pill (**#136**). Both are CSS contexts, so both take
    `acmaMechVar()`. The pill also puts `color:#fff` on a categorical hue,
    which is a contrast question rather than a palette one and belongs with
    whoever restyles the popup.
  - The five Leaflet **options** (`L.polyline({color})`, `L.polygon({color})`)
    are the ones that cannot take `var()` at all and need `acmaMechColor()`
    (**#136**).
