# Network review — and how the fade margin was calibrated

The **Network Review** tab (in the Admin group, administrators only) reviews a
VHF event-reporting network the way a planner reviews one: the fade margin from
every field station to every repeater, base or proposed site that could carry
it, set beside the margin an attenuator found on site; how Flood-Net's figures
relate to Radio Mobile's, and how far to trust each; the design principles a
network is checked against; and the register's own faults that skew a review.

This page is for an administrator using the tab, and for whoever next changes
the fade-margin model. The model itself is `pathAnalyse` in
[`path-profile.js`](../path-profile.js); its defaults are `FN_MODEL_DEFAULTS` in
[`core.js`](../core.js); the tab is [`network-review.js`](../network-review.js),
and `npm run review` holds it to what is written here.

## The path margin matrix

Pick the **repeaters and bases** a network runs through — from the register —
and any **proposed site**, which is only a pin: a name, a position and a mast
height. Every field station the chosen repeaters carry in their pass ranges gets
a row, and *And every field station within … km* adds the stations round any
hub as well (a base carries no pass ranges, so that is how its stations come in).
A station that is itself a hub is a column, not a row, and a pass-range "link"
longer than 150 km is left out — it is an address collision, not a radio path
(see [the register checks](#the-register-before-a-review)).

**Compute margins** prices every cell. Each one is:

- the fade margin in dB, the **worse of the two directions** — the figure the
  [link budget card](../README.md) gives for that path and the colour the
  fade-margin map paints it, computed the same way over the same 256-sample
  profile, so the three can never disagree about one link;
- coloured in the fade-margin map's bands: **15 dB or better** green,
  **6–15 dB** amber, **under 6 dB** red (the map's own thresholds, if somebody
  has set different ones there);
- with the distance, and — on hover — both directions and the verdict over the
  bare ground.

A proposed site gets the field-station radio (what most of the network is) on
the mast typed in, its ground from the terrain tiles, and the frequency of the
first repeater in the review. So "move the repeater from this hill to that one"
is two columns side by side.

Each row then reads off **Best** (its strongest path), **≥15 dB** (how many
paths are good), **Measured** and its flags: *needs a second way out* (best
path under 6 dB), *marginal* (6–15 dB), *one good path only* / *no good path*
(with more than one hub in the review), and *surveyed … below the terrain model*
(see [the ends](#2-an-end-is-never-below-the-terrain-under-it)).

The tiles over the table count the rows: two good paths, one, marginal, and
needing a second way out. **⤓ CSV** (and the banner's ⤓ Export) saves the
matrix as `floodnet-network-review-YYYYMMDD.csv`, with the model it was computed
on in its first line.

### Measured, beside modelled

The **Measured** column is what the attenuator found: the PATH MARGIN table of
the inspection sheets, read through the public `inspection_chart_visit` and
`inspection_chart_fade_margin` views
([`0023`](../db/migrations/0023_inspection_chart_views.sql)). A visit's figure
is the largest load its link still carried (0014's own rule); a station's is the
median of its latest three visits since 2010. A recorded **0** is read as "not
tested" — the imported sheets carry it in blank boxes — and anything over 60 dB
as a slip of the pen.

A reading is a **step, not a point**. The attenuator goes up in **3 dB** — the
sheet's own scale runs 0 to 30 dB in eleven loads — so a test that carried 24 dB
and not 27 says the margin is somewhere in **24–27**, and the column shows it
that way. Most field attenuators stop at **30 dB**, so a test that reached it is
shown as **≥30** and means "at least 30". A station's figure is the median of its
visits' steps: the median of their lower ends to the median of their upper ends.
So 21 and 27 is **24–27**, and 27 and ≥30 is **≥28.5** — a median that leans on
an "at least" is one too.

A measured margin is end to end: whatever path the station actually took to
base. So it is set against the row's **Best** cell, and the *Against the
attenuator* tile gives the mean error (model minus measured) and the typical
error over the rows that have both. A model figure anywhere inside the step is no
error; outside it, the error is the distance to the step. That tile is the
calibration below, re-run for whatever network is on screen. The CSV carries the
step as two columns, `measured_margin_from_db` and `measured_margin_to_db` (empty
for "at least").

## Why the fade margin was recalibrated

Flood-Net and Radio Mobile run the same propagation model — Longley–Rice — over
much the same terrain. Their fade margins for one path could still differ by tens
of decibels, and the way to tell which was nearer the truth was the margin
measured on site.

**54 field stations** whose path margin to base was measured with an attenuator
in 2018–20 were set against each model's figure for the same path (53 of them
were also modelled in Radio Mobile):

| Model | Mean error | Typical error | RMS error | Within ±6 dB | Within ±10 dB | Pairs in order |
|---|---:|---:|---:|---:|---:|---:|
| Flood-Net, land-cover model (the default until this calibration) | −41.0 dB | 41.9 dB | 45.7 dB | 6 % | 9 % | 30 % |
| Radio Mobile, as configured for the same paths | +2.3 dB | **3.9 dB** | **7.1 dB** | **77 %** | **87 %** | **76 %** |
| Flood-Net, field-calibrated (the default now) | **+0.1 dB** | 4.9 dB | 8.1 dB | 63 % | 81 % | 64 % |

Errors are model minus measured: positive is a model more hopeful than the
attenuator. Each reading is the 3 dB step it is (above), so a model figure
anywhere inside the step is no error, and a reading at the attenuator's limit
counts as "at least that". *Pairs in order* is, of the pairs of stations whose
steps do not overlap — the pairs the attenuator can tell apart — the share the
model puts the right way round. Flood-Net's allowance was fitted to these same
stations, so its mean error is near nought by construction; the other columns
are its accuracy.

The old model was not just biased: it put fewer than a third of the pairs the
right way round, worse than a coin. The calibrated one is unbiased and puts
nearly two in three right; Radio Mobile, set up path by path, three in four.

Read as exact figures — 24 as a margin of exactly 24 — the same tests made the
two look level (typical error 6.9 dB for Radio Mobile, 6.7 for Flood-Net), and
Radio Mobile 5 dB hopeful. That flattered Flood-Net: Radio Mobile's errors lean
hopeful, and a reading taken at the bottom of its step makes a hopeful model
look further out than it is.

### What changed, one step at a time

Over 134 VHF paths of 2 to 70 km also modelled in Radio Mobile, Flood-Net's old
figures were a median 46 dB below Radio Mobile's and ranked the paths no better
than chance (rank correlation 0.08). Each step from the old model to the new,
and what it did to Flood-Net's figure:

| Step | Mean effect | Eight paths in ten |
|---|---:|---:|
| Land cover no longer stood on the profile as solid edges | +19.9 dB | +4.3 to +42.0 dB |
| No ITU-R P.2108 terminal clutter at the masts | +16.0 dB | +8.9 to +24.6 dB |
| An end never below the terrain model under it | +13.6 dB | 0 to +42.9 dB |
| Repeaters and bases on a mast, not the field station's 4 m antenna | +5.0 dB | 0 to +27.5 dB |
| The field allowance | −16.0 dB | — |

#### 1. The land cover, stood on the profile and charged at the masts

The land-cover model stood each 10 m land-cover class's representative height on
the terrain — 15 m of trees, 10 m of town — and treated it as solid, then charged
each mast standing among it the P.2108 terminal-clutter loss as well. At VHF a
tree canopy is largely transparent: a 150 MHz signal loses a few hundredths to a
tenth of a decibel per metre of foliage (ITU-R P.833), not the diffraction loss
of a solid ridge of that height. So every forested or suburban path was priced as
though it ran through a hill, and the same trees were charged twice. Next to the antenna, a canopy a few
tens of metres away also took Longley–Rice outside the geometry it was built
for, and a handful of paths came out over 100 dB short.

The **field model** — the default now — runs Longley–Rice over the bare terrain
and takes off the **field allowance** instead (below). The cover is still sampled
and drawn on the profile chart, and the Fresnel verdict still reads it; it is
the loss that no longer does. The land-cover model is one setting away, on the
link budget card's propagation settings, and `npm run pathcover` still holds it
to its own arithmetic.

#### 2. An end is never below the terrain under it

The terrain between the ends comes from ~30 m tiles, and those tiles are a
surface: on a summit they carry the summit's own pixels, in a town or a forest
whatever the radar saw of the roofs and the canopy. A station's surveyed height
is the ground under the gauge. Where the survey was several metres below the
tiles round it, the antenna started the path in a pit of the model's own making
— one repeater, surveyed at 572 m among 584–587 m tiles, lost 40 dB to its own
first three samples.

So `pathAnalyse` now stands each end on the higher of its survey and the tile
under it, and says so: the link budget's Terrain row and the profile card name
the end and the metres it was lifted, and the matrix flags a station lifted more
than 5 m. The same rule applies to the centre of a polar coverage plot. The
survey is still the end's height wherever it is at or above the tile.

#### 3. Repeaters and bases on a mast

Every station in the register is on the 4 m field-station radio system,
repeaters and bases included. A repeater on a summit modelled with a 4 m antenna
sits among the terrain model's summit pixels, and pays for it. The propagation
settings now carry a **repeater & base mast** height — 10 m by default — and a
station with the repeater or base role is modelled at least that high. A radio
system that says more keeps its own figure, so the fix is in the register: give a
repeater whose mast is known a radio system with its real height, and the
assumption is gone for that site. The matrix's hub list and the link budget's
antenna-height box both say when a mast is assumed.

#### 4. The field allowance

What is left is the bare-terrain figure's average shortfall against the
attenuator — the masts' own surroundings, feeders and connectors, receivers at
busy sites: **16 dB** (16.2 dB fitted, by least squares on the distance from each
model figure to its station's step; 13–19 dB at 90 % confidence by bootstrap).
It is measured, not modelled, and it is the same for every path — one path can
stray from it by the typical error above. It was fitted at the network's default
reliability (spot mode, 70 % of situations), so asking for a different
reliability is asking for a different figure.

How the readings are read moves it by a few decibels, so it is worth saying how:

- **Read as exact figures**, the same tests gave **18.9 dB**. A test that carried
  24 dB and not 27 was taken for a margin of exactly 24 — the bottom of its step —
  charging the model for up to 3 dB it never lost.
- **Each test as its 3 dB step**, with a station's median still taken as exact
  when one of its visits read "at least 30": **17.4 dB**. The step on its own is
  worth 1.5 dB — half a step, as it should be.
- **And a median that leans on an "at least" read as one** — 27 and ≥30 is ≥28.5:
  **16.2 dB**. Eleven of the 54 stations are like that.
- A fit that leans harder on the stations reading "at least 30" — a censored
  likelihood, which takes a station that reached the attenuator's limit as
  evidence of how far past it the margin went — would put it nearer **12 dB**.
  That rests on assuming how the errors are spread, with 32 of the 54 stations'
  figures open-ended ("at least"); 16 dB keeps to the cautious side of it.

The fade-margin map's saved rows carry the model they were computed on (`itm-p2p/3`,
and the allowance), so every row saved before this change is stale until it is
computed and saved again: turn the fade-margin layer on in the Stations map, let
it sweep, and press Save.

## Reading a Radio Mobile figure against Flood-Net's

Calibrated, Flood-Net ranks paths much as Radio Mobile does (rank correlation
0.86 over the 134 paths) and puts 81 % of them in the same green, amber or red
band (10 % before). It reads **lower by a median 4 dB** (3.9) — 1.4 dB higher to
15.9 dB lower for eight paths in ten — because Radio Mobile is told its link
settings and nothing else: those settings sat about 12 dB below Flood-Net's
defaults, most of the allowance but not all of it, and Radio Mobile read 2.3 dB
above the attenuator on average. So, to within the typical error:

- **margin on site ≈ Flood-Net** (field-calibrated);
- **margin on site ≈ Radio Mobile − 2 dB**;
- **Flood-Net ≈ Radio Mobile − 4 dB**;
- and an attenuator stepping in 3 dB reads the step at or below the margin — on
  average 1.5 dB under it.

The tab has a converter for one figure, which also says what the attenuator
would read. If a Radio Mobile figure was read off a display that tops out —
every strong path reading the same ceiling, say 49 dB — it is a clipped figure,
and means "at least that".

**Is Flood-Net better?** Not path for path. On the measured paths Radio Mobile —
set up one path at a time by whoever designed the network — is a little nearer
the attenuator (typical error 3.9 dB against 4.9) and puts more pairs of stations
in the right order (76 % against 64 %; a bootstrap puts the gap at 4 to 20
points, so it is real), though it reads 2.3 dB hopeful on average where
Flood-Net, fitted to these stations, reads none. Of the 53 paths both modelled,
both miss by more than 6 dB on the same 11; Flood-Net misses 8 more, 7 of them
on the cautious side, and Radio Mobile 1 more. So where Flood-Net is wrong and
Radio Mobile is not, it is mostly wrong in the safe direction.

Flood-Net's strengths are elsewhere. It computes every link in the register,
both ways round, from the register as it stands today, with nobody setting a path
up — so it is the screen, and Radio Mobile or a test on air the confirmation for
a path that matters. Its calibration is checked again for any network in the
matrix, against whatever the attenuator has found since. And where the two
disagree by much on one path, the first suspect is the register — a position or
a height at one end — and the fix is in the register, not in the model.
Neither models antenna patterns, interference or the tree that grew last year.
Confirm on air before building on either.

## Design principles

What a review checks a network against — general principles for VHF
event-reporting networks. Where the matrix can say how the network on screen
stands against one, the tab says so under it.

1. **Two gateways, one of them hardened.** Every network lands its data at two
   receive sites at least; one carries a second, independent way off site and
   standby power. A partner's base station is welcome, but is not one of the two.
2. **Two paths from every station** — direct and through a repeater, or through
   two different repeaters — so a repeater down is not a station lost. Where
   radio cannot give two, a priority station carries a second means of reporting.
3. **Margins to build on.** 15 dB or better to build on; 6–15 dB needs more
   power, a better antenna or a taller mast before it is relied on; under 6 dB
   needs a second way out.
4. **Short chains of repeaters.** Under ALERT2's TDMA every repeat takes a slot;
   two main repeaters in a chain, about three hops in a dense network and five in
   a sparse one; a two-minute frame of half-second slots to start from, with
   spares kept for growth.
5. **One frequency to a network, neighbours apart**, and a TDMA slot left empty
   where a transmitter is within about 50 km of a neighbouring network's
   receivers.
6. **Networks drawn for radio, not for rivers**, with a clean boundary.
7. **Standard builds, one good repeater** rather than two sharing a mast.
8. **Licensed before it transmits**, including point-to-point licences for long
   backbone hops (the RF Environment tab holds the register).
9. **The right channel for the station** — radio where a few stations share the
   infrastructure, satellite where distance makes radio uneconomic, cellular only
   where losing it in a flood would not cost the warning.

## The register, before a review

Three faults in the station register skew any review, and the tab finds two of
them from the register alone:

- **Repeaters and bases on a field station's antenna height** — counted and
  named; each is computed on the assumed mast until its own radio system says
  otherwise.
- **Pass-range links over 150 km** — a station "carried" by a far-off repeater
  because one of its ALERT addresses falls in that repeater's pass range. They
  are drawn on the map and priced by a fade-margin sweep at hundreds of decibels
  short; they are address collisions, and the fix is in the pass ranges or the
  addresses.
- **Stations surveyed below the terrain model** — flagged per row in the matrix
  as it meets them: worth a second look at the survey, or at the position.
