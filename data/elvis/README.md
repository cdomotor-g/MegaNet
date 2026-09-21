# Elvis station elevations — proposals and an audit, not a decision

Produced by `tools/elvis_station_elevations.py` against the whole of
`stations.json`. **Nothing here has been written into any station.** Regenerate
with:

    python3 tools/elvis_station_elevations.py --relief 15

## The run

3,173 stations asked (every one with a coordinate), **3,173 answered, 0 "No
Data", 0 unreachable**.

| best DEM held | stations | share |
|---|---|---|
| 1 m | 1,608 | 50.7% |
| 50 cm | 337 | 10.6% |
| 2 m | 170 | 5.4% |
| 5 m | 132 | 4.2% |
| **finer than 30 m** | **2,247** | **70.8%** |
| 1 second (~30 m) | 926 | 29.2% |

## The files

- **`elvis-fill.csv`** — 2,333 stations with no `elevation_ahd`, each with a
  modelled AHD figure, the resolution it came off and the dataset that answered.
  These are the straightforward ones: the app currently falls back to a ~30 m
  terrarium tile in EGM96 for these ends, and 71% of them have something better
  in the right datum.

- **`elvis-audit.csv`** — the 840 that *do* carry a surveyed height, worst
  disagreement first, with the `reading` column saying what each one most likely
  means. 123 of them disagree by ≥ 15 m and were ring-sampled.

- **`elvis-summary.json`** — the counts above, plus the difference distribution.

## Read the audit before acting on it

Median |difference| is 4.8 m, p90 17.75 m, max 106.65 m — and the disagreement
is **one-directional**: the surveyed mark is almost always the higher figure.
That is not the model being wrong.

These are creek and river gauges. The coordinate is the gauge down in the
channel; the surveyed mark is the hut or the bank above it. A 1 m model finds
the real channel floor, and a 30 m one smooths it away and lands partway up the
bank — which is why the *coarser* source scores better against the marks while
being less correct about the ground.

So a large difference flags the **coordinate**, not the height. `--relief`
ring-samples 25/60/120 m around each and reports the share of the gap the nearby
ground accounts for:

| station | surveyed | Elvis | rise in ring | reading |
|---|---|---|---|---|
| `palmers_rd` | 151.0 | 44.4 | +61.9 m | coordinate — 58% of the gap |
| `tarana_fish_river` | 953.8 | 866.3 | +49.2 m | coordinate — 56% of the gap |
| `corsis_al` | 140.8 | 45.4 | +14.5 m | **not** explained by the ring |

`corsis_al` is the interesting kind: 95 m apart with no high ground nearby to
account for it, so either the coordinate is somewhere else entirely or the
recorded height is wrong. A handful read the other way — modelled ground *above*
the mark — which is unusual enough that the tool says so rather than guessing.

## One caveat on the whole set

`api-elevation.fsdf.org.au` is undocumented and keyless, and above ~8 requests
in flight it answers `"No Data"` — HTTP 200 — for points it holds data for. This
run re-asked every such answer serially before believing it, which is why the
no-data count is 0 and not the ~10% a careless pass reports.
