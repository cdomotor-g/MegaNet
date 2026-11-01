# The agent API — read-only station data for AI agents and scripts

Flood-Net's station register can be read by programs as well as people. Point an
AI agent (Claude, ChatGPT, Gemini, Copilot, Cursor, Codex…) or a script at it and
it can pull **station-level information** — identity and location, networks and
radio, sensors and health, the Service Level Specification entry, the Bureau's
flood classes, crossings and gauge zero, AEP levels, inspection numbers and the
stations nearby — with one call per station if it wants everything. It can also
ask what every gauge reporting into Flood-Net is saying now, in one call
([latest readings](#get-apiv1readingslatest)), what Station Health says about a
station — its findings and what to do about them, its check schedule day by
day, its battery's night lows ([station health](#get-apiv1stationsidhealth)) —
or about a field team's whole run of stations at once
([health findings](#get-apiv1healthfindings)), have any list of stations as
[GeoJSON for a map](#geojson-for-a-map), ask which radio licences the ACMA's
register has at a station's site — or at a point where one might go
([ACMA licences](#get-apiv1stationsidacma)) — and follow a station's readings
to a base station, hop by hop, with the fade margin Flood-Net saved for each
hop and whether it still holds ([radio path](#get-apiv1stationsidradio-path)).

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

**Use `floodwarning.net`.** The GitHub Pages copy of Flood-Net
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
database function is called. Besides the database it reads public files this
site already serves to anybody — the ACMA register extract the map draws
(`data/acma-licensing.json`) and this API's own list of changes
(`docs/api-changelog.json`) — through the Worker's static-assets binding, by a
GET of a fixed path: still read-only, and still nothing that is not public.
The [notify list](#changes) that emails each change is a separate route
(`/api/notify`), outside the API, and keeps its addresses privately.

**Public data only.** It can read exactly what an anonymous visitor can
([`docs/access.md`](access.md), "The decision: the data stays public"). It
cannot read inspection remarks or who inspected a site (only the *numbers* a
visit recorded are public), raw ingest payloads (`reading_raw`), field photos,
or anything about users and editors.

**Not a warning service.** From [the About page](../about.html):

> Flood-Net is not a flood warning service, and it does not issue warnings,
> forecasts or public alerts. It is engineering tooling for the radio networks
> that telemetry travels over — an asset register, a path planner and a
> fault-finding aid. Nothing here should be read as an official statement about
> flooding, river conditions or public safety. It is also not an official
> product of, and is not endorsed by, the Australian Bureau of Meteorology or any
> other agency. For official Australian flood warnings and river height data, go
> to [the Bureau of Meteorology](http://www.bom.gov.au/australia/flood/).

**Not a bulk export.** It answers one station, or one page of stations, at a
time — the equivalent of looking a station up in the app. Please don't walk the
whole network through it. The [latest readings](#get-apiv1readingslatest) are
the one answer that spans the network, and they are each channel's newest
reading, not its history. Taking the whole network away as a file is a
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

**Name your client.** Add an `X-FloodNet-Client: <your-name>` header (letters,
digits, `.`, `_`, `-`, `@`; up to 64 characters), or append `?client=<your-name>`
to the URL where a client cannot set headers. Your name and your address
together are your rate-limit bucket, so colleagues behind one office network —
or everyone using a hosted connector, which reaches us from the provider's
addresses — do not share one allowance. It is not a password and proves nothing.

### Claude Code

```sh
claude mcp add --transport http floodnet https://floodwarning.net/api/mcp \
  --header "X-FloodNet-Client: your-name"
```

Add `--scope project` to write it into the repository's `.mcp.json` for everyone
working there, which looks like this:

```json
{
  "mcpServers": {
    "floodnet": {
      "type": "http",
      "url": "https://floodwarning.net/api/mcp",
      "headers": { "X-FloodNet-Client": "your-name" }
    }
  }
}
```

Claude Code warns when one tool result passes 10,000 tokens; a dossier is
typically about 5,000.

### Claude Desktop and claude.ai

Settings → **Connectors** → **Add custom connector** → name it `Flood-Net` and give
the URL `https://floodwarning.net/api/mcp?client=your-name`. No authentication.
Custom connectors are reached from Anthropic's servers, not your computer — which
is exactly why the `client` name matters.

### Cursor

`.cursor/mcp.json` in a project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "floodnet": {
      "url": "https://floodwarning.net/api/mcp",
      "headers": { "X-FloodNet-Client": "your-name" }
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
    "floodnet": {
      "type": "http",
      "url": "https://floodwarning.net/api/mcp",
      "headers": { "X-FloodNet-Client": "your-name" }
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
    "floodnet": {
      "httpUrl": "https://floodwarning.net/api/mcp",
      "headers": { "X-FloodNet-Client": "your-name" }
    }
  }
}
```

or from the command line:
`gemini mcp add --transport http floodnet https://floodwarning.net/api/mcp`.

### OpenAI Codex CLI

`~/.codex/config.toml`. Current Codex speaks Streamable HTTP itself, so no
bridge is needed:

```toml
[mcp_servers.floodnet]
url = "https://floodwarning.net/api/mcp"
http_headers = { "X-FloodNet-Client" = "your-name" }
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
curl -s -H 'X-FloodNet-Client: your-name' \
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
| `search_stations` | Find stations by name, Bureau/AWRC number or ALERT address; filter by catchment, basin, LGA, hub, network, role, kind, SLS gauge type; `format: "geojson"` for a map | `GET /api/v1/stations` |
| `stations_near` | Stations within a radius of a point, nearest first, with distance and bearing; `format: "geojson"` for a map | `GET /api/v1/stations?near=` |
| `get_station` | One station's full register record, SLS rows and health | `GET /api/v1/stations/{id}` |
| `get_station_dossier` | Everything a report needs about one station, in one call | `GET /api/v1/stations/{id}/dossier` |
| `get_readings` | Telemetry ingested into Flood-Net: raw, hourly or daily | `GET /api/v1/stations/{id}/readings` |
| `get_latest_readings` | What every gauge is saying now: each station's newest reading on every channel, in one call, by network, basin, kind or bounding box; `format: "geojson"` for a map | `GET /api/v1/readings/latest` |
| `get_silent_stations` | What has gone quiet: the stations silent now, worst first, with when each was last heard, and the groups that went quiet together; by network, basin, kind, bounding box or severity; `format: "geojson"` for a map | `GET /api/v1/health/silent` |
| `get_station_health` | What Station Health says about one station over 3, 7 or 14 days: its findings with what to do, its check schedule day by day, its battery's night lows and trend | `GET /api/v1/stations/{id}/health` |
| `get_health_findings` | The same for a page of stations, worst first: by owner, station ids, network, basin, kind or bounding box | `GET /api/v1/health/findings` |
| `get_flood_levels` | Flood classes, SLS classes, crossings, gauge zero, flood effects, AEP levels, one AHD ladder | `GET /api/v1/stations/{id}/flood-levels` |
| `get_service_level` | The station's Service Level Specification entry | `GET /api/v1/stations/{id}/service-level` |
| `get_acma_licences` | The ACMA licences Flood-Net records for a station, each looked up in the register; the register's licences around it (licensee, frequencies, power, distance, whether on the station's frequency); the repeaters that relay it | `GET /api/v1/stations/{id}/acma` |
| `acma_licences_near` | The register's licences around a point — for a site not built yet, or a move | `GET /api/v1/acma?near=` |
| `get_radio_path` | How a station's readings reach a base station: the repeaters that pass its addresses, the routes on along the backbone, each hop's saved fade margin and whether it is stale, the best path and its weakest hop, and the path margins measured at site visits | `GET /api/v1/stations/{id}/radio-path` |
| `list_catchments` | The 77 Queensland drainage basins | `GET /api/v1/catchments` |
| `get_catchment` | One basin and a page of its stations | `GET /api/v1/catchments/{id}` |
| `list_networks` | Radio networks, maintenance hubs, Radio Mobile systems | `GET /api/v1/networks` |

The server's `instructions` (sent at `initialize` and `server/discover`) tell an
agent what Flood-Net is, how to find a station, the datum caveats and the limits.

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
| 502 / 503 / 504 | the database was unreachable, answered with an error, or took over 10 s. The usual cause is an outage or maintenance on the database (a Supabase Pro project, so it does not pause); `detail` says which |
| 503 `not available yet` | the route reads a relation a database migration has still to create — `missing_relation` and `migration` name them. No `Retry-After`: waiting will not apply a migration |

Numbers in the examples below are Flood-Net's real data for Abergowrie Bridge AL,
trimmed; readings and health are illustrative.

### `GET /api/v1/`

The index: version, endpoints, limits, and links to this page, the OpenAPI
document, the MCP server, the [list of changes](#get-apiv1changelog) and the
sign-up for an email when the API changes.

```sh
curl -s https://floodwarning.net/api/v1/
```

```json
{
  "name": "Flood-Net station API",
  "version": "1.0.0",
  "read_only": true,
  "endpoints": [{ "method": "GET", "path": "/api/v1/stations", "summary": "Search and filter stations; compact rows." }, "…"],
  "mcp": { "url": "https://floodwarning.net/api/mcp", "transport": "Streamable HTTP (POST, JSON responses)",
           "protocol_versions": ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] },
  "openapi": "https://floodwarning.net/api/v1/openapi.json",
  "changelog": "https://floodwarning.net/api/v1/changelog",
  "notify": { "sign_up": "https://floodwarning.net/api#notify", "what": "An email to you each time this API changes …" },
  "limits": { "rate": ["60 requests / 60 s per client", "20 requests / 10 s per client (burst)", "240 requests / 60 s per address"], "list_max": 100 },
  "disclaimer": "Flood-Net is not a flood warning service, …"
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
| `format` | `json` (the default) or `geojson` — see [GeoJSON, for a map](#geojson-for-a-map) |
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
      "proposed": false, "station_type": null, "proposed_year": null,
      "telemetry": { "alert_ids": { "rainfall": 6039 }, "sensor_types": ["Rainfall", "Rainfall Increment", "Water Level", "Battery"],
                     "satcom": false, "last_seen_at": null, "last_reading_at": null },
      "sls": { "gauge_type": "Automatic", "data_type": "Rainfall/River", "priority": "High", "owner": "Hinchinbrook Shire Council", "jurisdiction": "QLD" },
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

#### GeoJSON, for a map

`format=geojson` — here, with or without `near`, and on
[`/api/v1/readings/latest`](#get-apiv1readingslatest) — answers a GeoJSON
FeatureCollection ([RFC 7946](https://www.rfc-editor.org/rfc/rfc7946),
`Content-Type: application/geo+json`) in place of the JSON: one Point feature
per station, at **`[lon, lat]` — longitude first**, as GeoJSON has it (unlike
`near=lat,lon`), whose `properties` are exactly the row the JSON answer gives.
A station with no recorded position cannot be a feature: it is left out of
`features`, counted and named in `omitted_without_position`, and said in
`notes`. The paging — `count`, `total`, `next` and the rest — is the JSON
answer's (`count` includes the stations left out), `next` keeps asking for
GeoJSON, and `bbox` is the features' own. Leaflet's `L.geoJSON`, MapLibre,
QGIS and geojson.io take it as it comes.

```sh
curl -s 'https://floodwarning.net/api/v1/stations?q=tide&limit=100&format=geojson' > tide-gauges.geojson
```

```json
{
  "type": "FeatureCollection",
  "bbox": [139.17083, -27.95, 153.4325, -10.19556],
  "count": 50, "total": 50, "total_exact": true, "limit": 100, "offset": 0, "next": null,
  "query": { "q": "tide", "format": "geojson", "limit": 100, "offset": 0 },
  "omitted_without_position": { "count": 4, "ids": ["boigu_island_tide_tm", "dauan_island_tide_tm", "iama_island_tide_tm", "ugar_island_tide_tm"] },
  "features": [
    { "type": "Feature", "id": "auckland_point_tide_tm", "geometry": { "type": "Point", "coordinates": [151.25, -23.83306] },
      "properties": { "id": "auckland_point_tide_tm", "name": "Auckland Point Tide TM", "station_number": "539033",
                      "lat": -23.83306, "lon": 151.25, "kinds": ["river"], "stream": "TIDE GAUGE", "…": "…" } },
    "…"
  ],
  "notes": ["Sorted by relevance to q: …", "4 of the 50 station(s) on this page have no recorded position, so are not features: boigu_island_tide_tm, …"]
}
```

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

A **proposed** station — where one is meant to go, not yet built, and usually
with no Bureau number (0039) — carries `"proposed": true` in its record, with
`station_type` (`auto_water_level`, `auto_rain_gauge`, `manual_water_level` or
`manual_rain_gauge`) and `proposed_year`. An established station has no
`proposed` key; one that was proposed keeps its type and year. Most
established stations carry a `station_type` too, saying whether they are
manual or automatic. It comes from their sensors, the Bureau's service level
specification and its 2024 FldWarn KMZ; it is `null` where nothing says. The
compact rows of `GET /api/v1/stations` carry all three as well: `false`, the
type or `null`, and `null` on a station that never was a proposal. A dossier's
`nearby_stations` marks a proposed neighbour with `"proposed": true`. Check
them before reporting a station as one on the ground.

### `GET /api/v1/stations/{id}/dossier`

Everything a report drafter needs about one station, in one call. Every section
has a `status` — `ok`, `not recorded` (there is nothing, with a `detail` saying
so) or `unavailable` (the read failed; try again) — and a `source`. A section is
never silently missing, and "not recorded" never means zero.

| Section | What is in it |
|---|---|
| `summary` | a few plain sentences built from the sections below |
| `identity` | name, Bureau/AWRC numbers, URBS label, ARRO site, owner, roles, kinds, location types, and whether it is only **proposed** — `proposed`, `station_type`, `proposed_year` (a station planned and not yet built, which `summary` says straight after its opening line) |
| `location` | lat/lon, height in m AHD **and where it came from** (surveyed, or modelled from a DEM via Elvis), LGA, basin, stream, catchment (with drainage division), maintenance hub |
| `networks_and_radio` | radio networks, Radio Mobile system, ALERT/ALERT2 addresses, satcom, repeater record, frequencies, the repeaters whose pass ranges cover its addresses, saved modelled link margins |
| `telemetry` | sensors, health (when Flood-Net last heard from it), a per-channel summary of the last 30 days of daily rollups |
| `service_level` | the SLS entries — one per document that lists the station (Queensland's; New South Wales and the ACT's): gauge type, data type, priority, owner, schedules, flood classes, prediction, and each document's edition |
| `bureau_listings` | which of the Bureau's Queensland station indexes list it (FloodWarn rainfall, daily rainfall, river height) |
| `flood_levels` | as [`/flood-levels`](#get-apiv1stationsidflood-levels) |
| `inspections` | how many visits, first and last, and the numbers the last three recorded (battery and solar volts, SWR, RSSI, fade margins, gas) |
| `nearby_stations` | the five nearest live stations: distance, bearing, kinds, and `proposed` where one is only proposed |
| `acma` | the ACMA licences: what [`/acma`](#get-apiv1stationsidacma) answers by default — the licences recorded for it, the register's within 500 m, the repeaters that relay it |
| `radio_path` | the way its readings reach a base station: what [`/radio-path`](#get-apiv1stationsidradio-path) answers, shorter — one route per repeater, each hop in full only on the best path and the first hops, the measured margins from `inspections` |
| `sources`, `links`, `disclaimer`, `generated_at` | provenance and where to go next |

```sh
curl -s https://floodwarning.net/api/v1/stations/abergowrie_br_al/dossier | jq '.summary'
```

```json
[
  "Abergowrie Bridge AL (Bureau number 532028) is a rain and river station in the Herbert catchment, Hinchinbrook Shire, maintained from the Cairns Hub.",
  "Ground height 34.5 m AHD (surveyed).",
  "Service Level Specification (QLD v3.7): gauge type Automatic, data type Rainfall/River, priority High, owner Hinchinbrook Shire Council.",
  "Flood classes (2026-09-25): minor 6 m, moderate 10 m, major 14 m on the gauge.",
  "Modelled 1% AEP level 38.45 m AHD (indicative, confidence 2 of 9)."
]
```

A dossier makes up to about twenty small database reads, a few at a time; it is
typically 15–20 KB.

### `GET /api/v1/stations/{id}/readings`

Telemetry **ingested into Flood-Net** for one station (see the caveat under
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

A **raw** row is one reading as it was received: `t` (the device's own time),
`addr`, `value_raw` as transmitted, `value` and `unit` where Flood-Net had a
conversion, `quality`, `received_at`, the `path` it came by (which receiver),
`dup_count` (copies heard again — for an ALERT address, any copy stamped
within 8 s, since a legacy ALERT frame carries no time and each receiver
stamps it when it heard it) — and the frequency and signal the receiver
gave: `freq_mhz`, `rssi_dbm`, `level_dbfs` and `snr_db`, each only where that
receiver measures it (an SDR gives level and SNR, a radio its RSSI) and absent,
never zero, where it does not. A real row, from 27 October 2026:

```json
{ "t": "2026-10-27T08:47:03+00:00", "addr": "a:5339", "value_raw": 117, "quality": 0,
  "received_at": "2026-10-27T08:48:42.472815+00:00", "path": "serial-monitor/rpi-83071968-sdr1-151.5375",
  "freq_mhz": 151.5375, "level_dbfs": -46.4, "snr_db": 18.3 }
```

### `GET /api/v1/readings/latest`

What every gauge is saying now, in one call: each station Flood-Net holds
telemetry for, with every channel's newest reading and how old it is — where
the route above would have an agent ask station by station. The same caveat
applies: these are readings **ingested into Flood-Net**, and most stations
report through the Bureau's own systems and are simply not in the answer,
which says nothing about whether they work.

| Parameter | Meaning |
|---|---|
| `network` | a radio network id — see `/api/v1/networks` |
| `basin` | words in the Bureau's basin name for the station (`Burdekin`) |
| `type` | `rain`, `river`, `repeater` or `base` — the same rule as [`/api/v1/stations`](#get-apiv1stations) |
| `bbox` | a box, `west,south,east,north` in decimal degrees — **longitude first**, as GeoJSON and map tools have it (`152.5,-28.2,153.6,-27.0`); one written latitude-first is refused rather than read as somewhere else |
| `format` | `json` (the default) or `geojson` — see [GeoJSON, for a map](#geojson-for-a-map) |
| `limit`, `offset` | 100 stations a page by default and at most 1,000 — `limit=1000` takes them all at once while no more than that report; follow `next` |

A row is a station: id, name, Bureau number, position, `kinds`, basin, stream
and radio networks; `latest_at`, the newest of its channels, and
`minutes_since_latest`; and `channels`, one per address it reported on —
`addr` (`a:<ALERT address>`, `a2:<station>/<sensor>` for ALERT2,
`s:<number>/<channel>` for satellite or cellular), the `sensor_types` the
register gives that address, `t` (the reading's own time) and `minutes_since`,
`value_raw` as transmitted, `value` and `unit` where Flood-Net had a
conversion, `quality`, `received_at`, the `path` it came by, `dup_count`, and
the frequency and signal (`freq_mhz`, `rssi_dbm`, `level_dbfs`, `snr_db`) where
the receiver gave them. Stations come in id order, so pages hold still while
readings arrive.

```sh
curl -s 'https://floodwarning.net/api/v1/readings/latest?type=river&bbox=145.5,-19,146.5,-18'
```

```json
{
  "count": 1, "total": 1, "total_exact": true, "limit": 100, "offset": 0, "next": null,
  "query": { "type": "river", "bbox": "145.5,-19,146.5,-18", "limit": 100, "offset": 0 },
  "stations": [{
    "id": "abergowrie_br_al", "name": "Abergowrie Bridge AL", "station_number": "532028",
    "lat": -18.5144, "lon": 146.0006, "kinds": ["rain", "river"], "basin": "Herbert River", "stream": "HERBERT RIVER",
    "radio_network_ids": [], "latest_at": "2026-10-07T02:15:00+00:00", "minutes_since_latest": 12,
    "channels": [
      { "addr": "a:6038", "alert_id": 6038, "sensor_types": ["Rainfall", "Rainfall Increment"],
        "t": "2026-10-07T00:45:00+00:00", "minutes_since": 102, "value_raw": 1262, "quality": 0,
        "received_at": "2026-10-07T00:45:21+00:00" },
      { "addr": "a:6039", "alert_id": 6039, "sensor_types": ["Water Level"],
        "t": "2026-10-07T02:15:00+00:00", "minutes_since": 12, "value_raw": 1010, "quality": 0,
        "received_at": "2026-10-07T02:15:20+00:00", "dup_count": 1 }
    ]
  }],
  "unattributed_addresses": 2,
  "notes": ["Telemetry ingested into Flood-Net only. …", "Each channel is its address's newest reading that meganet.reading still holds (about two years) …",
            "2 address(es) heard belong to no single live station — …"],
  "source": "meganet.reading_latest (each address's newest reading in meganet.reading); meganet.station"
}
```

- **Newest by the station's own clock.** `t` is when the device says it read,
  as everywhere in this API; `minutes_since` counts from it to now, so a
  negative one is a station whose clock runs ahead. `received_at` is when
  Flood-Net got it. Readings are kept about two years: a channel silent for longer has
  no reading here.
- **`unattributed_addresses`** counts the addresses heard that no single live
  station carries — an ALERT address more than one station uses, or a station
  not yet in the register. Their readings are in no row, rather than guessed
  into one, and the count is the whole network's whatever the filters say.
- A station with no recorded position — the workshop test rigs — is a row in
  JSON; in GeoJSON it is named in `omitted_without_position`.
- It reads `meganet.reading_latest`, one row per address (migration `0057`),
  which since `0086` is a table a trigger keeps as readings arrive — so a
  filter that leaves a few hundred stations or fewer (a box around a site, a
  network) is answered in two round trips to the database, and the whole
  network, or a page of it, in three. Until `0057` is applied to a
  database the route answers **503** `"not available yet"`, naming the
  relation and the migration (see
  [For the owner](#apply-0057-for-the-latest-readings)).

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

The station's entries in the Bureau's **Service Level Specifications** — one
per state the network reaches: Queensland's (`QLD`, version 3.7) and the one
for New South Wales and the Australian Capital Territory (`NSW`, version 3.16).
Each document's six station schedules are merged per Bureau number, and each
entry is one document's: a station on the border (47 of them) has an entry
from each, and they can disagree — GOONDIWINDI's major level is 9.2 m in
Queensland's and 8.5 m in the NSW one. Quote the one for the state whose
service a report is about, and say which. `editions` lists every document the
database holds; `edition` is the first entry's.

```json
{
  "id": "goondiwindi_tm",
  "service_level": {
    "status": "ok",
    "editions": [
      { "jurisdiction": "QLD", "place": "Queensland", "version": "3.7", "published": "December 2025",
        "title": "Service Level Specification for Flood Forecasting and Warning Services for Queensland – Version 3.7",
        "current_edition_url": "https://www.bom.gov.au/qld/flood/brochures/QLD_SLS_current.pdf" },
      { "jurisdiction": "NSW", "place": "New South Wales and the Australian Capital Territory", "version": "3.16", "published": "December 2025",
        "title": "Service Level Specification for Flood Forecasting and Warning Services for New South Wales and the Australian Capital Territory – Version 3.16",
        "current_edition_url": "https://www.bom.gov.au/nsw/NSW_SLS_Current.pdf" }
    ],
    "entries": [{
      "jurisdiction": "QLD", "edition": "3.7", "bureau_number": "041500", "name": "GOONDIWINDI", "owner": "DLGWV",
      "gauge_type": "Automatic", "priority": "High", "schedules": [2], "roles": ["forecast location (Schedule 2)"],
      "flood_classes_m_on_gauge": { "minor": 4, "moderate": 7.5, "major": 9.2 },
      "prediction": { "type": "Quantitative", "lead_time": "15 hrs", "lead_time_hours": 15, "trigger_height": "> 7.0", "peak_accuracy": "+/- 0.3m" }
    }, {
      "jurisdiction": "NSW", "edition": "3.16", "bureau_number": "041500", "name": "Goondiwindi", "owner": "DNRM",
      "gauge_type": "Automatic", "priority": "High", "schedules": [2], "roles": ["forecast location (Schedule 2)"],
      "awrc_number": "416201A", "gauge_datum": "Local",
      "flood_classes_m_on_gauge": { "minor": 4, "moderate": 6, "major": 8.5 },
      "prediction": { "type": "Quantitative", "lead_time": "15 hrs", "lead_time_hours": 15, "trigger_height": "> 6.0", "peak_accuracy": "+/- 0.3m" }
    }]
  }
}
```

Roles are labelled in each document's own numbering: the NSW document's
information locations are its Schedule 3a and its Bureau-owned sites its
Schedule 6 (Queensland's are 3 and 7). Only the NSW document gives
`awrc_number` and `gauge_datum` — where the datum is `AHD`, its flood classes
and trigger heights are metres AHD as well as on the gauge — and it can say a
class has not been defined yet (`flood_classes_not_yet_defined`, printed
`n/a`: "not yet defined by the NSW SES"), that a location is a small catchment
with a faster response (`fast_response`, its `^`), or that a service is
interim with no determined lead time (`prediction.interim_service`, its `*`).

### `GET /api/v1/stations/{id}/acma`

The radio licences at a station's site, from the ACMA's **Register of
Radiocommunications Licences** — for a scope sheet's "ACMA licence" line: the
licence number to record when the site already has one that can be reused, a
council's licence that would have to be transferred to the Bureau, or nothing,
and a new licence and a network assessment to plan. Flood-Net gives the facts;
the call is yours. Three parts:

- **`recorded`** — the licence numbers Flood-Net records for the station (its
  repeater pair's and each listed frequency's `acma_licence`), each looked up in
  the register: the register's own number for it (`register_licence` —
  Flood-Net often records `1441013` where the register says `1441013/1`, so a
  number not found whole is matched by the part before the `/`, and
  `matched_by` says which), `status`, `service`, `subservice`, `issued`,
  `expiry`, `expiry_passed`, the `licensee`, and the `sites` where the register
  puts its transmitters, nearest first. `in_register: false`, with a `detail`,
  when the extract does not have it.
- **`register`** — the register's licences at sites within `radius_m`, one row
  per licence and site. By default the ones a telemetry site's licensing is
  about, in this order, nearest first within each: the station's own
  (`recorded_by_floodnet`), those on a frequency it records
  (`matches_station_frequency`), the Bureau of Meteorology's
  (`licensee.is_bureau`), and the rest of the VHF high band, 148–174 MHz, where
  ALERT telemetry is (`vhf_high_band`). `all=true` lists every licence.
  `counts`, `licences_total` and `sites` always cover them all: `sites` gives
  each site once, with its position, its `precision`, `distance_m`, bearing,
  and how many licences it holds and how many are `listed`. With nothing that
  close, `status` is `not recorded` and `nearest_site` says where the nearest
  registered site is.
- **`relayed_by`** — for a field station, the repeaters whose pass ranges cover
  its ALERT addresses (the nearest five within 150 km — farther away, a range
  covering the address is usually another region reusing it), each with the
  frequency it receives on (`rx_mhz`, the one the field station transmits on)
  and the licences Flood-Net records for it, looked up. A field station often
  has no transmitter registered at its own site.

Also: `frequencies` (what the register is matched against — what Flood-Net
records for the station, and `freq_mhz`), `summary` (plain sentences),
`register_extract` (`source_date`, `refreshed_at`, `age_days`, and `stale`
past 14 days, with a `note`), `notes`, `sources` and `links`.

| Parameter | Meaning |
|---|---|
| `radius_m` | metres around the station, 1–5000; default 500 — the radius `tools/acma_fetch.py` matches a repeater to its licence within, which holds every licence already recorded against one (the farthest 457 m away, at a site whose stated precision is *Unknown*) and is five times the coarsest precision a site states (*Within 100 metres*) |
| `freq_mhz` | frequencies in MHz to match against besides those Flood-Net records, comma-separated, up to 8 — for a field station, its repeater's `rx_mhz` |
| `all` | `true` lists every licence within the radius; by default only the ones described above |

A row of `register.licences`:

| Field | Meaning |
|---|---|
| `licence` | the register's licence number, such as `10774614/1` |
| `status`, `expiry`, `expiry_passed` | as at the extract's `source_date`; `expiry_passed` is `true` when the expiry date has gone by since — renewed or lapsed, the extract cannot say |
| `service`, `subservice` | such as Fixed / Point to Multipoint (an ALERT network's licence), Land Mobile, Spectrum (the mobile carriers) |
| `licensee` | `name`, `trading_name`, the ACMA's client `type` (Local Government, State Government, Company…) and `is_bureau`. A licensee registered as a private individual is never named |
| `site` | `id`, `name`, `distance_m` from the station, and the `precision` the register states for the site's position (*Within 10 metres*, *Within 100 metres*, *Unknown*) |
| `frequencies_mhz`, `emissions` | its transmitters' at that site |
| `tx_power_w`, `eirp_w` | the highest of them, in watts |
| `authorised` | the earliest of their authorisation dates |
| `transmitters` | how many there are |
| `vhf_high_band` | one of them is in 148–174 MHz |
| `recorded_by_floodnet` | Flood-Net records this licence for the station |
| `matches_station_frequency`, `matched_frequencies_mhz` | one of them is on the same channel — within 6.25 kHz, `tools/acma_fetch.py`'s co-channel rule — as a frequency the station records or `freq_mhz` names; `null`, not `false`, when there was no frequency to match |

```sh
curl -s -H 'X-FloodNet-Client: your-name' \
  'https://floodwarning.net/api/v1/stations/mt_glorious_al_rptr/acma'
```

A real answer, from the extract of 23 July 2026, trimmed (`…`) — Mt Glorious
AL RPTR, Seqwater's repeater:

```json
{
  "id": "mt_glorious_al_rptr", "name": "Mt Glorious AL RPTR", "lat": -27.3151, "lon": 152.7477,
  "roles": ["field", "repeater"], "proposed": false, "query": { "radius_m": 500 },
  "summary": [
    "Flood-Net records 5 ACMA licences for Mt Glorious AL RPTR: 10774614/1 (its repeater pair, 151.525 MHz), 10774616/1 (Seqwater ALERT, 152.4625 MHz), …",
    "All 5 are in the register extract of 23 July 2026, granted, held by Seqwater, with transmitters as near as 37 m.",
    "Within 500 m, the register extract of 23 July 2026 has 83 licences at 4 sites; 7 are on a frequency Flood-Net records for the station; 15 are in the VHF high band (148–174 MHz); 11 are the Bureau of Meteorology's.",
    "…"
  ],
  "recorded": { "status": "ok", "licences": [{
    "licence": "10774614/1", "recorded_on": "repeater", "label": null, "rx_mhz": 151.525, "tx_mhz": 151.525,
    "in_register": true, "register_licence": "10774614/1", "matched_by": "number",
    "status": "Granted", "service": "Fixed", "subservice": "Point to Multipoint", "issued": "2026-03-19",
    "expiry": "2027-03-17", "expiry_passed": false,
    "licensee": { "name": "Queensland Bulk Water Supply Authority", "trading_name": "Seqwater",
                  "type": "State Government", "client_no": "1144435", "is_bureau": false },
    "sites": [{ "id": "15843", "name": "Powerlink Tower The Summit MOUNT GLORIOUS", "state": "QLD",
                "precision": "Within 10 metres", "frequencies_mhz": [151.525], "distance_m": 37 }], "sites_total": 1
  }, "…"] },
  "frequencies": { "status": "ok", "mhz": [151.425, 151.525, 151.5375, 152.25, 152.4625], "…": "…" },
  "register": {
    "status": "ok", "radius_m": 500, "site_count": 4, "licences_total": 83, "licences_listed": 26, "listing": "relevant",
    "counts": { "matching_frequency": 7, "vhf_high_band": 15, "recorded_by_floodnet": 5, "bureau": 11 },
    "sites": [{ "id": "15843", "name": "Powerlink Tower The Summit MOUNT GLORIOUS", "lat": -27.31529, "lon": 152.74801,
                "state": "QLD", "precision": "Within 10 metres", "distance_m": 37, "bearing_deg": 125, "direction": "SE",
                "licences": 31, "listed": 14 }, "…"],
    "licences": [
      { "licence": "10774614/1", "status": "Granted", "service": "Fixed", "subservice": "Point to Multipoint",
        "expiry": "2027-03-17", "expiry_passed": false,
        "licensee": { "name": "Queensland Bulk Water Supply Authority", "trading_name": "Seqwater", "type": "State Government", "is_bureau": false },
        "site": { "id": "15843", "name": "Powerlink Tower The Summit MOUNT GLORIOUS", "distance_m": 37, "precision": "Within 10 metres" },
        "frequencies_mhz": [151.525], "emissions": ["12K5F2D"], "tx_power_w": 5, "eirp_w": 14.1, "authorised": "2026-03-19",
        "transmitters": 1, "vhf_high_band": true, "recorded_by_floodnet": true,
        "matches_station_frequency": true, "matched_frequencies_mhz": [151.525] },
      { "licence": "433573/1", "status": "Granted", "service": "Fixed", "subservice": "Point to Point",
        "expiry": "2026-09-23", "expiry_passed": true,
        "licensee": { "name": "BUREAU OF METEOROLOGY", "trading_name": "Bureau of Meteorology", "type": "Other Commonwealth Agency", "is_bureau": true },
        "site": { "id": "15842", "name": "Airservices Tower The Summit MOUNT GLORIOUS", "distance_m": 41, "precision": "Within 10 metres" },
        "frequencies_mhz": [450.925], "emissions": ["16K0F2D"], "tx_power_w": 4, "eirp_w": 0, "authorised": "1991-01-11",
        "transmitters": 1, "vhf_high_band": false, "recorded_by_floodnet": false,
        "matches_station_frequency": false, "matched_frequencies_mhz": [] },
      "…"
    ]
  },
  "relayed_by": { "status": "not recorded", "detail": "The station has no ALERT addresses for a repeater to relay." },
  "register_extract": { "source_date": "2026-07-23", "refreshed_at": "2026-07-23T11:14:04Z", "age_days": 100, "stale": true, "note": "…" },
  "sources": [{ "name": "ACMA Register of Radiocommunications Licences", "licence": "CC BY 4.0", "source_date": "2026-07-23", "…": "…" }, "…"]
}
```

A field station usually has nothing registered at its own site, and then
`relayed_by` is the part to read. Fifteen Mile AL, the same day, trimmed:

```json
{
  "id": "fifteen_mile_al", "name": "Fifteen Mile AL",
  "summary": [
    "Flood-Net records no ACMA licence for Fifteen Mile AL.",
    "In the register extract of 23 July 2026 there is no transmitter within 500 m; the nearest registered site is Lookout State Forest R909 PECHEY, 7.7 km NNW.",
    "It is relayed by Toowoomba AL (17 km, receiving on 151.525 MHz, no licence recorded), Mt Glorious AL RPTR (67.27 km, receiving on 151.525 MHz, licence 10774614/1, …).",
    "…"
  ],
  "recorded": { "status": "not recorded", "licences": [], "detail": "…" },
  "frequencies": { "status": "not recorded", "mhz": [], "detail": "No frequency to match: … Pass freq_mhz to match against one …" },
  "register": { "status": "not recorded", "radius_m": 500, "site_count": 0, "licences": [],
                "counts": { "matching_frequency": null, "vhf_high_band": 0, "recorded_by_floodnet": 0, "bureau": 0 },
                "nearest_site": { "id": "14592", "name": "Lookout State Forest R909 PECHEY", "precision": "Within 100 metres",
                                  "distance_m": 7745, "direction": "NNW", "…": "…" } },
  "relayed_by": { "status": "ok", "addresses": [4043, 4044], "repeaters": [
    { "id": "toowoomba_al", "name": "Toowoomba AL", "distance_km": 17, "passes_addresses": [4043, 4044],
      "rx_mhz": 151.525, "tx_mhz": 151.525, "licences": [] },
    { "id": "mt_glorious_al_rptr", "name": "Mt Glorious AL RPTR", "distance_km": 67.27, "rx_mhz": 151.525, "licences": [
      { "licence": "10774614/1", "recorded_on": "repeater", "in_register": true, "status": "Granted",
        "subservice": "Point to Multipoint", "expiry": "2027-03-17", "expiry_passed": false,
        "licensee": { "name": "Queensland Bulk Water Supply Authority", "trading_name": "Seqwater", "type": "State Government", "is_bureau": false },
        "nearest_site": { "id": "15843", "name": "Powerlink Tower The Summit MOUNT GLORIOUS", "distance_m": 37 } }, "…"] }
  ] }
}
```

`?freq_mhz=151.525` would match the register around it against that channel.
A row's `site.distance_m` is from the station's recorded position to the
site's registered one; measure it against the site's stated `precision`
before reading two places as one.

### `GET /api/v1/acma`

The `register` part of the answer above, for a **point** — a site not built
yet, or where a station might move to. No station, so no `recorded` or
`relayed_by`; `frequencies` holds only what `freq_mhz` names.

| Parameter | Meaning |
|---|---|
| `near` | the point, `lat,lon` in decimal degrees — required |
| `radius_m` | metres around it, 1–5000; default 500 |
| `freq_mhz` | frequencies in MHz to flag the licences on, comma-separated, up to 8 |
| `all` | `true` lists every licence within the radius; by default those on `freq_mhz`, the Bureau's and the VHF high band |

```sh
curl -s 'https://floodwarning.net/api/v1/acma?near=-27.3166,152.749&radius_m=300&freq_mhz=151.525' | jq '.summary'
```

```json
[
  "Within 300 m, the register extract of 23 July 2026 has 83 licences at 4 sites; 1 is on a frequency asked about; 15 are in the VHF high band (148–174 MHz); 11 are the Bureau of Meteorology's.",
  "The 26 licences listed are held by Seqwater (State Government), Bureau of Meteorology (Other Commonwealth Agency), Philcomm Pty Ltd (Company), …",
  "The register extract is 100 days old; anything licensed or changed since 23 July 2026 is not in it."
]
```

### `GET /api/v1/stations/{id}/radio-path`

How a station's readings reach a base station, hop by hop, with the fade
margin Flood-Net saved for every hop — for a scope sheet's "Fade margin" line,
a station that has to move, or a planner looking for the weak hop. Nothing is
modelled here: every figure is one the Stations map worked out (Longley–Rice
over sampled terrain) and an editor saved, and the answer says when one no
longer holds, and why. It takes no parameters.

**The routes follow the Stations map's own rules.**

- A field station's **first hop** is a repeater whose recorded pass ranges carry
  one of its ALERT addresses (exclusions honoured) — the nearest 5 within
  150 km, the same repeaters [`/acma`](#get-apiv1stationsidacma) lists under
  `relayed_by`.
- **On from there:** a repeater within 100 km — the map's *Max TX distance*,
  where it draws backbone paths — that passes one of the same addresses, or any
  base station within 100 km, which ends the route. Every repeater on a route
  must pass some of what the one before it passed on.
- A **repeater** starts from itself, and goes on to repeaters whose pass-range
  windows take some of what it relays. A **base station** has no path on from it.
- At most 4 repeaters a route (the Repeater Delays plan's own reach), never the
  same station twice, and from each first repeater the routes through the fewest
  repeaters that reach a base and through one more. On the network of November
  2026, 975 stations reach a base through one repeater, 44 through two, 11
  through three and 3 through four. Frequencies are not matched, as the map
  does not match them; each hop says the one its figure was worked out at.

What it answers:

- **`summary`** — plain sentences: the repeaters, the best path and its weakest
  hop, what is stale and why, what is not modelled, and the measured margins.
- **`best_path`** — the best route to a base station: every hop modelled first,
  then the fewest hops not modelled, then the strongest weakest hop, then the
  fewest hops, then the shortest. `route` in words, `stations`, `base`,
  `hop_count`, `distance_km`, `complete` (every hop modelled),
  `unmodelled_hops`, `stale_hops`, `weakest_hop`, and each hop in brief.
- **`repeaters`** — for a field station, its first repeaters, nearest first:
  `distance_km`, `passes_addresses`, `rx_mhz` and `tx_mhz`, `first_hop` (in
  brief) and `to_base` — `routes_found`, `bases_reachable` (each base with
  `fewest_hops` and its distance from the repeater) and the best three
  `routes`, each from the station itself. For a repeater, one item: itself,
  with `first_hop: null`.
- **`hops`** — every hop on the routes listed, once, in full (below).
- **`measured`** — the station's last five attenuator tests from site visits,
  newest first: `this_visit_db` (after the visit's work), `original_db`
  (before it) and `this_visit_range_db`. The test adds loss at the station a
  step at a time until its reports stop reaching base, so it measures the whole
  path, station to base; a reading is a step — 24 on a 3 dB attenuator is
  24–27 dB, 19 off that grid is 19–20, and 30 is "at least 30".
- **`model`** — the model Flood-Net uses now (`current`, in words) and the ones
  the figures were saved with; `rules` (the numbers above), `notes`, `sources`
  and `links`.

A hop in `hops`:

| Field | Meaning |
|---|---|
| `from`, `to` | the two ends; `to.role` is `repeater` or `base` |
| `kind` | `field` (a field station to the repeater that carries it) or `backbone` (a repeater on to a repeater or a base) |
| `distance_km` | between the two, as the register places them now |
| `status` | `ok`, or `not modelled` — no figure is saved for the pair, and `detail` says how one is made |
| `margin_db`, `margin_back_db` | the saved fade margin the way the traffic runs (from → to), and the other way, in dB |
| `band`, `thresholds_db` | `margin_db` against the thresholds saved with it: `good` at `thresholds_db.good` (15 dB) or more, `ok` at `thresholds_db.ok` (6 dB), else `bad` |
| `freq_mhz`, `verdict` | the frequency it was worked out at; the line of sight on the same profile — `clear`, `marginal` or `obstructed` |
| `model`, `computed_at` | the model it was worked out with, and when |
| `stale`, `ends_changed`, `stale_reasons` | whether the map would not show it today; whether either end has changed since; and why, in words — `model`, `settings` (the field allowance, LiDAR ground), `moved`, `height`, `antenna`, `radio`, `frequency`, or `unreadable` |

**Stale.** A saved figure carries a signature of everything it was worked out
from — both ends' positions, ground heights, antenna heights and radio
systems, the frequency, the model and its settings — and the map shows a figure
only while the register still matches it. This builds the same signature, at
the app's default settings, and gives every figure all the same, with
`stale: true` and the reasons where it no longer matches: a stale figure is
still evidence. **Today every saved figure is stale.** They were worked out on
3–4 September 2026 with the land-cover model (`itm-p2p/2`), which Flood-Net's
calibration against attenuator tests found reads about 41 dB below the margins
measured on site, on average ([`network-review.md`](network-review.md)); the
map now uses the field model (`itm-p2p/3`). Until the fade-margin layer is
worked out and saved again, quote them as stale — they are much too low — and
set `measured` beside them. For a "Fade margin over 20 dB" line, read
`best_path.weakest_hop.margin_db` and its `stale`, and the newest of
`measured.tests`.

```sh
curl -s -H 'X-FloodNet-Client: your-name' \
  'https://floodwarning.net/api/v1/stations/fifteen_mile_al/radio-path'
```

A real answer, from the live database on 1 November 2026, trimmed (`…`) —
Fifteen Mile AL, a field station:

```json
{
  "id": "fifteen_mile_al", "name": "Fifteen Mile AL", "station_number": "540601", "roles": ["field"],
  "lat": -27.3986, "lon": 152.0731, "proposed": false, "starts_as": "field station",
  "summary": [
    "Fifteen Mile AL's ALERT addresses 4043 and 4044 are passed by 2 repeaters within 150 km: Toowoomba AL (17 km) and Mt Glorious AL RPTR (67.27 km).",
    "Best path to a base station, every hop modelled: Fifteen Mile AL → Toowoomba AL (-22.8 dB) → GATTON LVRC ENVIROMON BASESTATION (+5.2 dB). Its weakest hop is Fifteen Mile AL → Toowoomba AL, -22.8 dB, bad (under 6 dB).",
    "Every saved figure on these routes is stale: worked out on 3 September 2026 with the land-cover model (itm-p2p/2), and Flood-Net now works fade margins out with the field model (itm-p2p/3), calibrated against path margins measured on site. The land-cover model read about 41 dB below those measurements on average, so read these figures as much too low, not as the margin, until the Stations map's fade-margin layer is worked out and saved again.",
    "On 3 hops an end has also changed since — moved, or its ground height, antenna, radio or frequency — and stale_reasons says which.",
    "13 of the 16 hops on these routes have no saved figure: not modelled yet — Flood-Net computes these on the Stations map and an editor saves them.",
    "Measured on site: the last attenuator test, on 9 December 2016, found Fifteen Mile AL's reports still reaching base through 19 dB of added loss (read as 19–20 dB); before it, 19 dB on 15 December 2015 and 21 dB on 27 November 2014. That is the whole path, station to base; the figures above are each hop's."
  ],
  "best_path": {
    "status": "ok", "route": "Fifteen Mile AL → Toowoomba AL → GATTON LVRC ENVIROMON BASESTATION",
    "stations": ["fifteen_mile_al", "toowoomba_al", "gatton_lvrc_enviromon_basestation"],
    "base": { "id": "gatton_lvrc_enviromon_basestation", "name": "GATTON LVRC ENVIROMON BASESTATION" },
    "hop_count": 2, "distance_km": 49.26, "complete": true, "unmodelled_hops": 0, "stale_hops": 2,
    "weakest_hop": { "from": "fifteen_mile_al", "to": "toowoomba_al", "margin_db": -22.8, "band": "bad", "stale": true },
    "hops": [
      { "from": "fifteen_mile_al", "to": "toowoomba_al", "status": "ok", "margin_db": -22.8, "band": "bad", "stale": true },
      { "from": "toowoomba_al", "to": "gatton_lvrc_enviromon_basestation", "status": "ok", "margin_db": 5.2, "band": "bad", "stale": true }
    ]
  },
  "repeaters": {
    "status": "ok", "addresses": [4043, 4044],
    "items": [
      { "id": "toowoomba_al", "name": "Toowoomba AL", "station_number": "540162", "distance_km": 17, "passes_addresses": [4043, 4044],
        "rx_mhz": 151.525, "tx_mhz": 151.525,
        "first_hop": { "from": "fifteen_mile_al", "to": "toowoomba_al", "status": "ok", "margin_db": -22.8, "band": "bad", "stale": true },
        "to_base": { "status": "ok", "routes_found": 12,
          "bases_reachable": [{ "id": "gatton_lvrc_enviromon_basestation", "name": "GATTON LVRC ENVIROMON BASESTATION", "fewest_hops": 2, "distance_km": 32.26 }, "…"],
          "routes": [
            { "route": "Fifteen Mile AL → Toowoomba AL → GATTON LVRC ENVIROMON BASESTATION", "complete": true, "…": "…" },
            { "route": "Fifteen Mile AL → Toowoomba AL → Marburg Radar", "complete": true,
              "weakest_hop": { "from": "toowoomba_al", "to": "marburg_radar", "margin_db": -26.9, "band": "bad", "stale": true }, "…": "…" },
            { "route": "Fifteen Mile AL → Toowoomba AL → Dalby Base Station", "complete": false, "unmodelled_hops": 1, "…": "…" }
          ] } },
      { "id": "mt_glorious_al_rptr", "name": "Mt Glorious AL RPTR", "distance_km": 67.27, "passes_addresses": [4043, 4044],
        "first_hop": { "from": "fifteen_mile_al", "to": "mt_glorious_al_rptr", "status": "not modelled" }, "to_base": { "…": "…" } }
    ]
  },
  "hops": [
    { "from": { "id": "fifteen_mile_al", "name": "Fifteen Mile AL" }, "to": { "id": "toowoomba_al", "name": "Toowoomba AL", "role": "repeater" },
      "kind": "field", "distance_km": 17, "status": "ok", "margin_db": -22.8, "margin_back_db": -22.8, "band": "bad",
      "thresholds_db": { "good": 15, "ok": 6 }, "freq_mhz": 151.5, "verdict": "obstructed",
      "model": "itm-p2p/2", "computed_at": "2026-09-03T06:29:42.439504+00:00", "stale": true, "ends_changed": true,
      "stale_reasons": [
        { "reason": "model", "detail": "Worked out with the land-cover model (itm-p2p/2); Flood-Net now works margins out with the field model (itm-p2p/3)." },
        { "reason": "moved", "detail": "Toowoomba AL has moved 13 m since: its recorded position is not the one this was worked out at." },
        { "reason": "height", "detail": "Toowoomba AL had no recorded ground height then; it has 708.87 m AHD now." },
        { "reason": "frequency", "detail": "Worked out at 151.5 MHz; the line's frequency is 151.525 MHz now." }
      ] },
    { "from": { "id": "fifteen_mile_al", "…": "…" }, "to": { "id": "mt_glorious_al_rptr", "…": "…" }, "kind": "field", "distance_km": 67.27,
      "status": "not modelled",
      "detail": "Not modelled yet — Flood-Net computes fade margins on the Stations map (Layers → Link colour: By fade margin) and an editor saves them; none has been saved for this hop." },
    "…"
  ],
  "measured": { "status": "ok", "tests": [
    { "date": "2016-12-09", "date_precision": "day", "this_visit_db": 19, "this_visit_range_db": [19, 20] },
    { "date": "2015-12-15", "date_precision": "day", "this_visit_db": 19, "this_visit_range_db": [19, 20] },
    { "date": "2014-11-27", "date_precision": "day", "this_visit_db": 21, "this_visit_range_db": [21, 24] }
  ], "note": "…" },
  "model": { "current": "itm-p2p/3",
    "current_words": "the field model: Longley–Rice over the bare terrain at 256 points, less a 12 dB allowance measured on site, with repeaters and bases on at least a 10 m mast",
    "saved_models": { "itm-p2p/2": 3 }, "note": "…" },
  "rules": { "first_hops": 5, "first_hop_km": 150, "backbone_km": 100, "repeaters_per_route": 4, "beyond_fewest": 1, "routes_listed": 3 }
}
```

Its own attenuator tests carried 19–21 dB of added loss to base; the land-cover
model put its first hop alone at −22.8 dB. That gap is the calibration's
finding, at one station.

A repeater starts from itself. Toowoomba AL, the same day, trimmed:

```json
{
  "id": "toowoomba_al", "name": "Toowoomba AL", "station_number": "540162", "roles": ["field", "repeater"], "starts_as": "repeater",
  "summary": [
    "Toowoomba AL is a repeater, so its routes to a base station start at itself: 28 routes reach 8 base stations, the nearest GATTON LVRC ENVIROMON BASESTATION (32.26 km).",
    "Best path to a base station, every hop modelled: Toowoomba AL → GATTON LVRC ENVIROMON BASESTATION (+5.2 dB). Its weakest hop is Toowoomba AL → GATTON LVRC ENVIROMON BASESTATION, +5.2 dB, bad (under 6 dB).",
    "Every saved figure on these routes is stale: …",
    "On 8 hops an end has also changed since — …",
    "20 of the 32 hops on these routes have no saved figure: not modelled yet — …",
    "No attenuator test of Toowoomba AL's path margin is recorded at a site visit."
  ],
  "repeaters": { "status": "ok", "items": [{
    "id": "toowoomba_al", "name": "Toowoomba AL", "distance_km": 0, "rx_mhz": 151.525, "tx_mhz": 151.525, "first_hop": null,
    "to_base": { "status": "ok", "routes_found": 28, "bases_reachable": ["…"], "routes": [
      { "route": "Toowoomba AL → GATTON LVRC ENVIROMON BASESTATION", "complete": true,
        "weakest_hop": { "from": "toowoomba_al", "to": "gatton_lvrc_enviromon_basestation", "margin_db": 5.2, "band": "bad", "stale": true }, "…": "…" },
      { "route": "Toowoomba AL → Schultz Lookout AL → Constitution Hill", "complete": true, "hops": [
          { "from": "toowoomba_al", "to": "schultz_lookout_aler", "status": "ok", "margin_db": 4.6, "band": "bad", "stale": true },
          { "from": "schultz_lookout_aler", "to": "constitution_hill", "status": "ok", "margin_db": -3.7, "band": "bad", "stale": true }], "…": "…" },
      { "route": "Toowoomba AL → Mt Petersen AL → Marburg Radar", "complete": true, "hops": [
          { "from": "toowoomba_al", "to": "mt_petersen_al", "status": "ok", "margin_db": 35.8, "band": "good", "stale": true },
          { "from": "mt_petersen_al", "to": "marburg_radar", "status": "ok", "margin_db": -9.3, "band": "bad", "stale": true }], "…": "…" }
    ] } }],
    "note": "Toowoomba AL is a repeater itself, so its routes start here: first_hop is null." },
  "hops": [
    "…",
    { "from": { "id": "schultz_lookout_aler", "name": "Schultz Lookout AL" }, "to": { "id": "constitution_hill", "name": "Constitution Hill", "role": "base" },
      "kind": "backbone", "distance_km": 63.42, "status": "ok", "margin_db": -3.7, "margin_back_db": -3.7, "band": "bad",
      "freq_mhz": 151.525, "verdict": "obstructed", "model": "itm-p2p/2", "stale": true, "ends_changed": false,
      "stale_reasons": [{ "reason": "model", "detail": "Worked out with the land-cover model (itm-p2p/2); Flood-Net now works margins out with the field model (itm-p2p/3)." }], "…": "…" }
  ],
  "measured": { "status": "not recorded", "visits_read": 2, "detail": "None of the 2 dated site visits read recorded an attenuator test of its path margin." }
}
```

A base station answers `starts_as: "base station"` and no path; a station with
no ALERT address, or none a repeater passes, says so in `repeaters.detail`.

**In the app.** For a person, `links.app` opens the station on the Stations map
— `https://floodwarning.net/?tab=stations&station=<id>` — with its radio paths
drawn; clicking one opens its card, elevation profile and link budget. Add
`&map=<lat>,<lon>,<zoom>` to centre the map somewhere else at the same time —
a site the station might move to, say: the side panel's 🚚 **Relocate station**
then takes *Use the station on the card* and models the ground around it, and
the link budget prices a path from any point on the map. No address opens those
tools by itself; these two open the map where they work.

A dossier's `radio_path` is the same answer, shorter: one route per repeater,
each hop in full only on the best path and the first hops, no
`bases_reachable`, and `measured` from the dossier's own `inspections` (its
last three visits). It reads the repeaters and base stations once, held five
minutes, and the saved figures between the stations its routes touch in one
more read.

### `GET /api/v1/health/silent`

What has gone quiet. The stations Station Health finds **silent now** — they
have missed their expected checks while the receivers that hear them kept
delivering other traffic — worst first (critical, then the longest silent),
and the **groups** that went quiet together, around one place
(`area-silence`) or behind one repeater (`repeater-down`), which usually share
one cause. It is the server's own run of Station Health's rules, every fifteen
minutes with nobody's browser open; `checked_at` and `minutes_since_checked`
say when it last looked, and a note says so if that is more than 45 minutes
ago. Like the latest readings, it can only judge stations whose telemetry is
ingested into Flood-Net — a station absent here is not thereby well.

| Parameter | Meaning |
|---|---|
| `network` | a radio network id — see `/api/v1/networks` |
| `basin` | words in the Bureau's basin name for the station (`Burdekin`) |
| `type` | `rain`, `river`, `repeater` or `base` — the same rule as [`/api/v1/stations`](#get-apiv1stations) |
| `bbox` | a box, `west,south,east,north` in decimal degrees — longitude first |
| `severity` | `critical` or `warn` only |
| `format` | `json` (the default) or `geojson` — the silent stations as Points, `groups` alongside |
| `limit`, `offset` | 100 stations a page by default and at most 1,000; follow `next` |

A row is a station — id, name, Bureau number, position, `kinds`, basin, stream
and radio networks — with the finding: `severity`, `title`, `detail`, the
`action` to take, `last_heard_at` and `minutes_since_heard`,
`checks_every_minutes` and `checks_missed`, and `noticed_at` (when the server
first saw it). A group carries its `kind`, `severity`, `title`, `since` and its
`station_ids` — with a filter, only those of its stations that pass it.

```sh
curl -s 'https://floodwarning.net/api/v1/health/silent?severity=critical'
```

```json
{
  "count": 1, "total": 1, "limit": 100, "offset": 0, "next": null,
  "query": { "severity": "critical", "limit": 100, "offset": 0 },
  "checked_at": "2026-10-21T07:31:46.096+00:00", "minutes_since_checked": 4,
  "stations": [{
    "id": "mt_tamborine_al", "name": "Mt Tamborine AL", "lat": -27.94, "lon": 153.19, "kinds": ["rain"],
    "radio_network_ids": [], "severity": "critical", "title": "Silent — missed its last 4 checks",
    "detail": "Checks every 3 h; nothing heard since 08:17 today (9.2 h), while the receivers that hear it kept delivering other traffic.",
    "action": "Check power and radio at the station; if its repeater went quiet too, start there.",
    "last_heard_at": "2026-10-20T22:17:47.000Z", "minutes_since_heard": 558,
    "checks_every_minutes": 180, "checks_missed": 4, "noticed_at": "2026-10-21T06:38:02.347+00:00"
  }],
  "groups": [],
  "notes": ["A station is silent when it has missed its expected checks …"],
  "source": "meganet.health_finding (source stations; kinds silent, area-silence, repeater-down; open); meganet.health_refresh; meganet.station"
}
```

### `GET /api/v1/stations/{id}/health`

What the **Station Health** tab shows when a station is opened, for a program:
the station's **findings** worst first — severity, what was found, the evidence,
what to do, since when — its **learned check schedule** with what arrived and
what was missed each day, and its **battery's night lows** with their trend. It
was asked for by a field team, to plan a run from and to read on arrival.

Nothing is worked out here. The server's own run of Station Health — the tab's
`health-analysis.js`, every fifteen minutes with nobody's browser open (see
[Station Health](station-health.md#with-the-tab-closed)) — works each of the
tab's windows out and keeps a card per station heard; this reads the card.
`checked_at` and `minutes_since_checked` say when it last did, and a note says
so if that is more than 45 minutes ago. Like the silent stations, it can only
judge a station whose telemetry is ingested into Flood-Net.

| Parameter | Meaning |
|---|---|
| `days` | the window, `3`, `7` (the default) or `14` days — the tab's three |

```sh
curl -s -H 'X-FloodNet-Client: your-name' \
  'https://floodwarning.net/api/v1/stations/round_mountain_al/health?days=7'
```

A real answer, from 27 October 2026, trimmed (`…`) — Round Mountain AL, whose
battery went critical while its checks stopped arriving whole:

```json
{
  "id": "round_mountain_al", "name": "Round Mountain AL", "station_number": "40945",
  "lat": -28.0708, "lon": 152.9272, "kinds": ["rain", "river"], "basin": "Logan-Albert Rivers",
  "owner": { "name": "Scenic Rim Regional Council", "parties": ["Scenic Rim Regional Council"], "from": "sls",
             "source": "the Bureau's QLD Service Level Specification" },
  "status": "critical", "worst": "critical", "attention": 3,
  "last_heard_at": "2026-10-27T05:50:04.419Z", "minutes_since_heard": 61,
  "heard_by": ["serial-monitor/rpi-83071968-sdr1", "…"],
  "findings": [
    { "id": "battery-critical:round_mountain_al", "kind": "battery-critical", "category": "power", "severity": "critical",
      "about": "station", "title": "Battery critical — 11.8 V",
      "detail": "Its lowest last night was 11.8 V — at or below 11.8 V the radio starts to brown out.",
      "action": "Visit: replace or recharge the battery and check the charging circuit before the radio browns out.",
      "since": null, "cause": null, "evidence": { "latestV": 13, "lastNightV": 11.8, "slopeVPerDay": 0 } },
    { "id": "missed-rising:round_mountain_al", "kind": "missed-rising", "category": "comms", "severity": "warn",
      "about": "station", "title": "Missed checks rising — 100% in the last 24 h",
      "detail": "8 of 8 checks missed in the last day, against 56% before (every 3 h).",
      "action": "Check the antenna, cable and connectors, and the path to its repeater — compare with its last fade margin.",
      "since": null, "cause": null, "evidence": { "n24": 8, "nPrior": 48, "rate24": 1, "ratePrior": 0.56 } },
    { "id": "shared-spell:spell:couran_point_al@498021", "kind": "shared-spell", "category": "network", "severity": "warn",
      "about": "group", "title": "113 stations across 217 km, Pottsville West Reservoir to Linville AL, went silent together, and came back",
      "since": "2026-10-24T20:38:21.206Z", "evidence": { "from": "2026-10-24T20:38:21.206Z", "to": "2026-10-25T19:19:43.044Z",
      "stations": ["coplicks_br_al", "…"], "stationsTotal": 113 }, "…": "…" },
    "…"
  ],
  "schedule": {
    "every_minutes": 180, "learned_from": "battery", "tolerance_s": 324,
    "slot_times": ["00:41", "03:41", "06:41", "09:41", "12:41", "15:41", "18:41", "21:41"],
    "next_due_at": "2026-10-27T08:41:40.048Z", "sensors_per_check": ["a:5339", "a:5340", "a:5338"],
    "checks": { "due": 56, "received": 8, "incomplete": 13, "missed": 35, "missed_network_wide": 0, "unknown": 0 },
    "received_share": 0.38, "miss_rate": 0.63, "scattered_miss_rate": 0, "trailing_misses": 13,
    "clock": { "offset_s": -9.7, "drift_s_per_day": 1 },
    "daily": [
      { "date": "2026-10-20", "received": 0, "incomplete": 2, "missed": 0, "missed_network_wide": 0, "unknown": 0 },
      { "date": "2026-10-21", "received": 1, "incomplete": 3, "missed": 4, "missed_network_wide": 0, "unknown": 0 },
      "…"
    ],
    "spells": [{ "from": "2026-10-20T20:41:40.048Z", "to": "2026-10-21T05:41:40.048Z", "checks": 4, "open": false }, "…",
               { "from": "2026-10-25T17:41:40.048Z", "to": "2026-10-27T05:41:40.048Z", "checks": 13, "open": true }]
  },
  "battery": {
    "address": "a:5340", "alert_id": 5340, "latest": { "at": "2026-10-25T11:41:39.515Z", "v": 13 },
    "last_night_low_v": 11.8, "min_v": 11.8, "max_v": 13.3,
    "night_lows": [{ "at": "2026-10-20T17:41:40.545Z", "v": 12.9 }, { "at": "2026-10-21T17:41:40.332Z", "v": 12.9 }, "…"],
    "day_highs": [],
    "trend_v_per_day": 0, "days_to_critical": null, "daily_swing_v": null, "flat": false, "spikes_set_aside": 0,
    "thresholds_v": { "low": 12.2, "critical": 11.8 }
  },
  "days": 7,
  "window": { "days": 7, "from": "2026-10-20T06:44:30.279Z", "to": "2026-10-27T06:44:30.279Z", "time_zone": "Australia/Brisbane" },
  "checked_at": "2026-10-27T06:44:30.279+00:00", "minutes_since_checked": 7, "card_changed_at": "2026-10-27T06:44:30.279+00:00",
  "other_windows": { "3": "https://floodwarning.net/api/v1/stations/round_mountain_al/health?days=3", "14": "…" },
  "notes": ["Station Health's own rules …"],
  "source": "meganet.health_card …"
}
```

`daily_swing_v` and `days_to_critical` are `null` here: the window holds no
daytime battery reading to set against the nights, and no falling trend to
project. A null is "not enough to say", never zero.

- **Findings** are exactly the tab's: the same `id`, `kind`, `category`
  (power, comms, sensor, data, network, register), `severity` (`critical`,
  `warn`, `info` — a note), `title`, `detail` and `action`, with `since` (when
  the condition began, where the finding has one) and its `evidence` in
  numbers, times as ISO 8601. `about` says whose it is: the station's own, the
  station `repeater` it is about, or a `group` it is one of (stations that went
  quiet together around a place or behind a repeater) — a group's finding is
  on each of its stations. Every kind is in
  [Station Health → Every finding](station-health.md#every-finding).
- **`status`** is the station's worst own finding, `ok` when nothing was found,
  `irregular` when no check schedule could be learned (a station that reports
  on events only), `not heard` when the window holds nothing from it (then
  `last_heard_at` is when Flood-Net's ingest last heard it, if ever, and a
  longer window is suggested), and `not recorded` when the server has not
  worked the window out yet.
- **The schedule is learned, not assumed:** `every_minutes` is the period its
  reports keep, among the intervals a logger is set to; `slot_times` the day's
  check times (listed when there are 24 or fewer), `next_due_at` the next one.
  A check is `received`, `incomplete` (some of `sensors_per_check` missing),
  `missed` while a receiver that hears the station was listening,
  `missed_network_wide` (most of the network missed that quarter-hour — not the
  station's), or `unknown` (nothing that hears it was listening). `daily`
  counts them per day; `spells` are runs of four or more misses, `open` while
  it is still in one. `received_share` is received over due.
- **The battery is trended on its night lows** — the lowest reading between
  18:00 and 09:00 in the station's own solar time, night after night —
  Theil–Sen, so one bad night cannot move it: `trend_v_per_day`, and
  `days_to_critical` to 11.8 V at that rate. `daily_swing_v` is day high
  against night low — whether charge is arriving at all. `thresholds_v` are
  the lines the findings use.
- **Dates and clock times** (`daily[].date`, `slot_times`) are in
  `window.time_zone`, Queensland's; every other time is ISO 8601 UTC.
- **Windows are worked out separately**, as on the tab: a station can say
  something different over 3 days than over 7 — a battery needs nights to be
  judged, and a station that has sent little lately has few of them in a
  short window. Ask for the window you want to plan from.
- A **503** `"not available yet"` would mean the database lacks migration
  `0085` (live since 27 October 2026 —
  [For the owner](#apply-0085-for-station-health-per-station)).

### `GET /api/v1/health/findings`

The same for **a page of stations at a time**, worst first — what *Export
findings* gives on the tab, for planning a campaign: every row is what
[`/stations/{id}/health`](#get-apiv1stationsidhealth) answers for that station
(its `link`), with its owner. By default it lists the stations with at least one
finding; `ids` names them instead.

| Parameter | Meaning |
|---|---|
| `owner` | owners, comma-separated, as the station card's Owner row says them — the Service Level Specification's owner where it lists the station, else the one recorded on the station: `Seqwater`, `Bureau of Meteorology` (`Bureau` also works), a council. Any case. A joint owner (`Bureau/Sunwater`) is found under each party. `none` is no owner on record. `owners` in the answer lists those in the window |
| `ids` | station ids, comma-separated, up to 100 — the sites you are working on. Every one is answered, found or not (`ok`, `not heard`), unless `min_severity` is given too; one that names no live station is listed in `unknown_ids` |
| `network` | a radio network id — see `/api/v1/networks` |
| `basin` | words in the Bureau's basin name for the station (`Burdekin`) |
| `type` | `rain`, `river`, `repeater` or `base` — the same rule as [`/api/v1/stations`](#get-apiv1stations) |
| `bbox` | a box, `west,south,east,north` in decimal degrees — longitude first |
| `min_severity` | the least severe finding a station must have to be listed: `critical`, `warn` (needs attention, the tab's default list) or `info` (any — the default) |
| `days` | the window, `3`, `7` (the default) or `14` |
| `limit`, `offset` | 25 stations a page by default and at most 100; follow `next` |

Order: worst finding first, then the most needing attention, the most found,
the id; a station named and not heard last.

```sh
curl -s -H 'X-FloodNet-Client: your-name' \
  'https://floodwarning.net/api/v1/health/findings?owner=Seqwater&min_severity=warn&days=7' \
  | jq '{total, owners: .owners[:3], stations: [.stations[] | {id, worst, findings: [.findings[].title]}]}'
```

A real answer, from 27 October 2026, trimmed. `owners` counts every owner
among the stations the other filters keep — here, every station needing
attention — so a client can see which owners it may ask for:

```json
{
  "total": 24,
  "owners": [{ "owner": "Bureau of Meteorology", "stations": 92 }, { "owner": "none", "stations": 79 },
             { "owner": "Seqwater", "stations": 24 }],
  "stations": [
    { "id": "nindooinbah_dam_al", "worst": "critical", "findings": ["Silent — missed its last 23 checks", "Battery low — 12.1 V",
      "31% of its checks arrive incomplete", "Rain counter went backwards 2 times", "2 corrupted rain-gauge counts set aside"] },
    { "id": "ewen_maddock_dam_al", "worst": "critical", "findings": ["Silent — missed its last 27 checks",
      "Went silent for 15 h, then came back", "Rain counter went backwards 1 time", "4 corrupted rain-gauge counts set aside"] },
    { "id": "bill_gunn_dam_al", "worst": "warn", "findings": ["Silent — missed its last 20 checks",
      "9 stations around Bill Gunn Dam AL went quiet together", "Rain counter went backwards 1 time", "4 corrupted rain-gauge counts set aside"] },
    "…"
  ]
}
```

The answer also carries `count`, `limit`, `offset`, `next`, `query`, `days`,
`window`, `checked_at`, `minutes_since_checked`, `owners` (every owner among
the stations the other filters kept, with how many stations each — a joint
owner counted under each party; `none` for no owner on record), `notes` and
`source`. A page of 100 fortnight cards is under a megabyte.

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

### `GET /api/v1/changelog`

Every change to this API that someone using it would notice — a route, a
field, a limit, a tool — newest first: the [Changes](#changes) below, as data.
Each entry has an `id`, a `date`, a `title`, a plain-words `summary`,
`breaking` (`true` when a client that relied on what was there before may need
to change) and `links`. `latest` is the newest; `notify.sign_up` is where to
leave an address to be emailed the next one. It takes no parameters.

```sh
curl -s https://floodwarning.net/api/v1/changelog | jq '.entries[] | {date, title, breaking}'
```

```json
{
  "count": 2,
  "latest": { "id": "2026-10-31-changelog-and-notify", "date": "2026-10-31", "title": "This list of changes, and an email when the API changes", "breaking": false },
  "entries": [
    { "id": "2026-10-31-changelog-and-notify", "date": "2026-10-31", "title": "This list of changes, and an email when the API changes",
      "summary": "New: GET /api/v1/changelog lists every change to the API …", "breaking": false,
      "links": [{ "text": "The list of changes, as JSON", "url": "https://floodwarning.net/api/v1/changelog" }, "…"] },
    { "id": "2026-10-31-acma-licences", "date": "2026-10-31", "title": "The ACMA licences at a station's site, or at a point", "…": "…" }
  ],
  "notify": { "sign_up": "https://floodwarning.net/api#notify", "what": "Leave your address on that page …" },
  "source": "docs/api-changelog.json"
}
```

---

## Limits and fair use

The API is throttled so that one runaway agent cannot lock the database up for
everyone else — the app itself reads the same database.

| Rule | Limit | Keyed on |
|---|---|---|
| per client | 60 requests / 60 s | your address + your `X-FloodNet-Client` name |
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
a 5 km radius for the ACMA licences (500 m by default) and 300 licences per answer;
reading windows of 7 / 31 / 731 days (raw / hourly / daily); 1,000 stations per
call of the latest readings (100 by default); 100 station ids per call of the
health findings; for a radio path, the nearest 5 first repeaters within 150 km,
100 km a backbone hop, 4 repeaters a route and 1,000 routes weighed, 3 listed per
repeater; at most 5,000 stations considered
by one filtered search before paging; 32 database reads per request, six at a
time, each with a 10-second timeout; MCP bodies up to 64 KB and batches of up to
10.

**Fair use.** Cache what you fetch — a station's register record changes rarely,
and identical questions within a minute are answered from the edge cache anyway.
Ask about the stations you need rather than walking the whole network. Give your
client a name. The database's outbound transfer is a monthly
quota shared with everyone using the app, and what goes past it is billed.

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
  NSW AEP level workbooks, at the sheet's own point (sometimes not where Flood-Net
  puts the station — `point_offset_km` says how far), with the sheet's
  confidence score (1–9, higher is better). Not observations.
- **Two sets of flood classes — three on the border.** The Bureau's river
  height station lists and the Service Level Specifications each give classes;
  they can differ. All are given, each with its edition (`as_at` for the lists;
  each SLS row names its document, `QLD` or `NSW`, and `service_level.editions`
  its version). A station both SLSs list has a row from each, and they can
  disagree with each other too.
- **Manual vs telemetered.** The SLS's `gauge_type` is its own word: *Manual*
  (read by an observer) or *Automatic* (telemetered). A station's ALERT
  addresses, ARRO sensors and satcom flag are the register's telemetry evidence.
- **Elevation.** `elevation_source` is `surveyed`, or `modelled — Elvis …` for a
  height taken from a digital elevation model through Geoscience Australia's
  Elvis. A modelled height is not a survey mark.
- **Health and readings are Flood-Net's own ingest.** `health` is when Flood-Net's
  MQTT bridge or HTTP ingest last heard from the station; readings — and the
  latest readings — are what reached that ingest. Most stations report through
  the Bureau's systems, so "not recorded" here, or a station missing from the
  latest readings, says nothing about whether a station works.
- **Station Health is worked out by the server, not here.** The cards behind
  [`/stations/{id}/health`](#get-apiv1stationsidhealth) and
  [`/health/findings`](#get-apiv1healthfindings) are the server's run of the
  tab's own rules every fifteen minutes; `checked_at` says when. A missed check
  counts only while a receiver that hears the station was listening, so a
  station only one receiver hears cannot be judged while that receiver is
  down — its checks are `unknown`, not missed.
- **Positions are `[lon, lat]` in GeoJSON** and `lat`, `lon` everywhere else —
  including `near=lat,lon`. `bbox` is GeoJSON's order, west, south, east, north.
- **Inspections are numbers only.** Remarks, who inspected and any free text
  are not public.
- **`not recorded` is not zero**, and **`unavailable`** means a read failed —
  ask again.
- **Kinds are derived.** `rain`/`river` come from the record's ALERT addresses,
  location types and the Bureau's river height list; see
  [`/api/v1/stations`](#get-apiv1stations).
- **Saved fade margins are modelled, and today all stale.** A radio path's
  figures are the Stations map's Longley–Rice margins as an editor saved them,
  each with the model it was worked out with and whether the register still
  matches it (`stale`, `stale_reasons`). Every one now was worked out on 3–4
  September 2026 with the land-cover model, which reads far below measured
  margins; say so when you quote one, and quote the attenuator tests
  (`measured`) beside it. A hop with no saved figure is `not modelled`, never
  zero.
- **The ACMA register is an extract, and a subset.** The licences come from the
  ACMA's Register of Radiocommunications Licences as Flood-Net last took it
  (`register_extract.source_date`; refreshed weekly when the download works),
  cut to the transmitters at sites within 60 km of a Flood-Net repeater — every
  one in 148–174 MHz, those whose harmonics could land on a repeater's receive
  channel, and any frequency within 250 m of a repeater. A licence that is not
  in it may still be on the ACMA's register, and a status or expiry may have
  changed since: check the ACMA's own register before relying on one, and say
  the extract's date when you quote it. Contains data from the Australian
  Communications and Media Authority, Register of Radiocommunications Licences
  (CC BY 4.0); licensee details must not be used for unsolicited messaging.

---

## Drafting assessment reports

The dossier is the starting point: one call per station gives an agent the
identity, location, network, telemetry, service level, flood heights,
inspection history and neighbours, each labelled with its source, plus a
`summary` of plain sentences to build from. A prompt that works:

> Using the Flood-Net MCP server, get the dossier for station `<id or Bureau
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

## Changes

Every change to the API that someone using it would notice is listed here and
at [`GET /api/v1/changelog`](#get-apiv1changelog), newest first — both from
[`docs/api-changelog.json`](api-changelog.json), which a change adds an entry to
in the same push. A change with nothing to notice (a fix inside, a faster
answer) is not listed.

- **1 November 2026 — One ALERT burst heard several ways is one reading.**
  A legacy ALERT frame carries no time, so each receiver stamps it when it
  heard it, and copies of one burst that came through a repeater or an ALERT2
  concentrator were stored as separate readings a second or so apart — about
  6 % of ALERT readings. From today the same address and value within 8
  seconds is one reading, its other copies counted in `dup_count`. Raw
  readings for a legacy ALERT station have fewer near-identical rows and more
  `dup_count`; nothing else changed. Readings stored before today keep their
  twins.
- **1 November 2026 — A station's radio path to base, with the fade margins
  Flood-Net saved.** [`GET /api/v1/stations/{id}/radio-path`](#get-apiv1stationsidradio-path)
  (MCP `get_radio_path`) is new: the repeaters that pass a station's ALERT
  addresses, the routes on along the backbone to a base station, and every
  hop's saved fade margin — both ways, band, frequency, distance, line of
  sight, model and date — with whether it is stale and why, the best path and
  its weakest hop, and the path margins measured at site visits. Every saved
  figure is stale today (worked out with the land-cover model, which reads much
  too low), and each answer says so. The dossier gains a `radio_path` section
  and its `links` a `radio_path` link. Nothing that was there before changed.
- **31 October 2026 — This list of changes, and an email when the API
  changes.** `GET /api/v1/changelog` lists every change, newest first, and the
  index links to it as `changelog`. The [notify list](#an-email-when-the-api-changes)
  emails each one to whoever asks. Nothing about the station data changed.
- **31 October 2026 — The ACMA licences at a station's site, or at a point.**
  [`GET /api/v1/stations/{id}/acma`](#get-apiv1stationsidacma) (MCP
  `get_acma_licences`) and [`GET /api/v1/acma`](#get-apiv1acma)
  (`acma_licences_near`) are new; the dossier gains an `acma` section and its
  `links` an `acma` link. Nothing that was there before changed.

### An email when the API changes

Leave an email address in the form on [the API page](https://floodwarning.net/api#notify)
— with a name and an organisation if you like — and each new entry above is
emailed to you once, in plain text, from `noreply@floodwarning.net`.

- **Confirm first.** The first email is a link; the page it opens has a
  **Confirm** button, and nothing more is sent until it is pressed. An address
  somebody else typed in gets that one email and no other, and a mail system
  that opens links to scan them confirms nothing.
- **Stop any time.** Every email has a link to stop them — a page with one
  button that deletes the address from the list — and carries the
  `List-Unsubscribe` headers a mail program's own *Unsubscribe* uses, which
  takes one click.
- **Several at once.** Changes pushed together come as one email. A breaking
  one says so in its subject.
- **Not switched on yet?** The emails go through Resend once Flood-Net's mail is
  set up (issue #237). Until then a sign-up is kept, and its confirmation is
  sent as soon as mail is on; the form says which.
- **What is kept, and where.** The address, the name and organisation if
  given, when it signed up and confirmed, and which change it was last sent —
  in Flood-Net's private storage (Cloudflare R2), never in this repository, and
  never in a log. Unsubscribing deletes it. The [privacy policy](https://floodwarning.net/privacy#api-notify) has the rest.

A program can sign up too — `POST https://floodwarning.net/api/notify/subscribe`
with `{"email": "…"}` — but only from Flood-Net's own pages (the request needs
their `Origin`), a few a minute: it is a form for people, not an API.

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
3. **Application name:** `Flood-Net public API`.
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
MCP client above can set the same way it sets `X-FloodNet-Client`.

The API is also on `meganet.<account>.workers.dev` if that is enabled (Access
does not cover it; the same limits apply). GitHub Pages has no API.

### Apply 0057, for the latest readings

`GET /api/v1/readings/latest` (and the MCP tool `get_latest_readings`) reads
`meganet.reading_latest`, a view `db/migrations/0057_reading_latest.sql`
creates. The Worker deploys on push; the migration lands only when somebody
applies it, and until then the route answers 503 `"not available yet"` naming
the migration. Nothing else in the API depends on it. `0086` then keeps that
view's rows in a table as readings arrive; without it the view walks every
address on each read, which passed anon's 3 s timeout at 6,700 addresses —
the route then answers 503 `"database unavailable"` (57014) on and off,
whatever the filters. To apply them:

1. In the Supabase dashboard, open the Flood-Net project → **SQL Editor** →
   **New query**.
2. Paste the whole of `db/migrations/0057_reading_latest.sql` and **Run**. It is
   idempotent and checks itself at the end: it raises an error, and changes
   nothing, if the view did not come out as it should. (Or, from a shell with
   the connection string: `psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1
   --single-transaction -f db/migrations/0057_reading_latest.sql`.)
3. Check it from anywhere — the answer should have a `count`, not an `error`:

   ```sh
   curl -s 'https://floodwarning.net/api/v1/readings/latest?limit=1' | jq '{count, total, error}'
   ```

   `tools/check_reading_latest.sql` proves the view itself, in a transaction
   that rolls back, so it is safe against the live database.

It depends on nothing in `0053`–`0056`, so it can go in before or after them.
Like every migration it raises `meganet.app_meta.schema_version` (to 57, never
down), so `DB_SCHEMA_VERSION` in `core.js` follows it in a commit of its own;
until then the app's Data source panel reports the database as newer than the
app, which is true and harmless.

### Apply 0085, for Station Health per station

Applied to the live database on 27 October 2026, with the cards reported from
the next run; what follows is for a fresh project, or to check it.

[`/stations/{id}/health`](#get-apiv1stationsidhealth) and
[`/health/findings`](#get-apiv1healthfindings) (the MCP tools
`get_station_health` and `get_health_findings`) read `meganet.health_card` and
`meganet.health_card_run`, which `db/migrations/0085_health_cards.sql` creates,
and the cards in them are written by the Station Health workflow
(`.github/workflows/station-health.yml`) — which deploys with the push, and from
its next run reports cards to a database that has the migration. Until it is
applied both routes answer 503 `"not available yet"` naming it, and each run's
log says `apply db/migrations/0085_health_cards.sql. No cards reported.`
without failing. Nothing else depends on it.

1. Apply it the way every migration is applied
   ([`db/README.md`, "Applying"](../db/README.md)): **Actions** →
   **db-migrate** → **Run workflow** on `main`, or in the Supabase dashboard →
   **SQL Editor** → **New query**, paste the whole of
   `db/migrations/0085_health_cards.sql` and **Run**. It is idempotent and
   checks itself at the end.
2. Within fifteen minutes the next Station Health run reports the cards (its
   log ends `Cards reported, 14 days: … stations`). Check it from anywhere:

   ```sh
   curl -s 'https://floodwarning.net/api/v1/health/findings?limit=1' | jq '{total, checked_at, error}'
   ```

`tools/check_health_cards.sql` proves the migration, in a transaction that
rolls back, so it is safe against the live database. `DB_SCHEMA_VERSION` in
`core.js` follows it to 85 once it is live.

### The notify list

`worker/notify.js` answers `/api/notify/*` and, from the Worker's
`scheduled()` on every fifteenth minute (:04, :19, :34, :49 UTC), sends what is
due: the confirmations waiting, then each new `docs/api-changelog.json` entry to
every confirmed address — 10 emails a run at most, 60 a UTC day, paced under
Resend's two a second, so a big list takes a few runs. Pushing an entry is all
it takes: Workers Builds deploys it, and the next run emails it.

- **Mail.** It sends through Resend with the bug reporter's `RESEND_API_KEY` and
  sender, so #237's Parts 2–3 switch it on. Until then sign-ups are kept as
  pending and a run reads nothing; the first run after the key is set sends
  every waiting confirmation.
- **Adding somebody.** Put their address in the form on
  [the API page](https://floodwarning.net/api#notify). They get the
  confirmation email (once mail is on) and are on the list when they press
  Confirm — nobody can be put on it without their own click.
- **The list.** One JSON object, `_meganet/api-notify/subscribers.json`, in the
  `meganet-photos` R2 bucket (Cloudflare dashboard → **R2** → **meganet-photos**
  → `_meganet/api-notify/`). No photo path reaches `_meganet/`. To remove
  somebody by hand, download it, delete their entry from `subscribers`, and
  upload it back under the same name — or use the link in any email they were
  sent.
- **Brakes.** Flood-Net's own pages only, JSON only, 3 sign-ups a minute from
  one address (`NOTIFY_RATE_LIMIT` in `wrangler.toml`), 30 new addresses a UTC
  day and 1,000 in all. A pending sign-up whose link went unanswered for 14
  days is deleted, as is one never sent a link for a year.
- **Checking it.** `GET https://floodwarning.net/api/notify` answers
  `{"accepting": true, "mail": false|true, "latest": …}`. The Worker's log has a
  `[notify]` line of counts when a run sent something — never an address.

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
`.cursor/rules/floodnet-api.mdc`); `npm run agentdocs` (`test/agent-docs.mjs`)
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
