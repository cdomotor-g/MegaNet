# Archive

Files kept for reference but **not used by the live app** (`../index.html`).
Nothing here is fetched or linked by `app.js` / `maps-data.js`. Safe to delete
if you never need the originals; kept here to avoid losing history.

## Superseded HTML / JS

These were the separately-evolved tools that the single-page app in the repo
root now replaces (see `../README.md`).

| File | Why archived |
|------|--------------|
| `prototype_index.html` | Original CSV-driven prototype. Expects the old `app.js`; incompatible with the current tabbed app. |
| `BitFlipper.html` | Standalone ALERT bit-flip tool. Now the **Bit Flipper** tab in `app.js`. |
| `BitFlipper2.2 (1).html` | 895 KB standalone backup of the BitFlipper with data embedded. |
| `image_bitflipper.svg` | Background image used only by `BitFlipper.html`. |
| `app_updated.js` | Unrelated flood decision-tree tool. |
| `app_updated (1).js` | Old variant of `app.js`. |

## Redundant data

| File | Why archived |
|------|--------------|
| `z_Sensors_with_Database_IDs_by_View_NATIONAL.csv` | 847 KB national sensor export. Its records are now baked into `stations.json` (`site` / `sensors`), so it is redundant (per `../README.md`). |
| `fred_sites_newfile.csv` | Not referenced anywhere in the code or data. |
| `QldBasin_2009Nov_reduced.txt`, `Qld Major Streams_reduced.txt`, `queensland-outline.txt` | Byte-for-byte duplicates of the matching `.svg` files now in `../assets/geo/`. |

## Original source documents

Editable / email originals of maps that already exist as finished PDFs in
`../maps/` (so these are not needed to view the maps).

| File | Why archived |
|------|--------------|
| `Path Maps of SWRED locations.msg`, `SWRED Western Maps.msg` | Outlook message files the path-map PDFs came from. |
| `NSW North Coast_repeaters.pptx`, `NSW_North Coast_repeaters .docx` | PowerPoint / Word sources for the NSW repeater PDFs (`../maps/nsw-border/`). |

## Source documents the app's data is read from

Unlike everything above, these are read by a tool in `../tools/` — keep them
byte-for-byte, trailing spaces and tabs included, because the reader works by
column position.

| File | What reads it |
|------|---------------|
| `river-height-stations/section-4-flood-classifications-2026-09-25.txt`, `section-4b-flood-classifications-2014-01-15.txt`, `section-5-crossings-2026-09-25.txt`, `section-6-survey-details-2026-09-25.txt` | The Bureau's *Queensland Flood Warning River Height Stations*, Sections 4, 4 (B), 5 and 6, as printed. `tools/ingest/river_height_stations.py` reads them into `../data/river-height-stations.json` and the station records (`db/migrations/0031_river_height_details.sql`). |
| `river-height-stations/section-1-floodwarn-rainfall-stations-2026-09-25.txt`, `section-2-daily-rainfall-stations-2026-09-26.txt`, `section-3-river-height-stations-2026-09-26.txt`, `section-9-flood-effects-2026-09-26.html`, `urbs-details-2026-09-26.txt` | The same lists' indexes of FloodWarn rainfall, daily rainfall and river height stations (Sections 1–3), their flood effects (Section 9, an HTML page as the Bureau's system serves it) and the URBS details, byte for byte as received. The same tool reads them; the indexes are where the 1,697 stations MegaNet did not have came from (`db/migrations/0032_bureau_station_lists.sql`). |
