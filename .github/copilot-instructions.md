# Copilot instructions — Flood-Net

Flood-Net (https://floodwarning.net) is the engineering register of the Bureau of
Meteorology's Queensland flood-warning telemetry network: field stations,
repeaters, base stations and radio paths. It is not a flood warning service.
`AGENTS.md` at the repository root is the canonical agent file; this repeats the
essentials.

## Station data for agents

See [`docs/agent-api.md`](../docs/agent-api.md).

- REST: `https://floodwarning.net/api/v1` — OpenAPI at
  `https://floodwarning.net/api/v1/openapi.json`.
- MCP: `https://floodwarning.net/api/mcp` (Streamable HTTP, no auth). VS Code
  `.vscode/mcp.json`:
  `{ "servers": { "floodnet": { "type": "http", "url": "https://floodwarning.net/api/mcp" } } }`
- Read-only; public data only.
- Rate limits: 60 requests / 60 s per client, 20 requests / 10 s per client
  (burst), 240 requests / 60 s per address; honour `Retry-After` on 429. Name
  your client with `X-FloodNet-Client`.
- Station ids are lowercase slugs (`abergowrie_br_al`); Bureau numbers also work.
  `get_station_dossier` (`/api/v1/stations/{id}/dossier`) returns everything
  about a station with sources and `ok` / `not recorded` / `unavailable` status.
- `get_latest_readings` (`/api/v1/readings/latest`) is what every gauge
  reporting into Flood-Net is saying now, in one call; `format=geojson` on it
  and on station search answers GeoJSON for a map (`[lon, lat]`).
- `get_silent_stations` (`/api/v1/health/silent`) lists what has gone quiet —
  stations silent now and groups that went quiet together.
- `get_station_health` (`/api/v1/stations/{id}/health?days=3|7|14`) is what
  Station Health says about one station — findings, check schedule day by day,
  battery night lows; `get_health_findings` (`/api/v1/health/findings`) the
  same for a page of stations, by owner or station ids.
- Flood classes are metres on the gauge, AEP levels modelled m AHD (indicative);
  quote each figure's source and datum.

## Working in this repository

- Process rules are in `CLAUDE.md` (summarised in `AGENTS.md`): ask the owner
  when instructions conflict; patches go straight to `main`; issue titles carry
  `[Standalone|Epic|Sub-issue of #n]` and `[Model/Effort]` or `[Human]` tags;
  update `roadmap/roadmap-113.md` whenever issues change; and every app change
  bumps the `?v=` version stamp in `index.html`, `about.html`, `privacy.html`
  and `terms.html`, or the service worker keeps serving the old files.
- No build step: classic scripts loaded in a fixed order by `index.html`; only
  `init.js` runs at load. Migrations in `db/migrations/` are forward-only (see
  `db/README.md`). The Worker is `worker/` and deploys with `wrangler.toml`.
- Tests: `cd test && npm run all`; `npm run agentapi` and `npm run agentdocs`
  cover the agent API and these instructions.
