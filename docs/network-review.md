# Network review — and how the fade margin was calibrated

The **Network Review** tab (in the Admin group, administrators only) reviews a
VHF event-reporting network the way a planner reviews one: the fade margin from
every field station to every repeater, base or proposed site that could carry
it, set beside the margin an attenuator found on site; the model held to every
attenuator test on file, network-wide and hub by hub; how Flood-Net's figures
relate to Radio Mobile's, and how far to trust each; the design principles a
network is checked against; and the register's own faults that skew a review.

This page is for an administrator using the tab, and for whoever next changes
the fade-margin model. The model itself is `pathAnalyse` in
[`path-profile.js`](../path-profile.js), and the ground it prices a path over is
`pathGround` beside it; its defaults are `FN_MODEL_DEFAULTS` in
[`core.js`](../core.js); the tab is [`network-review.js`](../network-review.js)
with [`network-history.js`](../network-history.js), and LiDAR is
[`lidar-profile.js`](../lidar-profile.js). `npm run review` and `npm run lidar`
hold them to what is written here.

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
  fade-margin map paints it, computed the same way over the same ground
  (`pathGround`), so the three can never disagree about one link;
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
as a slip of the pen. The datastore answers at most 1,000 rows to one read, so
every read that could run past that is asked for a page at a time.

A reading is a **step, not a point**. Most attenuators go up in **3 dB** — the
sheet's own scale runs 0 to 30 dB in eleven loads — so a test that carried 24 dB
and not 27 says the margin is somewhere in **24–27**, and the column shows it
that way. About one test in four since 2016 reads off that grid — 13, 22, 25 —
and those came from a 1 dB attenuator: 22 is **22–23**. Most field attenuators
stop at **30 dB**, so a test that reached it is shown as **≥30** and means "at
least 30". A station's figure is the median of its visits' steps: the median of
their lower ends to the median of their upper ends. So 21 and 27 is **24–27**,
and 27 and ≥30 is **≥28.5** — a median that leans on an "at least" is one too.

A measured margin is end to end: whatever path the station actually took to
base. So it is set against the row's **Best** cell, and the *Against the
attenuator* tile gives the mean error (model minus measured) and the typical
error over the rows that have both. A model figure anywhere inside the step is no
error; outside it, the error is the distance to the step. The CSV carries the
step as two columns, `measured_margin_from_db` and `measured_margin_to_db` (empty
for "at least").

## The model against every attenuator test

**Check every station** (the panel under the matrix) runs the matrix's
arithmetic over the whole register at once: every station whose path margin has
been tested since 2010, priced to every repeater whose pass ranges carry it
(within 150 km) and every base within 80 km, its best path held to the step its
latest three tests put its margin in. A few thousand paths — minutes, not
seconds — with a Stop. It answers:

- **the allowance the field asks for**, fitted over the stations whose best
  path is 35 km or less, with a bootstrap range — and **Use … dB for this
  session** sets it on the link budget card, which every figure follows;
- the mean and typical error at the allowance in force, and the share of the
  pairs of stations the tests can tell apart that the model puts the right way
  round;
- the same **by distance**, **by hub** (five tested stations or more) and **by
  basin** (ten or more);
- and the **hubs whose stations all read 10 dB or more better or worse than
  modelled** — named, with what to check.

**⤓ CSV** saves a row per station as
`floodnet-attenuator-history-check-YYYYMMDD.csv`: its best hub, the modelled
margin, the measured step and the error.

### What it found

On the tests on file at the time of writing — 772 stations with a test since
2010, 681 of which the register can price — the field allowance that fits the
**473 stations whose best path is 35 km or less** is **12.2 dB** (11.0–13.5 dB
at 90 % by bootstrap), and **12 dB is the default**. Over those stations the
model is out by ±8.0 dB typically, within ±6 dB for 51 %, and puts 65 % of the
pairs the right way round.

