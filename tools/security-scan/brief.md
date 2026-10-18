# Brief for the weekly security review

You are the scheduled weekly security review of Flood-Net. Nobody is watching
this session; work through it to the end without asking questions. Read
`CLAUDE.md` and `SECURITY.md` first and follow them — in particular the rules
on private data and the agent API.

## 1. Set up

- You need two repositories side by side under `/home/user`:
  `cdomotor-g/meganet` (read) as `/home/user/MegaNet`, and
  `cdomotor-g/flood-net-private` (push) as `/home/user/flood-net-private`.
  Attach any that is missing with `add_repo` and clone it shallow.
- Read `/home/user/flood-net-private/security/scan-log.md` if it exists. Its
  last entry names the commit the previous run reviewed and the focus area it
  went deep on.
- List the open issues in `cdomotor-g/flood-net-private` labelled
  `security-scan`, so you do not file one twice.

## 2. Review

Two passes, in this order.

**a. What changed.** `git log` and `git diff` from the last reviewed commit to
`main` (the whole of the last week if there is no log or the commit is gone —
history may have been rewritten, #239). Read every changed code file, migration
and workflow with the questions in step b in mind.

**b. One area in depth.** Take the area after the last run's in this list,
wrapping round; read all of it, not just what changed:

1. `worker/` — the agent API (`api.js`) must stay read-only by construction:
   only GETs, only `READABLE_RELATIONS`, nothing of the caller's request
   forwarded upstream. The access gate and token exchange in `index.js`,
   `photos.js`, `briefing.js`. CORS, headers, rate limits, error bodies that
   leak.
2. `db/migrations/` and `db/README.md` — row-level security on every table,
   grants to `anon` and `authenticated` against what `db/README.md` calls
   public, `security definer` functions (search_path set? caller checked?),
   site codes readable only by approved accounts (`0064`).
3. Front end, first half of the root `*.js` alphabetically — `innerHTML` and
   friends fed data from the network, the database, files or URLs; `eval` /
   `new Function`; `postMessage` handlers; tokens kept in storage; `auth.js`
   and `admin*.js` first if they fall in this half.
4. Front end, second half of the root `*.js`, plus `index.html`, `sw.js`,
   `_headers` (CSP and friends) and the other `.html` pages.
5. `bridge/` and `sdr-pi/` — MQTT and HTTP ingest: authentication of
   publishers, input validation, what a malformed or hostile packet can do,
   secrets in config, the Dockerfile.
6. `.github/workflows/` and `tools/` — script injection from event fields,
   `pull_request_target`, secrets reaching logs (logs here are public),
   over-broad `permissions`, unpinned third-party actions; ingest tools that
   could write private data into this public repository.
7. The whole repository for private data — landholder contact details,
   site codes, keys or tokens committed in files, fixtures or docs (`git grep`
   for key shapes: `eyJ`, `sk_`, `sb_secret`, `-----BEGIN`, and so on). Do not
   dig through old history (#239).

Also bugs: anything you find on the way that is plainly a correctness bug
rather than a security one, file too, at a lower severity.

Before filing, try to prove each finding: trace a concrete path from something
an outsider (or a lower-privileged account) controls to the harm. Run the
repo's own checks or a small local script where that settles it. Do not send
any request to the live site, the Worker or Supabase — this is a code review,
not a penetration test. Drop what you cannot make concrete; a short report of
real findings beats a long list of maybes.

## 3. File

For each finding, one issue in `cdomotor-g/flood-net-private`, label
`security-scan` (create the label if it does not exist):

- Title: `[Standalone] [<Model>/<Effort>] <severity>: <short description>` —
  severity one of `Critical`, `High`, `Medium`, `Low`, `Bug`; model and effort
  as `CLAUDE.md` describes (`[Human]` instead if only a person can fix it).
- Body: first line `Recommended: <Model> / <Effort>`. Then where (file:line
  at the commit you reviewed), what an attacker or user can do, the path you
  traced, and a proposed fix. Never quote a site code, key, token or a
  landholder's details, even when the finding is that one is exposed — name
  the file and line instead.

If an open `security-scan` issue already covers it, comment there only if you
have something new. If a fix has landed for an open one, say so on it with the
commit, and close it.

Never open an issue, push a commit or comment anywhere in `cdomotor-g/meganet`.
Fixing is a separate session's job (`tools/security-scan/README.md`).

## 4. Log

Append to `security/scan-log.md` in `flood-net-private` (create it, with a
one-line heading, if missing):

```
## <YYYY-MM-DD> — <meganet commit, short>
Focus: <area number and name>
Filed: #N, #N (or none) · Updated: #N (or none) · Closed: #N (or none)
<one or two lines on what you looked at and found nothing in, if anything notable>
```

Commit and push it straight to `main` of `flood-net-private` (`git pull
--rebase` first). That is the run's only commit.
