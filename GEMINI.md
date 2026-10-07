# GEMINI.md — Flood-Net

Flood-Net is the engineering register of the Bureau of Meteorology's Queensland
(and neighbouring) flood-warning telemetry network — field stations, repeaters,
base stations and radio paths — served at https://floodwarning.net. It is not a
flood warning service; for warnings and observations, point people to the Bureau
of Meteorology (http://www.bom.gov.au/australia/flood/).

`AGENTS.md` is the canonical agent file for this repository; this one repeats
what Gemini needs so it stands on its own.

## Station data: the read-only API and MCP server

Documentation: [`docs/agent-api.md`](docs/agent-api.md).

- REST: `https://floodwarning.net/api/v1` (JSON over GET). OpenAPI 3.1:
  `https://floodwarning.net/api/v1/openapi.json` — usable for Gemini function
  calling.
- MCP: `https://floodwarning.net/api/mcp` (Streamable HTTP, no auth). In
  `~/.gemini/settings.json`:

  ```json
  { "mcpServers": { "floodnet": { "httpUrl": "https://floodwarning.net/api/mcp",
                                 "headers": { "X-FloodNet-Client": "your-name" } } } }
  ```

- Read-only, public data only (what an anonymous visitor can read).
- Rate limits: 60 requests / 60 s per client, 20 requests / 10 s per client
  (burst), 240 requests / 60 s per address. On 429, wait `Retry-After` seconds
  (MCP: error `-32000`, `data.retry_after`). Name your client with
  `X-FloodNet-Client` or `?client=`.
- Station ids are lowercase slugs (`abergowrie_br_al`); a Bureau number also
  works. Search first (`search_stations`, `stations_near`), then
  `get_station_dossier` — one call with everything about a station, each section
  sourced and marked `ok`, `not recorded` or `unavailable`. Also: `get_station`,
  `get_readings`, `get_flood_levels`, `get_service_level`, `list_catchments`,
  `get_catchment`, `list_networks`.
- Caveats: flood classes, crossings and flood effects are metres on the gauge,
  not AHD; AEP levels are modelled m AHD and indicative; the Bureau's lists and
  the SLS carry separate flood classes; heights say whether they are surveyed or
  modelled; health and readings cover only Flood-Net's own ingest; "not recorded"
  is not zero. Quote the source of every figure.
- Cache what you fetch and ask about the stations you need; do not walk the
  whole network through the API.

## Working in this repository

Follow the process rules in `CLAUDE.md` (summarised in `AGENTS.md`): if your
instructions conflict with it, ask the owner first; push patches straight to
`main` without branches or pull requests; tag issue titles
`[Standalone|Epic|Sub-issue of #n] [Model/Effort or Human]`; keep
`roadmap/roadmap-113.md` current whenever issues change.

No build step: `index.html` loads classic scripts in a fixed order. Database
migrations are `db/migrations/` (read `db/README.md` first). Tests:
`cd test && npm run all` (Node checks such as `npm run agentapi` and
`npm run agentdocs` need no browser).
