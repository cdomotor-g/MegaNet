# The agent API — read-only station data for AI agents and scripts

MegaNet's station register can be read by programs as well as people. Point an
AI agent (Claude, ChatGPT, Gemini, Copilot, Cursor, Codex…) or a script at it and
it can pull **station-level information** — identity and location, networks and
radio, sensors and health, the Service Level Specification entry, the Bureau's
flood classes, crossings and gauge zero, AEP levels, inspection numbers and the
stations nearby — with one call per station if it wants everything.

It was built for drafting **assessment reports**, and the one-call
[station dossier](#get-apiv1stationsiddossier) is shaped for that. It is not
limited to them: what you do with the data is up to you. Report templates will
follow once example reports are provided; see
[Drafting assessment reports](#drafting-assessment-reports).

| | |
|---|---|
| REST API | `https://floodwarning.net/api/v1` |
| MCP server | `https://floodwarning.net/api/mcp` (Streamable HTTP) |
| OpenAPI document | `https://floodwarning.net/api/v1/openapi.json` |
| Sign-in or key | none — it is read-only and serves only public data |
| Rate limits | 60 requests / 60 s per client · 20 requests / 10 s per client (burst) · 240 requests / 60 s per address |
| Station ids | lowercase slugs such as `abergowrie_br_al`; a Bureau station number also works |
| Source | `worker/api.js` (the Worker), checked by `test/agent-api.mjs` |

**Use `floodwarning.net`.** The GitHub Pages copy of MegaNet
(`cdomotor-g.github.io/MegaNet`) is static files only — there is no Worker there,
so there is no API. If `floodwarning.net` answers with a Cloudflare Access login
page instead of JSON, the owner has not yet let the API past Access; see
[For the owner](#for-the-owner).

---

## What it is, and what it is not

**Read-only, by construction.** The API's only upstream request is an HTTP GET
to the database's REST interface (PostgREST), for a table or view on a fixed list
of public relations, carrying the *publishable* key — the same key, and so the
same row-level security, as a visitor to the app who has not signed in. Nothing
you send is forwarded: not your `Authorization` header, not a cookie, not a
Cloudflare Access identity. There is no write verb anywhere in it, and no
database function is called.

**Public data only.** It can read exactly what an anonymous visitor can
([`docs/access.md`](access.md), "The decision: the data stays public"). It
cannot read inspection remarks or who inspected a site (only the *numbers* a
visit recorded are public), raw ingest payloads (`reading_raw`), field photos,
or anything about users and editors.

**Not a warning service.** From [the About page](../about.html):

> MegaNet is not a flood warning service, and it does not issue warnings,
> forecasts or public alerts. It is engineering tooling for the radio networks
> that telemetry travels over — an asset register, a path planner and a
> fault-finding aid. Nothing here should be read as an official statement about
> flooding, river conditions or public safety. It is also not an official
> product of, and is not endorsed by, the Australian Bureau of Meteorology or any
> other agency. For official Australian flood warnings and river height data, go
> to [the Bureau of Meteorology](http://www.bom.gov.au/australia/flood/).

**Not a bulk export.** It answers one station, or one page of stations, at a
time — the equivalent of looking a station up in the app. Please don't walk the
whole network through it. Taking the whole network away as a file is a
signed-in action in the app (the Export tab, #191), and that stays the way to do
it.

---

## Connecting an agent (MCP)

The MCP server speaks the Model Context Protocol over **Streamable HTTP**:
JSON-RPC over `POST`, answered with JSON. It is stateless (no session id), has no
event stream (`GET` is 405), needs no authentication, and serves both MCP eras:
the `initialize` handshake of protocol versions 2025-03-26, 2025-06-18 and
2025-11-25, and the stateless per-request metadata of 2026-07-28, including
`server/discover`.

**Name your client.** Add an `X-MegaNet-Client: <your-name>` header (letters,
digits, `.`, `_`, `-`, `@`; up to 64 characters), or append `?client=<your-name>`
to the URL where a client cannot set headers. Your name and your address
together are your rate-limit bucket, so colleagues behind one office network —
or everyone using a hosted connector, which reaches us from the provider's
addresses — do not share one allowance. It is not a password and proves nothing.

### Claude Code

```sh
claude mcp add --transport http meganet https://floodwarning.net/api/mcp \
  --header "X-MegaNet-Client: your-name"
```

Add `--scope project` to write it into the repository's `.mcp.json` for everyone
working there, which looks like this:

```json
{
  "mcpServers": {
    "meganet": {
      "type": "http",
      "url": "https://floodwarning.net/api/mcp",
      "headers": { "X-MegaNet-Client": "your-name" }
    }
  }
}
```

Claude Code warns when one tool result passes 10,000 tokens; a dossier is
typically about 5,000.

### Claude Desktop and claude.ai

Settings → **Connectors** → **Add custom connector** → name it `MegaNet` and give
the URL `https://floodwarning.net/api/mcp?client=your-name`. No authentication.
Custom connectors are reached from Anthropic's servers, not your computer — which
is exactly why the `client` name matters.

### Cursor

`.cursor/mcp.json` in a project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "meganet": {
      "url": "https://floodwarning.net/api/mcp",
      "headers": { "X-MegaNet-Client": "your-name" }
    }
  }
}
```

### VS Code and GitHub Copilot

`.vscode/mcp.json` in a workspace (or **MCP: Open User Configuration** from the
Command Palette for all of them) — note the top-level key is `servers`:

```json
{
  "servers": {
    "meganet": {
      "type": "http",
      "url": "https://floodwarning.net/api/mcp",
      "headers": { "X-MegaNet-Client": "your-name" }
    }
  }
}
```

### Gemini CLI

`~/.gemini/settings.json` (or `.gemini/settings.json` in a project). `httpUrl` is
Gemini CLI's key for a Streamable HTTP server — `url` means the older SSE
transport:

```json
{
  "mcpServers": {
    "meganet": {
      "httpUrl": "https://floodwarning.net/api/mcp",
      "headers": { "X-MegaNet-Client": "your-name" }
    }
  }
}
```

or from the command line:
`gemini mcp add --transport http meganet https://floodwarning.net/api/mcp`.

### OpenAI Codex CLI

`~/.codex/config.toml`. Current Codex speaks Streamable HTTP itself, so no
bridge is needed:

```toml
[mcp_servers.meganet]
url = "https://floodwarning.net/api/mcp"
http_headers = { "X-MegaNet-Client" = "your-name" }
```

An older Codex that only runs stdio servers can reach it through a bridge:
`command = "npx"`, `args = ["-y", "mcp-remote", "https://floodwarning.net/api/mcp?client=your-name"]`.

### ChatGPT, and any other function-calling agent

Anything that takes an OpenAPI description can use the REST API directly. For a
custom GPT: **Configure** → **Create new action** → **Import from URL** →
`https://floodwarning.net/api/v1/openapi.json`, authentication **None**. The
document is OpenAPI 3.1, every operation has an `operationId`, and descriptions
stay inside GPT Actions' length limits. The same document serves Gemini
function calling, LangChain/LlamaIndex OpenAPI toolkits and the like. Clients
that accept a remote MCP server URL can use the MCP server instead.

### Plain HTTP

```sh
curl -s -H 'X-MegaNet-Client: your-name' \
  'https://floodwarning.net/api/v1/stations?q=abergowrie' | jq '.stations[].id'
```

---

## The MCP tools

Every tool is read-only (annotated `readOnlyHint: true`), and each is a thin
adapter over a REST endpoint — same data, same limits, same cache. A tool answers
with the JSON as text **and** as `structuredContent`. A bad argument, an unknown
station or a failed database read is a tool error (`isError: true`) whose text
says what to change; an unknown tool or malformed request is a JSON-RPC error.

| Tool | What it answers | REST equivalent |
|---|---|---|
| `search_stations` | Find stations by name, Bureau/AWRC number or ALERT address; filter by catchment, basin, LGA, hub, network, role, kind, SLS gauge type | `GET /api/v1/stations` |
| `stations_near` | Stations within a radius of a point, nearest first, with distance and bearing | `GET /api/v1/stations?near=` |
| `get_station` | One station's full register record, SLS rows and health | `GET /api/v1/stations/{id}` |
| `get_station_dossier` | Everything a report needs about one station, in one call | `GET /api/v1/stations/{id}/dossier` |
| `get_readings` | Telemetry ingested into MegaNet: raw, hourly or daily | `GET /api/v1/stations/{id}/readings` |
| `get_flood_levels` | Flood classes, SLS classes, crossings, gauge zero, flood effects, AEP levels, one AHD ladder | `GET /api/v1/stations/{id}/flood-levels` |
| `get_service_level` | The station's Service Level Specification entry | `GET /api/v1/stations/{id}/service-level` |
| `list_catchments` | The 77 Queensland drainage basins | `GET /api/v1/catchments` |
| `get_catchment` | One basin and a page of its stations | `GET /api/v1/catchments/{id}` |
| `list_networks` | Radio networks, maintenance hubs, Radio Mobile systems | `GET /api/v1/networks` |

The server's `instructions` (sent at `initialize` and `server/discover`) tell an
agent what MegaNet is, how to find a station, the datum caveats and the limits.

---

## The REST endpoints

All `GET` (and `HEAD`), all JSON, CORS open (`Access-Control-Allow-Origin: *`).
A successful answer is cached for 60 seconds at Cloudflare's edge and carries an
`ETag` (send it back as `If-None-Match` for a `304`). An unknown query parameter
is refused with a 400 that lists the accepted ones, rather than silently ignored.

Errors have one shape — `{ "error": "…", "detail": "…" }`, plus `retry_after` on
a 429 and `candidates` where there is something to suggest:

| Status | Meaning |
|---|---|
| 400 | a parameter is missing, malformed or out of range — `detail` says which |
| 404 | no such station, catchment or endpoint |
| 405 | not `GET`/`HEAD`: the API is read-only |
| 429 | rate limited — wait `Retry-After` seconds ([Limits](#limits-and-fair-use)) |
| 502 / 503 / 504 | the database was unreachable, answered with an error, or took over 10 s. The usual cause is the free-tier database pausing after 7 days idle; `detail` says so |

Numbers in the examples below are MegaNet's real data for Abergowrie Bridge AL,
trimmed; readings and health are illustrative.

### `GET /api/v1/`

The index: version, endpoints, limits, and links to this page, the OpenAPI
document and the MCP server.

```sh
curl -s https://floodwarning.net/api/v1/
```

```json
{
  "name": "MegaNet station API",
  "version": "1.0.0",
  "read_only": true,
  "endpoints": [{ "method": "GET", "path": "/api/v1/stations", "summary": "Search and filter stations; compact rows." }, "…"],
  "mcp": { "url": "https://floodwarning.net/api/mcp", "transport": "Streamable HTTP (POST, JSON responses)",
           "protocol_versions": ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] },
  "openapi": "https://floodwarning.net/api/v1/openapi.json",
  "limits": { "rate": ["60 requests / 60 s per client", "20 requests / 10 s per client (burst)", "240 requests / 60 s per address"], "list_max": 100 },
  "disclaimer": "MegaNet is not a flood warning service, …"
}
```

### `GET /api/v1/openapi.json`

The whole API as an OpenAPI 3.1 document, for ChatGPT Actions and other
function-calling agents.

```sh
curl -s https://floodwarning.net/api/v1/openapi.json | jq '.paths | keys'
```

### `GET /api/v1/stations`

Search and filter; compact rows, 25 per page by default (at most 100), with a
`next` link while there are more.

| Parameter | Meaning |
|---|---|
| `q` | name words, a Bureau station number (zero-padded or not), an AWRC number or an ALERT address; ranked by relevance. 2–100 characters (a number may be shorter) |
| `near` | `lat,lon` in decimal degrees: sorted by great-circle distance, rows carry `distance_km`, `bearing_deg` and `direction` |
| `radius_km` | with `near`: 0.01–250, default 25 |
| `catchment` | a Queensland drainage basin, by id (`herbert`) or name (`Herbert`) |
| `basin` | words in the Bureau's basin name for the station (`Burdekin`) |
| `lga` | words in the local government area (`Townsville`) |
| `hub` | a maintenance hub id (`cairns`) — see `/api/v1/networks` |
| `network` | a radio network id — see `/api/v1/networks` |
| `role` | `field`, `repeater` or `base` |
| `type` | `rain`, `river`, `repeater` or `base` (see `kinds` below) |
| `manual` | `true`: the SLS lists it as Manual; `false`: as Automatic. Stations the SLS does not list match neither |
| `limit`, `offset` | paging; a `limit` over 100 is clamped to 100, with a note |

```sh
curl -s 'https://floodwarning.net/api/v1/stations?near=-18.51,146.0&radius_km=10&type=river'
```

```json
{
  "count": 4, "total": 4, "total_exact": true, "limit": 25, "offset": 0, "next": null,
  "query": { "near": "-18.51,146", "radius_km": 10, "type": "river", "limit": 25, "offset": 0 },
  "stations": [
    {
      "id": "abergowrie_br_al",
      "name": "Abergowrie Bridge AL",
      "station_number": "532028",
      "lat": -18.5144, "lon": 146.0006,
      "elevation_ahd_m": 34.5, "elevation_source": "surveyed",
      "roles": ["field"], "kinds": ["rain", "river"],
      "catchments": [{ "id": "herbert", "name": "Herbert" }],
      "basin": "Herbert River", "stream": "HERBERT RIVER", "lga": "Hinchinbrook Shire", "hub_id": "cairns",
      "radio_network_ids": [], "awrc_number": "116914", "enabled": true,
      "telemetry": { "alert_ids": { "rainfall": 6039 }, "sensor_types": ["Rainfall", "Rainfall Increment", "Water Level", "Battery"],
                     "satcom": false, "last_seen_at": null, "last_reading_at": null },
      "sls": { "gauge_type": "Automatic", "data_type": "Rainfall/River", "priority": "High", "owner": "Hinchinbrook Shire Council" },
      "has": { "flood_classes": true, "aep_levels": true, "crossings": true, "gauge_survey": true, "flood_effects": true, "sls": true },
      "distance_km": 0.49, "bearing_deg": 173, "direction": "S"
    },
    { "id": "elphinstone_pkt", "name": "Elphinstone Pkt", "kinds": ["river"], "distance_km": 1.26, "bearing_deg": 22, "direction": "NNE", "…": "…" },
    "… abergowrie_al (7.11 km), abergowrie_tm (7.11 km)"
  ],
  "notes": ["Sorted by great-circle distance from -18.51,146; radius 10 km."]
}
```

`kinds` comes from the station's own record — `rain` for a rainfall ALERT address
or a *Rain Gauge* location type; `river` for a water-level ALERT address, a
water-level/tide/reservoir location type, or a stream on the Bureau's river
height list; `repeater`/`base` from its roles — and is exactly what `type=`
filters on. ARRO sensor types are listed separately as
`telemetry.sensor_types`. `has` says which flood-level records exist, so an agent
knows which stations are worth a dossier.

### `GET /api/v1/stations/{id}`

One station's full register record (the `stations.json` fragment: sensors, ALERT
addresses, satcom, repeater and pass ranges, Bureau lists, AEP levels,
frequencies…), its Service Level Specification rows and its latest health row.

```sh
curl -s https://floodwarning.net/api/v1/stations/abergowrie_br_al | jq '.station.sensors'
```

```json
{
  "id": "abergowrie_br_al",
  "updated_at": "2026-09-26T04:00:00+00:00",
  "station": { "id": "abergowrie_br_al", "name": "Abergowrie Bridge AL", "station_number": "532028", "lat": -18.5144, "…": "…" },
  "sls": [{ "bureau_number": "532028", "gauge_type": "Automatic", "priority": "High", "…": "…" }],
  "health": null,
  "links": { "dossier": "https://floodwarning.net/api/v1/stations/abergowrie_br_al/dossier", "…": "…" }
}
```

An all-digit id that names no station is tried as a Bureau number:
`/api/v1/stations/532028` answers for `abergowrie_br_al`, with
`"resolved_from": "station number 532028"`.

### `GET /api/v1/stations/{id}/dossier`

Everything a report drafter needs about one station, in one call. Every section
has a `status` — `ok`, `not recorded` (there is nothing, with a `detail` saying
so) or `unavailable` (the read failed; try again) — and a `source`. A section is
never silently missing, and "not recorded" never means zero.

| Section | What is in it |
|---|---|
| `summary` | a few plain sentences built from the sections below |
| `identity` | name, Bureau/AWRC numbers, URBS label, ARRO site, owner, roles, kinds, location types |
| `location` | lat/lon, height in m AHD **and where it came from** (surveyed, or modelled from a DEM via Elvis), LGA, basin, stream, catchment (with drainage division), maintenance hub |
| `networks_and_radio` | radio networks, Radio Mobile system, ALERT/ALERT2 addresses, satcom, repeater record, frequencies, the repeaters whose pass ranges cover its addresses, saved modelled link margins |
| `telemetry` | sensors, health (when MegaNet last heard from it), a per-channel summary of the last 30 days of daily rollups |
| `service_level` | the SLS entry: gauge type, data type, priority, owner, schedules, flood classes, prediction, and the edition |
| `bureau_listings` | which of the Bureau's Queensland station indexes list it (FloodWarn rainfall, daily rainfall, river height) |
| `flood_levels` | as [`/flood-levels`](#get-apiv1stationsidflood-levels) |
| `inspections` | how many visits, first and last, and the numbers the last three recorded (battery and solar volts, SWR, RSSI, fade margins, gas) |
| `nearby_stations` | the five nearest live stations: distance, bearing, kinds |
| `sources`, `links`, `disclaimer`, `generated_at` | provenance and where to go next |

```sh
curl -s https://floodwarning.net/api/v1/stations/abergowrie_br_al/dossier | jq '.summary'
```

```json
[
  "Abergowrie Bridge AL (Bureau number 532028) is a rain and river station in the Herbert catchment, Hinchinbrook Shire, maintained from the Cairns Hub.",
  "Ground height 34.5 m AHD (surveyed).",
  "Service Level Specification: gauge type Automatic, data type Rainfall/River, priority High, owner Hinchinbrook Shire Council.",
  "Flood classes (2026-09-25): minor 6 m, moderate 10 m, major 14 m on the gauge.",
  "Modelled 1% AEP level 38.45 m AHD (indicative, confidence 2 of 9)."
]
```

A dossier makes up to about twenty small database reads, a few at a time; it is
typically 15–20 KB.

### `GET /api/v1/stations/{id}/readings`

Telemetry **ingested into MegaNet** for one station (see the caveat under
[Data provenance](#data-provenance-and-caveats) — most stations report through
the Bureau's systems, and an empty answer is normal).

| Parameter | Meaning |
|---|---|
| `resolution` | `raw`, `hourly` (default) or `daily` |
| `from`, `to` | ISO 8601 dates or date-times; no zone means UTC. Default: `to` is now, `from` is 1 day (raw), 7 days (hourly) or 90 days (daily) before |
| `channel` | one channel: an ALERT address (`6039` or `a:6039`), a satellite/cellular address (`s:<number>/<channel>`), or a sensor type (`Water Level`) |
| `limit`, `offset` | at most 5,000 rows per call (default 1,000); follow `next` |

Windows are capped: **raw ≤ 7 days, hourly ≤ 31 days, daily ≤ 731 days**; a
longer one is a 400 pointing at the coarser resolution. Raw readings are kept 90
days; the hourly and daily rollups indefinitely. Daily buckets are UTC dates.

```sh
curl -s 'https://floodwarning.net/api/v1/stations/abergowrie_br_al/readings?resolution=hourly&channel=6039&limit=2'
```

```json
{
  "id": "abergowrie_br_al", "resolution": "hourly",
  "from": "2026-09-21T02:08:20.390Z", "to": "2026-09-28T02:08:20.390Z",
  "count": 2, "total": 168, "limit": 2, "offset": 0,
  "next": "https://floodwarning.net/api/v1/stations/abergowrie_br_al/readings?resolution=hourly&channel=6039&limit=2&from=…&to=…&offset=2",
  "channels": { "a:6039": { "sensor_types": ["Water Level"], "alert_id": 6039 } },
  "rows": [
    { "t": "2026-09-21T03:00:00.000Z", "addr": "a:6039", "n": 4, "raw_min": 1000, "raw_max": 1010, "raw_mean": 1005, "raw_last": 1010,
      "first_ts": "2026-09-21T03:00:00.000Z", "last_ts": "2026-09-21T03:45:00.000Z" }
  ],
  "source": "meganet.reading_hourly"
}
```

### `GET /api/v1/stations/{id}/flood-levels`

A station's flood heights with their datum caveats: the Bureau's flood classes
by edition (the newest is `current`), the SLS's classes, crossings (with the
crossing legend's words), the gauge zero in force and its datum, flood effects,
the modelled AEP levels, and one **ladder in m AHD** — classes converted with
the gauge zero where it is in AHD, AEP levels as modelled, lowest first.

```sh
curl -s https://floodwarning.net/api/v1/stations/abergowrie_br_al/flood-levels | jq '.ladder_m_ahd'
```

```json
{
  "status": "ok",
  "levels": [
    { "level": "Minor flood class", "m_ahd": 17.01, "m_on_gauge": 6, "source": "Bureau station lists" },
    { "level": "Moderate flood class", "m_ahd": 21.01, "m_on_gauge": 10, "source": "Bureau station lists" },
    { "level": "Major flood class", "m_ahd": 25.01, "m_on_gauge": 14, "source": "Bureau station lists" },
    { "level": "1% AEP (1 in 100)", "m_ahd": 38.45, "m_on_gauge": 27.44, "source": "AEP sheet (modelled)" }
  ],
  "note": "Flood classes converted with the AHD gauge zero in force; AEP levels as modelled. The AEP sheet puts the ground at its point at 33.5 m AHD, 22.49 m above the gauge zero (11.01 m AHD): its levels may not describe the water at the gauge. Compare the two sets with care."
}
```

That note is the kind of thing to carry into a report rather than smooth over.

### `GET /api/v1/stations/{id}/service-level`

The station's entry in the Queensland **Service Level Specification** (the six
station schedules merged per Bureau number), with the edition it was read from.

```json
{
  "id": "abergowrie_br_al",
  "service_level": {
    "status": "ok",
    "edition": { "title": "Service Level Specification for Flood Forecasting and Warning Services for Queensland – Version 3.7", "version": "3.7",
                 "current_edition_url": "https://www.bom.gov.au/qld/flood/brochures/QLD_SLS_current.pdf" },
    "entries": [{
      "bureau_number": "532028", "name": "ABERGOWRIE BRIDGE", "owner": "Hinchinbrook Shire Council",
      "gauge_type": "Automatic", "data_type": "Rainfall/River", "priority": "High", "schedules": [2, 8],
      "roles": ["forecast location (Schedule 2)", "Bureau assists (Schedule 8)"],
      "flood_classes_m_on_gauge": { "minor": 6, "moderate": 10, "major": 14 },
      "prediction": { "type": "Qualitative", "lead_time": "6 hours", "lead_time_hours": 6, "trigger_height": "Moderate", "peak_accuracy": "N/A" }
    }]
  }
}
```

### `GET /api/v1/catchments`

The 77 Queensland drainage basins: id, name, basin number, area, region and
drainage division.

```json
{ "count": 77, "catchments": [{ "id": "herbert", "name": "Herbert", "basin_no": "116", "area_sqkm": 9874.3,
  "region": "Far North", "division": "North East Coast", "division_no": "I" }, "…"] }
```

### `GET /api/v1/catchments/{id}`

One basin (by id or name) and a page of its stations, as compact rows; takes
`limit` and `offset`.

```sh
curl -s 'https://floodwarning.net/api/v1/catchments/herbert?limit=5' | jq '{total, ids: [.stations[].id]}'
```

### `GET /api/v1/networks`

The radio networks, the Bureau's maintenance hubs and the Radio Mobile system
presets — the ids that `network=` and `hub=` take.

```json
{ "radio_networks": [{ "id": "barcaldine", "name": "Barcaldine", "description": "" }, "…"],
  "hubs": [{ "id": "cairns", "name": "Cairns Hub", "area_sqkm": 810379.67 }, "…"],
  "rm_systems": [{ "id": 1, "name": "Field Station 1W", "tx_power_w": 1, "antenna_gain_dbi": 5.15, "…": "…" }] }
```

---

## Limits and fair use

The API is throttled so that one runaway agent cannot lock the database up for
everyone else — the app itself reads the same database.

| Rule | Limit | Keyed on |
|---|---|---|
| per client | 60 requests / 60 s | your address + your `X-MegaNet-Client` name |
| burst | 20 requests / 10 s | the same |
| per address | 240 requests / 60 s | your address alone, whatever names it uses |

Every REST request counts once; every JSON-RPC message counts once (a batch of
ten is ten). Past a limit you get **429** with a `Retry-After` header and
`{ "error": "rate limited", "detail": "…", "retry_after": N }`; over MCP the same
429 carries a JSON-RPC error with code `-32000` and `data.retry_after`. Wait that
many seconds and carry on. The `X-RateLimit-Policy` header states the rules, and
`X-RateLimit-Limiter` says which limiter answered (`cloudflare`, or `isolate` for
the per-instance fallback).

The limiter is Cloudflare's rate limiting binding: counted per Cloudflare
location and eventually consistent — a brake, not an exact quota.

Other caps: 100 rows per page; a 250 km search radius; 5,000 readings per call;
reading windows of 7 / 31 / 731 days (raw / hourly / daily); at most 5,000
stations considered by one filtered search before paging; 32 database reads per
request, six at a time, each with a 10-second timeout; MCP bodies up to 64 KB and
batches of up to 10.

**Fair use.** Cache what you fetch — a station's register record changes rarely,
and identical questions within a minute are answered from the edge cache anyway.
Ask about the stations you need rather than walking the whole network. Give your
client a name. The database is on a free tier whose outbound transfer is shared
with everyone using the app.

---

## Data provenance and caveats

Every answer names the relation it came from. What to keep in mind when you
quote it:

- **Heights on the gauge vs AHD.** Flood classes, crossing heights and flood
  effects are metres *on the station's gauge* (above its zero). AEP levels are
  metres **AHD**. The two are joined only through the **gauge zero in force**,
  and only where that zero was surveyed in AHD — a zero on an assumed, State or
  unknown datum cannot be put on the ground, and the API says so rather than
  convert.
- **AEP levels are indicative.** They are modelled water levels from the QLD and
  NSW AEP level workbooks, at the sheet's own point (sometimes not where MegaNet
  puts the station — `point_offset_km` says how far), with the sheet's
  confidence score (1–9, higher is better). Not observations.
- **Two sets of flood classes.** The Bureau's river height station lists and the
  Service Level Specification each give classes; they can differ. Both are
  given, each with its edition (`as_at` for the lists; the SLS's version).
- **Manual vs telemetered.** The SLS's `gauge_type` is its own word: *Manual*
  (read by an observer) or *Automatic* (telemetered). A station's ALERT
  addresses, ARRO sensors and satcom flag are the register's telemetry evidence.
- **Elevation.** `elevation_source` is `surveyed`, or `modelled — Elvis …` for a
  height taken from a digital elevation model through Geoscience Australia's
  Elvis. A modelled height is not a survey mark.
- **Health and readings are MegaNet's own ingest.** `health` is when MegaNet's
  MQTT bridge or HTTP ingest last heard from the station; readings are what
  reached that ingest. Most stations report through the Bureau's systems, so
  "not recorded" here says nothing about whether a station works.
- **Inspections are numbers only.** Remarks, who inspected and any free text
  are not public.
- **`not recorded` is not zero**, and **`unavailable`** means a read failed —
  ask again.
- **Kinds are derived.** `rain`/`river` come from the record's ALERT addresses,
  location types and the Bureau's river height list; see
  [`/api/v1/stations`](#get-apiv1stations).

---

## Drafting assessment reports

The dossier is the starting point: one call per station gives an agent the
identity, location, network, telemetry, service level, flood heights,
inspection history and neighbours, each labelled with its source, plus a
`summary` of plain sentences to build from. A prompt that works:

> Using the MegaNet MCP server, get the dossier for station `<id or Bureau
> number>`. Draft the station-level sections of an assessment report from it:
> location and catchment, network and telemetry, service level, flood levels
> (state each height's datum and source, and carry over any caveat the data
> gives), inspection history and nearby stations. Where a section is "not
> recorded", say so. Do not add facts that are not in the dossier.

For a catchment's worth of stations, `search_stations` with `catchment=` (or
`get_catchment`) lists them; fetch dossiers for the ones that matter rather than
all of them.

**Templates.** Example assessment reports have not been provided yet. When they
are, report templates and a matching drafting guide will be added here, and the
dossier will be extended with anything the templates need that it lacks.

---

## For the owner

### Let agents past Cloudflare Access

If `floodwarning.net` sits behind Cloudflare Access, every request without an
Access session — which is every agent — gets the Access login page instead of
the API. Access evaluates the **most specific application path first**, so a
second, narrower application with a **Bypass** policy opens the API paths and
leaves the rest of the site exactly as protected as it is.

In the Cloudflare dashboard:

1. **Zero Trust** → **Access controls** → **Applications** (on older dashboards,
   **Access** → **Applications**).
2. **Add an application** → **Self-hosted**.
3. **Application name:** `MegaNet public API`.
4. **Add public hostname:** domain `floodwarning.net`, path `api/v1`.
5. **Add public hostname** again: domain `floodwarning.net`, path `api/mcp`.
6. *(Optional)* once more for path `llms.txt`, so agents can read the index file
   at the root, and for `docs/agent-api.md` if you want this page readable too
   (it is also on GitHub).
7. Next, to **Access policies** → **Create new policy**: name
   `Public API — bypass`, **Action: Bypass**, **Include → Everyone**. Save it and
   make sure it is the application's only policy.
8. Save the application. It applies on the next request — no deploy.

Check it from anywhere:

```sh
curl -s https://floodwarning.net/api/v1/ | head -c 120      # JSON, not an HTML login page
curl -s -X POST https://floodwarning.net/api/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'            # {"jsonrpc":"2.0","id":1,"result":{…}}
```

Bypass switches Access off for those paths entirely, and Access does not log
bypassed requests — which is why the API is read-only public data and is rate
limited in the Worker. If you would rather admit only named agents, use
**Action: Service Auth** instead and issue **service tokens** (Zero Trust →
Access controls → Service credentials → **Service Tokens**; on older dashboards
Access → Service Auth); each agent then
sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers, which every
MCP client above can set the same way it sets `X-MegaNet-Client`.

The API is also on `meganet.<account>.workers.dev` if that is enabled (Access
does not cover it; the same limits apply). GitHub Pages has no API.

### Check which limiter is running

After the first deploy, the Workers Builds log lists the bindings:
`env.API_RATE_LIMIT (60 requests/60s)`, `env.API_BURST_LIMIT (20 requests/10s)`,
`env.API_IP_LIMIT (240 requests/60s)`. Then:

```sh
curl -sI https://floodwarning.net/api/v1/ | grep -i x-ratelimit-limiter
```

`cloudflare` means the binding answered. `isolate` means it is missing — a
wrangler older than 4.36 drops the `[[ratelimits]]` section with a warning
("Unexpected fields found in top-level field: ratelimits") and deploys without
it; the per-instance fallback still limits, but each Worker instance counts
separately.

### Change the limits

The numbers live in two places that must agree: `[[ratelimits]]` in
`wrangler.toml` (`limit`; `period` may only be 10 or 60) and `RATE_LIMITS` in
`worker/api.js`. They are also quoted in this page and the agent instruction
files (`AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `llms.txt`,
`.cursor/rules/meganet-api.mdc`); `npm run agentdocs` (`test/agent-docs.mjs`)
fails until every one of them says the same thing. Edit, run
`cd test && npm run agentapi && npm run agentdocs`, push — Workers Builds deploys
it.

### Stop a flood before it reaches the Worker (optional)

The binding runs *inside* the Worker, so it protects the database and its
transfer allowance, but every request still counts against the Workers plan's
daily request allowance — the same allowance `/api/db` (the app's database path)
needs. A Cloudflare **WAF rate limiting rule** runs before the Worker. The Free
plan has one rule, counted per IP over 10 seconds:

1. Select the `floodwarning.net` zone → **Security** → **Security rules**
   (older dashboards: **Security** → **WAF** → **Rate limiting rules**).
2. **Create rule** → **Rate limiting rule**, name `API flood brake`.
3. **When incoming requests match…** → **Edit expression**:
   `(starts_with(http.request.uri.path, "/api/v1") or starts_with(http.request.uri.path, "/api/mcp"))`
4. **With the same characteristics:** IP. **When rate exceeds:** 50 requests per
   10 seconds.
5. **Then take action:** Block, for 10 seconds. Deploy.

Keep `/api/db` out of the expression: the app pages through the database there
and would trip a rule meant for agents.

### Switch it off

Remove the line `if (isApiPath(url.pathname)) return handleApi(request, env, ctx);`
from `worker/index.js` and push; both paths then answer 404. Or, without a
deploy, change the Access application above to **Action: Block**.

---

## References

What this page and `worker/api.js` rely on, as read in September 2026:

- Model Context Protocol — [Streamable HTTP, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
  [changes in 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/changelog),
  [changes in 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
  [Streamable HTTP, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
  [versioning and dual-era compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
  [server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover),
  [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
- Cloudflare — [rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
  [Access policies (Bypass, Service Auth)](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/),
  [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths),
  [WAF rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/).
- Clients — [Claude Code MCP](https://code.claude.com/docs/en/mcp),
  [Cursor MCP](https://cursor.com/docs/context/mcp),
  [VS Code MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers),
  [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/),
  [Codex MCP](https://developers.openai.com/codex/mcp),
  [GPT Actions production notes](https://developers.openai.com/api/docs/actions/production),
  [llms.txt](https://llmstxt.org/).