| Best path | Stations | Model, median | Measured, median | Mean error at 12 dB | Allowance it asks for |
|---|---:|---:|---:|---:|---:|
| under 10 km | 101 | 38.2 dB | 27.0 dB | +4.9 dB | 20.0 dB |
| 10–20 km | 191 | 28.8 dB | 24.0 dB | 0.0 dB | 12.0 dB |
| 20–35 km | 181 | 22.6 dB | 22.0 dB | −2.3 dB | 9.1 dB |
| 35–50 km | 102 | 11.7 dB | 24.0 dB | −11.0 dB | −0.7 dB |
| over 50 km | 106 | 3.5 dB | 22.8 dB | −21.1 dB | −8.0 dB |

The field reads 22–27 dB at every distance; the model falls from 38 to 4. That
is the network's design, not the model's physics: every station was built to
work, and a long link was given what it needed — a directional antenna, a taller
mast, a better site — which the register mostly does not record. The model,
knowing only the register's omni on a 4 m pole, is pessimistic past ~35 km, so
the allowance is fitted short of that and the long paths are shown, not fitted.
Each long link whose real antenna and mast go into the register closes the gap
for that station.

Hub by hub the spread is wide: of the 37 hubs with five tested stations or
more, **15 ask for an allowance 10 dB or more from the network's** — from about
32 dB more hopeful to 10 dB less. A hub whose stations all read better than
modelled is a register entry short of something — a mast taller than the
assumed 10 m, an antenna better than an omni, a position off its summit; one
whose stations read worse, the opposite. Several of the furthest out have short
paths, so the long-link explanation does not cover them, and most stand on
remote summits the LiDAR does not reach (below). The fix is the register's, and
the next run says whether it worked.

## How the fade margin was calibrated

Flood-Net and Radio Mobile run the same propagation model — Longley–Rice — over
much the same terrain. Their fade margins for one path could still differ by tens
of decibels, and the way to tell which was nearer the truth was the margin
measured on site. The first calibration used the one region where both models
had been run — 54 stations round Mt Stuart, tested in 2018–20 — and gave
16.3 dB. The history check above then took it to every tested station, and the
network asked for 12.

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
| The field allowance, fitted network-wide | −12.0 dB | — |

#### 1. The land cover, stood on the profile and charged at the masts

The land-cover model stood each 10 m land-cover class's representative height on
the terrain — 15 m of trees, 10 m of town — and treated it as solid, then charged
each mast standing among it the P.2108 terminal-clutter loss as well. At VHF a
tree canopy is largely transparent: a 150 MHz signal loses a few hundredths to a
tenth of a decibel per metre of foliage (ITU-R P.833), not the diffraction loss
of a solid ridge of that height. So every forested or suburban path was priced as
though it ran through a hill, and the same trees were charged twice. Next to the
antenna, a canopy a few tens of metres away also took Longley–Rice outside the
geometry it was built for, and a handful of paths came out over 100 dB short.

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

So `pathAnalyse` stands each end on the higher of its survey and the tile under
it, and says so: the link budget's Terrain row and the profile card name the end
and the metres it was lifted, and the matrix flags a station lifted more than
5 m. The same rule applies to the centre of a polar coverage plot. The survey is
still the end's height wherever it is at or above the tile.

#### 3. Repeaters and bases on a mast

Every station in the register is on the 4 m field-station radio system,
repeaters and bases included. A repeater on a summit modelled with a 4 m antenna
sits among the terrain model's summit pixels, and pays for it. The propagation
settings carry a **repeater & base mast** height — 10 m by default — and a
station with the repeater or base role is modelled at least that high. A radio
system that says more keeps its own figure, so the fix is in the register: give a
repeater whose mast is known a radio system with its real height, and the
assumption is gone for that site. The matrix's hub list and the link budget's
antenna-height box both say when a mast is assumed.

#### 4. The field allowance

What is left is the bare-terrain figure's average shortfall against the
attenuator — the masts' own surroundings, feeders and connectors, receivers at
busy sites: **12 dB**, fitted network-wide (above). It is measured, not
modelled, and it is the same for every path — one path can stray from it by the
typical error, and a hub by much more. It was fitted at the network's default
reliability (spot mode, 70 % of situations), so asking for a different
reliability is asking for a different figure.

