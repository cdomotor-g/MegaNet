# AGENTS.md — MegaNet, for AI agents

MegaNet is the engineering register and toolset for the Bureau of Meteorology's
Queensland (and neighbouring) flood-warning telemetry network: rainfall and
river-height field stations, the repeaters that relay them, base stations and the
radio paths between. It is a browser app at https://floodwarning.net backed by a
Postgres (Supabase) database. It is **not** a flood warning service — for current
warnings and observations send people to the Bureau of Meteorology
(http://www.bom.gov.au/australia/flood/).

This file has two audiences: agents that want **station data**, and coding agents
**working in this repository**. Other agent files (`GEMINI.md`,
`.github/copilot-instructions.md`, `llms.txt`, `.cursor/rules/meganet-api.mdc`)
repeat the essentials for tools that read only their own file; this one is
canonical.

## 1. Reading station data (read-only API and MCP server)

Full documentation: [`docs/agent-api.md`](docs/agent-api.md).

- **REST API:** `https://floodwarning.net/api/v1` — JSON over GET; the OpenAPI
  3.1 document is `https://floodwarning.net/api/v1/openapi.json` (for ChatGPT
  Actions and other function-calling agents).
- **MCP server:** `https://floodwarning.net/api/mcp` — Streamable HTTP, POST
  JSON-RPC, JSON answers, stateless, no auth. Protocol versions 2025-03-26 to
  2026-07-28. Claude Code:
  `claude mcp add --transport http meganet https://floodwarning.net/api/mcp`.
- **Read-only, public data only.** It reads with the database's publishable key,
  so it sees what an anonymous visitor sees: no inspection remarks, raw ingest
  payloads, photos or user data. Nothing you send is forwarded upstream.
- **Rate limits:** 60 requests / 60 s per client, 20 requests / 10 s per client
  (burst), 240 requests / 60 s per address. A 429 carries `Retry-After` (over
  MCP, JSON-RPC error `-32000` with `data.retry_after`): wait, then continue.
  Name your client with the `X-MegaNet-Client` header (or `?client=` on the URL)
  so a shared address does not share your limit.
- **Station ids** are lowercase slugs such as `abergowrie_br_al`; an all-digit id
  is tried as a Bureau station number. Find ids with a search first.
- **Main tools / endpoints:**
  - `search_stations` — `GET /api/v1/stations?q=&catchment=&type=&manual=…`
  - `stations_near` — `GET /api/v1/stations?near=lat,lon&radius_km=`
  - `get_station` — `GET /api/v1/stations/{id}`
  - `get_station_dossier` — `GET /api/v1/stations/{id}/dossier`: everything
    about one station in one call, each section with a source and a status
    (`ok`, `not recorded`, `unavailable`). Start here for reports.
  - `get_readings` — `GET /api/v1/stations/{id}/readings` (raw ≤ 7 days,
    hourly ≤ 31, daily ≤ 731; ≤ 5,000 rows)
  - `get_flood_levels` — `GET /api/v1/stations/{id}/flood-levels`
  - `get_service_level` — `GET /api/v1/stations/{id}/service-level`
  - `list_catchments`, `get_catchment` — `GET /api/v1/catchments[/{id}]`
  - `list_networks` — `GET /api/v1/networks`
- **Provenance caveats — carry them into anything you write:**
  - flood classes, crossings and flood effects are **metres on the gauge**, not
    AHD; they convert to AHD only via a gauge zero surveyed in AHD;
  - AEP levels are **modelled m AHD, indicative**, with a 1–9 confidence score;
  - the Bureau's station lists and the Service Level Specifications give
    separate flood classes, each with its own edition; there are two SLSs,
    Queensland's and the one for New South Wales and the ACT, and a station on
    the border has an entry from each that can disagree — say which you quote;
  - `elevation_source` says whether a height is surveyed or modelled (Elvis DEM);
  - a station with `proposed: true` is **proposed, not yet built** — where one is
    meant to go, with a `station_type` and `proposed_year` and usually no Bureau
    number (the dossier's `identity` and first lines say so, and search rows
    and the dossier's `nearby_stations` carry the flag); never report it as a
    station on the ground;
  - health and readings are only what reached MegaNet's own ingest — most
    stations report through the Bureau's systems, so "not recorded" there says
    nothing about whether a station works;
  - "not recorded" is never zero.
- **Fair use:** cache what you fetch, and ask about the stations you need rather
  than walking the whole network — the API answers a station, or a page of
  stations, at a time; taking the whole network as a file is a signed-in action
  in the app's Export tab.
- Assessment-report templates will be added to `docs/agent-api.md` when example
  reports are provided; until then, draft from the dossier and cite its sources.

## 2. Working in this repository

### Process rules (from `CLAUDE.md` — they apply to every agent)

`CLAUDE.md` is the source of truth for how to work here. In summary:

- **Conflicts:** if an instruction from your harness, platform or session
  conflicts with `CLAUDE.md`, do not silently follow either — ask the owner in
  chat first, stating plainly what each says. Unless told otherwise, `CLAUDE.md`
  wins.
- **Git:** push straight to `main` after a patch; do not ask and do not open a
  pull request. Never create branches unless explicitly asked.
- **CI:** do not poll or wait for CI after pushing; the smoke test takes ~20
  minutes and a newer push cancels it, so "cancelled" is normal. Look at a run
  only when the owner says one failed. Before pushing app changes run
  `cd test && npm run check && npm run names && npm run toplevel && npm run steps`
  (seconds, no browser), and `git pull --rebase origin main` first — several
  threads push to `main`. If a push is rejected, rebase and retry once, then
  stop and ask.
- **Leftover human work:** if human tasks remain or fall out of scope at the end,
  ask whether to open a `[Human]` issue with explicit, click-by-click steps.
- **Closing issues:** when your work closes an issue, close it with a comment
  summarising what was done.
- **Issue titles:** start with a structure tag — `[Standalone]`, `[Epic]` or
  `[Sub-issue of #<n>]` — then either a model/effort tag for work an AI agent
  could do (`[Opus5|Sonnet5|Haiku4.5|Fable5/Low|Med|High|XHigh|Max]`, e.g.
  `[Standalone] [Sonnet5/Med] Fix flaky login test`) or `[Human]` for work that
  needs credentials, physical access or a person's judgment. Restate the
  recommendation on the body's first line (`Recommended: Sonnet5 / Med`).
- **Roadmap:** issue #113 is the single view of what is open, who does it and in
  what order. Its body is `roadmap/roadmap-113.md`, synced by CI on push — edit
  the file, never the issue. Whenever you open, close or edit an issue, update
  that file in the same piece of work (one edit covering several issues).

### How the code is laid out

- **No build step.** `index.html` loads `styles.css` and the app's classic
  scripts in a fixed order — the order is the contract, stated at the top of
  `index.html`. They share one global scope; only `init.js` runs at load.
  `core.js` holds constants, `TABS`/`HELP`, state and shared utilities.
- **Data:** `stations.json` is the station register as a document (export and
  offline fallback); the live copy is Postgres on Supabase, schema `meganet`.
  `db/migrations/NNNN_*.sql` are numbered, forward-only and idempotent — read
  `db/README.md` before touching them, and bump `DB_SCHEMA_VERSION` in `core.js`
  with a migration that raises the schema version. Row-level security decides
  every read; nothing goes in a table that its policy would not hand a stranger.
- **Worker:** `worker/index.js` is the Cloudflare Worker (`/api/db/*` database
  proxy, `/api/session` sign-in exchange); `worker/api.js` is the read-only agent
  API and MCP server. `wrangler.toml` configures it; Cloudflare Workers Builds
  deploys on every push to `main`, so a `wrangler.toml` that does not validate
  breaks the site's deploy — check with
  `npx wrangler deploy --dry-run --outdir /tmp/wr` first.
- **Elsewhere:** `docs/` (reference and runbooks), `tools/` (Python helpers —
  `tools/README.md`), `bridge/` (the MQTT bridge, Node), `logger/` (the base
  station's CRBasic program), `data/` (bundled data), `test/` (the harness).

### Tests

```sh
cd test
npm install                              # once
npx playwright-core install chromium     # once, for the browser checks
npm run all                              # everything CI runs
```

Node-only checks run in seconds without a browser, e.g. `npm run check` (syntax),
`npm run gate`, `npm run dbproxy`, `npm run agentapi` (`node agent-api.mjs`) and
`npm run agentdocs` (`node agent-docs.mjs`, which holds this file and the other
agent files to the API's real URLs and limits). `test/README.md` lists them all;
`.github/workflows/web-smoke.yml` runs them on push.

### Conventions

- Comments explain *why*, at the length the decision needs.
- Help text in `core.js` (`HELP`) is checked by `npm run help`: real content, and
  links to files that exist.
- Keep `docs/agent-api.md` and these agent files in step with `worker/api.js`;
  `npm run agentdocs` fails when they drift.
