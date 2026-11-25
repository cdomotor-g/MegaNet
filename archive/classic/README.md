# The Classic look — archived

**Retired 25 November 2026.** Classic was the way Flood-Net looked until October
2026: every tab listed down the side under its group's heading, every button in
the blue banner, ☰ on a phone, and the Stations map with every layer on. Calm
replaced it as the default, and the three looks in pictures (Tiles, Instrument,
Signs) were built on Calm. This folder says what Classic was, what was taken
out, and how to bring it back. Nothing here is loaded by the app.

## What changed

- **Not a choice any more.** `classic` is no longer in `LOOK_CHOICES`
  (`core.js`), so it is not in the Theme dialog, not in Ctrl+K, and not behind
  any button. A browser that had picked it, or an address that says
  `?look=classic`, is handed Calm like any other id nobody knows
  (`lookStored()`); `Looks.start()` (`looks.js`) clears the stored pick and
  shows that device no "new look" note, because it knows the app already.
- **The map starts quiet for everybody** (`mapLayerStored`, `mapLinkColourFromStorage`):
  the Classic answers — every context layer on, links coloured by frequency — are
  gone from the code. A layer ticked on a device is still remembered.
- **The browser checks open Calm.** `test/lib/browser.mjs` pins `?look=calm`
  (and the Stations map's paths as plain lines, `?draw=lines`, as before) where
  it used to pin Classic. A check that is about a look asks for it:
  `{ look: 'tiles' }`, or `{ look: null }` for the app's own default.
- **Docs.** `docs/design-system.md` §8 and `test/README.md` describe four looks;
  the Classic-only paragraphs from them are kept below.

## What is still in the live files (dormant)

Classic was the stylesheet *underneath* Calm, so it cannot be lifted out in one
piece. These parts are still in the live files and can no longer run:

- the Classic branch of `renderTabs()` (`app.js`, after the `lookUsesCalmShell()`
  hand-over) and of the Site Map's anatomy text (`site-map.js`);
- `:root[data-shell="classic"]` rules in `styles.css`;
- the base rules in `styles.css` that Calm's `:root[data-shell="calm"]` block
  overrides.

They are harmless: `data-shell` is always `calm`. Stripping them out is a
separate, larger clean-up (issue on roadmap #113).

## Bringing it back

The last commit with Classic live is `6e085e5` (version stamp `20261125a`).
To restore, in one change:

1. `core.js`: add `'classic'` back to `LOOK_CHOICES`; make `lookUsesCalmShell()`
   `return look !== 'classic'`; restore `mapLayerStored` →
   `lookStored() === 'classic'` for an unset layer, `mapLinkColourFromStorage` →
   `lookStored() !== 'classic' ? 'plain' : 'freq'`.
2. `looks.js`: restore the `classic` entry in `LOOKS` (below), `apply()`'s
   `data-shell` choice, the intro note's *Switch back to Classic* button, and drop
   the clear-the-stored-pick block in `start()`.
3. `map-controls.js` (`first = { classic: names[0], … }`), `map-views.js`
   (`oldDefaultLines`), `palette.js`, `site-map.js`, `capabilities.js`: the
   one-line changes in the same commit that retired it (`git show` it).
4. `test/lib/browser.mjs`: pin `?look=classic` again, and put back the Classic
   sections of `test/calm.mjs`, `test/looks.mjs`, `test/busy.mjs` and
   `test/mapviews.mjs` from `git show 6e085e5:test/<file>`.
5. Bump the version stamp (CLAUDE.md, *Version stamp*).

```js
classic: {
  label: 'Classic', icon: '🗂️',
  hint: 'Every tab listed down the side and every button in the banner, as Flood-Net looked until '
      + 'October 2026.',
  brief: 'every tab in the bar, every button in the banner',
  find: 'classic old back previous',
},
```

## What the design docs said about it

From `docs/design-system.md` §8:

> **Classic** — everything else in `app.js` and `styles.css`. The app as it was:
> every tab in the bar under its group's heading, every button in the banner, ☰
> on a phone.
>
> Every browser check but two opens the app in Classic — the checks were written
> against it and it is still a look people use; `test/lib/browser.mjs` pins it
> through `?look=classic`, which (unlike a stored key) leaves a first visit a
> first visit.
>
> A device that knew Classic and has not chosen is told once, under the row
> across the top, with the way back.