How the readings are read moves it by a few decibels. On the first region's 54
stations: **read as exact figures**, the tests gave 18.9 dB — a test that
carried 24 dB and not 27 was taken for a margin of exactly 24, the bottom of its
step, charging the model for up to 3 dB it never lost; **as steps**, 16.3 dB.
The network-wide fit reads them as steps throughout, 3 dB or 1 dB as each
reading says.

The fade-margin map's saved rows carry the model they were computed on (`itm-p2p/3`
and the allowance), so every row saved before a change of allowance is stale until
it is computed and saved again: turn the fade-margin layer on in the Stations
map, let it sweep, and press Save.

## Against Radio Mobile, in one region

The 54 stations round Mt Stuart were also modelled in Radio Mobile (53 of the
paths). Each model against the same tests, Flood-Net at the network's 12 dB:

| Model | Mean error | Typical error | RMS error | Within ±6 dB | Within ±10 dB | Pairs in order |
|---|---:|---:|---:|---:|---:|---:|
| Flood-Net, land-cover model (the default before the calibration) | −41.0 dB | 41.9 dB | 45.7 dB | 6 % | 9 % | 30 % |
| Radio Mobile, as configured for the same paths | +2.3 dB | **4.0 dB** | **7.2 dB** | **77 %** | **87 %** | **76 %** |
| Flood-Net, field-calibrated (the default now) | +2.4 dB | 5.2 dB | 8.8 dB | 70 % | 74 % | 63 % |

Errors are model minus measured: positive is a model more hopeful than the
attenuator. Each reading is its step (above), so a model figure anywhere inside
the step is no error, and a reading at the attenuator's limit counts as "at
least that". *Pairs in order* is, of the pairs of stations whose steps do not
overlap — the pairs the attenuator can tell apart — the share the model puts the
right way round. This region on its own asks for 16.3 dB, so at the network's
12 dB both models read about 2 dB hopeful here.

At the network's allowance Flood-Net reads within a median **0.1 dB** of Radio
Mobile over the 134 paths — from 5.4 dB higher to 11.9 dB lower for eight paths
in ten — ranks them much as Radio Mobile does (rank correlation 0.86) and puts
**89 %** of them in the same green, amber or red band (10 % before the
calibration). Radio Mobile is told its link settings and nothing else, and those
settings sat about 12 dB below Flood-Net's defaults — about the allowance. So, in
this region and to within the typical error:

- **Flood-Net ≈ Radio Mobile**;
- **margin on site ≈ either, less 2 dB** — and network-wide, margin on site ≈
  Flood-Net, which is how the allowance was fitted;
- and an attenuator stepping in 3 dB reads the step at or below the margin — on
  average 1.5 dB under it.

The tab has a converter for one figure, which also says what the attenuator
would read. If a Radio Mobile figure was read off a display that tops out —
every strong path reading the same ceiling, say 49 dB — it is a clipped figure,
and means "at least that".

**Is Flood-Net better?** Not path for path. Radio Mobile — set up one path at a
time by whoever designed the network, with each site's own antenna and mast — is
a little nearer the attenuator here (typical error 4.0 dB against 5.2) and puts
more pairs of stations in the right order (76 % against 63 %). Given the same
site details, Flood-Net matches it: run with Radio Mobile's antenna heights and
positions, its typical error on these paths falls to 3.6 dB and its pairs in
order rise to 74 %. The gap is the register's, not the model's. Of the 53 paths
both modelled, both miss by more than 6 dB on the same 12; Flood-Net misses 3
more, Radio Mobile none.

Flood-Net's strengths are elsewhere. It computes every link in the register,
both ways round, from the register as it stands today, with nobody setting a path
up; it is calibrated against the whole network's tests, not one region's; and it
says which hubs the field disagrees with, which is where the register needs
fixing. Where the two disagree by much on one path, check the register's position
and height for both ends before trusting either. Neither models antenna patterns,
interference or the tree that grew last year. Confirm on air before building on
either.

