# Security policy

Flood-Net is a tool for running a flood warning radio and satcom network: the
web app, its Cloudflare Worker and agent API at floodwarning.net, the Supabase
database behind them, the MQTT bridge and the Raspberry Pi SDR relay, all in
this repository.

## Reporting a vulnerability

**Please do not open a public issue.** This repository is public, and an issue
describing a hole tells everyone about it before it is fixed.

Report it privately instead: on this repository's **Security** tab, choose
**Report a vulnerability**. Only the maintainers see the report, and the
conversation, the fix and any advisory happen there.

Useful to include: what you can reach or change that you should not, the steps
or request that shows it, and which part it is in (web app, Worker or agent API,
database, bridge, SDR relay).

Expect an acknowledgement within a week. The report is closed, and credited if
you want it to be, once the fix is live.

## In scope

- Reading or changing data without the account that should be needed — in
  particular site access codes, inspection records, or anything behind the
  login.
- The agent API (`/api/v1`, `/api/mcp`) doing anything other than reading
  public station data.
- Script injection in the web app, or a way to make it act for another user.
- Secrets or private data committed to this repository.

## Out of scope

- The upstream services Flood-Net reads (Bureau feeds, ACMA, QLD Globe and
  others) — report those to their owners.
- Rate limits being reachable, or denial of service by volume.
- Findings from automated scanners with no demonstrated impact.

## How this repository checks itself

CodeQL and Dependabot run on GitHub, and a scheduled Claude Code review reads
the code weekly; see `tools/security-scan/README.md`. What they find is kept
out of this public repository until it is fixed.