## The ground: LiDAR, where it matters

The link budget card's propagation settings have a **Ground** setting: the
~30 m terrain tiles (the default), or Geoscience Australia's **5 m
LiDAR-derived DEM** where it decides the answer. The card, the fade-margin map
and the Network Review all follow it; polar coverage, the line-of-sight layer and
the 3-D drape stay on the tiles.

### Where, and why only there

A radio path is decided in a few places: at its two ends, where an antenna a few
metres up clears the edge of its own hilltop or does not, and at the ridges that
come near the line of sight. Everywhere else the ground is far below the line and
a better DEM changes nothing. So `lidar-profile.js` fetches LiDAR:

- within **500 m of each end**;
- round every **obstacle** — wherever the 30 m ground comes within **30 m of the
  line of sight**, or inside the first Fresnel zone where that is wider: the
  strongest six, **150 m either side**, a broad crest whole up to 1.5 km;
- and stands a **repeater or base on the highest LiDAR ground within its
  registered position's rounding** (half the last decimal place — three
  decimals of a degree is ±56 m — held between 15 and 100 m): a radio site is
  chosen for its height, and a rounded position on a summit is otherwise priced
  on a shoulder ten metres down.

The profile is the tiles at 5 m spacing, with the LiDAR spliced into those
stretches and blended over 25 m where the two meet. The grid is asked for in
fixed 0.01° tiles (~1 km), so the ground round a hub, or a ridge many paths
cross, is fetched once and shared. Over every tested station's paths that came
to about nine tiles a path and 15,410 tiles in all — about a third of a second
a path in a batch, a few seconds for one path on the card, with no failures.
Pricing the whole path in LiDAR was weighed and not done: the same answer for
several times the requests.

### What it did to the figures

Each ground against the same tests (the 681 stations, each ground at its own
fitted allowance):

| Ground | Typical error | Within ±6 dB | Pairs in order |
|---|---:|---:|---:|
| ~30 m tiles, 256 points — the default | **10.6 dB** | **46 %** | **62 %** |
| ~30 m tiles, a point every 5 m | 12.4 dB | 44 % | 61 % |
| 5 m LiDAR at the ends and the obstacles | 12.8 dB | 42 % | 58 % |
| … with repeaters and bases stood on their tops — the LiDAR setting | 12.5 dB | 42 % | 61 % |
| ~30 m tiles with LiDAR crest heights at the obstacles only | 10.7 dB | 45 % | 62 % |

Sharper ground did not make sharper figures. At 5 m the model prices the exact
spot the register puts each antenna — and the register's positions are rounded
and its heights surveyed elsewhere, so a repeater fifty metres off its summit, or
a field station beside a bank, is priced exactly wrongly. Longley–Rice, built and
checked on coarse terrain profiles, also reads every bank beside a 4 m antenna
as a horizon. Standing the masts on their tops wins back most of the loss, and
LiDAR at the obstacles alone changes nothing measurable. So:

- the **tiles stay the default**;
- **LiDAR is the setting for studying one site whose position is known** — the
  profile card draws the LiDAR stretches in green, says what share of the path
  they are, and draws the ground bare (land cover at 5 m would be thousands of
  samples, for a model that does not price it);
- and LiDAR's real work, until the register is as sharp as the ground, is
  **checking the register** (below).

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

The faults in the station register that skew any review, and how the tab finds
them:

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
- **Repeaters and bases against the LiDAR** — *Check them* reads the 5 m grid
  round every repeater and base: the LiDAR ground at its registered position
  against its survey, and the highest ground within 100 m. A survey more than
  5 m off, or a top more than 5 m higher close by, is tabled — a register entry
  that is not where the antenna is. Where the LiDAR holds nothing (many remote
  summits) it says so and counts them.
- **Hubs the field disagrees with** — from the history check: a hub whose
  stations all read 10 dB or more better or worse than modelled.
