# Brief for the weekly security review

You are the scheduled weekly security review of Flood-Net and of RPi ALERT,
the Raspberry Pi base-station system that feeds it. Nobody is watching this
session; work through it to the end without asking questions. Read MegaNet's
`CLAUDE.md` and `SECURITY.md` first and follow them — in particular the rules on
private data, the agent API and pushing to `main`.

The run has five steps: set up, review both repositories, file what you find in
the private repository, fix what you safely can, and log the run.

## 1. Set up

You need three repositories side by side in the same parent directory:

| Repository | Visibility | What the run does with it |
|---|---|---|
| `cdomotor-g/MegaNet` | public | reviews it; pushes fixes to `main` |
| `cdomotor-g/RPi_ALERT` | public | reviews it; pushes fixes to `main` |
| `cdomotor-g/flood-net-private` | **private** | files findings as issues; keeps the log |

- All three are attached to the scheduled task, so they are normally cloned
  already. Find each one by its remote (`git -C <dir> remote get-url origin`,
  ignoring case) in the working directory and the directory above it. Do not
  assume a home directory, and do not trust a directory's name alone. Below,
  `MegaNet/`, `RPi_ALERT/` and `flood-net-private/` mean wherever those clones are.
- If one is missing, attach it with `add_repo` (push access) when this session
  has that tool, and clone it shallow to the path `add_repo` gives you. A
  session without `add_repo` cannot attach anything; carry on with what it has.
- In each clone run `git fetch --depth=300 origin main && git checkout -B main
  origin/main`. It is a fresh checkout with nothing local to keep. The bounded
  fetch gives step 2a enough history, and some proxies refuse `--unshallow`.
- For GitHub, use the `mcp__github__*` tools (`list_issues`, `issue_write`,
  `add_issue_comment`); load them with ToolSearch if they are deferred. `gh`
  may not be signed in (it was not on 25/10/2026), and GraphQL is blocked, so
  `gh issue …` fails. `gh api` with a REST path is the fallback.
- **If `flood-net-private` cannot be reached** (it is not cloned and cannot be
  attached, the clone fails, or its issues cannot be read), do not stop and do
  not look for another home for findings. Carry on with the review and with
  step 4. Then put the findings only in your final summary for the owner: the
  exact error first, then each finding with the title and body you would have
  filed. Never write findings to MegaNet, RPi_ALERT, a gist, a public artifact
  or any other repository. Skip step 5 (there is nowhere to log).
- **If MegaNet or RPi_ALERT is missing**, review the one you have and say in
  the summary which was missing and why.
- Read `flood-net-private/security/scan-log.md`. Its last entry names the
  commit of each repository the previous run reviewed and the theme it took.
- List the open issues in `flood-net-private` labelled `security-scan`, so you
  do not file one twice and step 4 knows what is waiting.
- `flood-net-private/security/` also holds `coverage.mjs`, which step 2b uses,
  and `README.md`, which explains the rest: the findings register a workflow
  keeps, and the weekly report a separate scheduled task sends the owner.

## 2. Review

Three passes, in this order. Below, `PRIV` is the flood-net-private clone and
`SCRATCH` a scratch folder of your own.

**a. What changed.** In each public repository, `git log` and `git diff` from
the last reviewed commit to `main`. Use the last week if there is no log entry
or the commit is gone: MegaNet's history may have been rewritten (#239). Read
every changed code file, migration, workflow, script and unit file with the
questions in *What to look for* below in mind.

**b. Line by line: the files the picker hands out.** Each run reads a fixed
amount of code in full, the front door most often, and records what it read,
so over the weeks the review reads everything and the owner can see how much
it has. That is far more than one session can read, so reader subagents share
it, all at once. Do not shrink this pass to save time: before it existed, runs
"read" a 140,000-line area in under three minutes.

1. Run `node PRIV/security/coverage.mjs pick --meganet MegaNet --rpi RPi_ALERT
   --out SCRATCH/pick.json`. It prints the readers' slices: about 40,000 lines
   in all, at most 8,000 to a reader, taken from files never read, changed
   since last read, or due again (`PRIV/security/scope.json` says how often).
2. Start one reader per slice with the Agent tool, **all in one message** so
   they run side by side. Give each the prompt below, filled in.
3. When they are back, verify every candidate yourself before step 3: open the
   lines, trace the path, run a check where that settles it. A reader's "sure"
   is not proof.
4. Run `node PRIV/security/coverage.mjs record --meganet MegaNet --rpi
   RPi_ALERT --pick SCRATCH/pick.json --skip <files a reader listed as not
   finished, comma-separated>`. It updates `PRIV/security/coverage.json` and
   prints the `Depth:` line for the log. A skipped file stays due next week.

The reader prompt:

> You are one reader in the weekly security review of <repository> at commit
> <commit>, checked out at <path>. Read every line of these files with the
> Read tool, in chunks of up to 2,000 lines; do not skim with grep:
> <the slice's files, one a line>
>
> What to look for: <every entry of *What to look for* below that covers these
> files, pasted in full>, and plain correctness bugs.
>
> Rules: this is a code review, not a penetration test. Send no request to the
> live site, the Worker, Supabase, GitHub or a base station. Never copy a site
> code, key, token, password or a landholder's details into your answer; name
> the file and line instead.
>
> Answer with these three parts and nothing else:
> READ IN FULL: the files you read every line of.
> NOT FINISHED: the files you did not, or "none".
> CANDIDATES: for each, file:line · what an outsider, a lower-privileged
> account or a device on the Pi's network controls · the path from there to
> the harm · how sure you are · a proposed fix. Or "none". Only what you can
> make concrete: a short list of real problems beats a long list of maybes.

**c. This week's theme.** One question that cuts across files. Take the theme
after the last log entry's `Theme:` number, wrapping round (start at 1 if the
last entry has none). Work it yourself, or with one more subagent, reading
whatever files it needs whether or not the picker chose them.

1. **The link, Flood-Net to the Pi.** Read the Base Stations tab's remote
   management (`base-stations.js`; migrations `0049`, `0068`, `0080`, `0081`)
   against the Pi's `lib/remote.js` and `lib/access.js`. Who in MegaNet can
   change a Pi's settings, restart it, install an update or add an SSH key?
   Can a MegaNet account, or anyone holding MegaNet, reach further into a Pi
   than RPi_ALERT's `docs/remote-management.md` and `docs/access.md` say?
2. **The link, the Pi to Flood-Net.** Read `ingest_http()`,
   `report_ingest_point()`, `report_receptions()`, the check-in, and token
   requests and their approval (`0007`, `0012`, `0017`, `0045`–`0049`, `0053`;
   `admin-tokens.js`) against the Pi's `lib/uplink.js`, `lib/meganet.js` and
   `lib/token-request.js`. What can a stolen or hostile Pi token write? Can one
   Pi speak for another Pi or for a station? Do a Pi's strings reach
   `innerHTML` in MegaNet's Base Stations tab, Message Log or Reception Map?
   And the vendored decoders: `agent/vendor/meganet/` holds MegaNet's
   `alert-dsp.js`, `quansheng.js`, `alert2.js` and `serial-gps.js`, kept in
   step by `scripts/sync-meganet.sh`. Whatever those files do, every Pi does
   once they are synced.
3. **The read-only API and the database's grants.** Is `worker/api.js` still
   read-only by construction: only GETs, only `READABLE_RELATIONS`, nothing of
   the caller's request forwarded upstream? Does every grant to `anon` and
   `authenticated` in `db/migrations/` match what `db/README.md` calls public,
   and does every table have row-level security? Does every `security definer`
   function set `search_path`, revoke from public and check its caller? Are
   site codes readable only by approved accounts (`0064`)?
4. **Private data.** The whole of MegaNet and RPi_ALERT for landholder contact
   details, site codes, keys or tokens committed in files, fixtures or docs
   (`git grep` for key shapes such as `eyJ`, `sk_`, `sb_secret` and
   `-----BEGIN`, leaving out `archive/`'s base64). Do not dig through old
   history (#239).
5. **Workflows, secrets and the release path.** Both repositories'
   `.github/workflows/`: script injection from event fields,
   `pull_request_target`, secrets reaching logs (logs here are public),
   over-broad `permissions`, unpinned third-party actions; whether
   `RELEASE_SIGNING_KEY` can reach a log or a pull request's job; whether
   anything can put code on a Pi that is not a signed release without a person
   at the Pi asking for it (`os/libexec/rpi-alert-update`,
   `verify-release.js`).

**What to look for, by part.** Paste the entries that cover a reader's files
into its prompt.

*MegaNet*

- `worker/`: the agent API (`api.js`) must stay read-only by construction:
  only GETs, only `READABLE_RELATIONS`, nothing of the caller's request
  forwarded upstream. The access gate and token exchange in `index.js`,
  `photos.js`, `briefing.js`. CORS, headers, rate limits, error bodies that
  leak.
- `db/migrations/`: row-level security on every table, grants to `anon` and
  `authenticated` against what `db/README.md` calls public, `security definer`
  functions (search_path set? caller checked?), site codes readable only by
  approved accounts (`0064`).
- Root `*.js` and the `.html` pages: `innerHTML` and friends fed data from the
  network, the database, files or URLs; `eval` / `new Function`;
  `postMessage` handlers; tokens kept in storage. `auth.js` and `admin*.js`:
  who may do what. `index.html`, `sw.js` and `_headers`: CSP and friends, what
  the service worker caches and serves.
- `bridge/` and `sdr-pi/`: MQTT and HTTP ingest. Authentication of
  publishers, input validation, what a malformed or hostile packet can do,
  secrets in config, the Dockerfile.
- `.github/workflows/` and `tools/`: script injection from event fields,
  `pull_request_target`, secrets reaching logs (logs here are public),
  over-broad `permissions`, unpinned third-party actions; ingest tools that
  could write private data into this public repository.

*RPi ALERT*

- `agent/`: the dashboard and settings server (`lib/web/server.js`,
  `lib/web-password.js`): what anyone on the Pi's network, or on its own Wi-Fi
  hotspot, can read or change without the web password; cross-site requests
  and DNS rebinding against `rpi-alert.local`; path handling for static
  files. The boot-partition settings (`lib/bootconf.js`): what a hostile
  `rpi-alert.conf` can do. The receivers (`lib/devices/`, `lib/serial/`): what
  a malformed or hostile burst, serial line or NMEA sentence makes the agent
  do. The pages (`web/`): `innerHTML` fed station names, decoded text or
  anything that came from MegaNet. `lib/remote.js`, `lib/access.js`,
  `lib/uplink.js`, `lib/meganet.js`, `lib/token-request.js`: what MegaNet can
  make the Pi do, and what the Pi sends it.
- `os/`, `build/`, `site/`, `agent/bin/`, `.github/workflows/`:
  `os/files/sudoers/` and `os/libexec/rpi-alert-priv`: every verb's argument
  checks. `agent/bin/rpi-alert-access`: who can add an SSH key, and from
  where. The updater (`os/libexec/rpi-alert-update`, `verify-release.js`):
  whether anything can install code that is not a signed release without a
  person at the Pi asking for it. `install.sh`, `bootstrap.sh`, systemd units,
  udev, PAM and the kiosk. The workflows: whether `RELEASE_SIGNING_KEY` can
  reach a log or a pull request's job, `permissions`, and unpinned actions.
  The set-up page (`site/`) and what it writes onto a card.

Also look for bugs. If you find something on the way that is plainly a
correctness bug rather than a security one, file it too, at a lower severity.

Before filing, try to prove each finding: trace a concrete path from something
an outsider (or a lower-privileged account, or a device on the Pi's network)
controls to the harm. Run the repositories' own checks or a small local script
where that settles it. RPi_ALERT's tests are `cd RPi_ALERT/agent && node --test
test/*.test.js`. A few of them need `socat` or `sshd`, and failing for want of
those is not a finding. Do not send any request to the live site, the Worker,
Supabase, GitHub releases or a base station: this is a code review, not a
penetration test. Drop what you cannot make concrete. A short report of real
findings beats a long list of maybes.

## 3. File

For each finding, open one issue in `cdomotor-g/flood-net-private` with
`mcp__github__issue_write` and the label `security-scan`. One finding per
issue: don't add other findings to an issue's body as extra notes, because
step 4 closes an issue when its fix lands and anything else in it is lost.

- Title: `[Standalone] [<Model>/<Effort>] <severity> (<repo>): <short
  description>`. Severity is one of `Critical`, `High`, `Medium`, `Low` or
  `Bug`. Repo is `MegaNet`, `RPi_ALERT` or `both`. Write model and effort as
  `CLAUDE.md` describes; use `[Human]` instead when only a person can fix it,
  for example by rotating a key, changing a setting or applying something to
  the live database.
- Body: the first line is `Recommended: <Model> / <Effort>`. The second is
  `Plain words: <one sentence the owner, who is not a software engineer, can
  read on a phone: what could go wrong, and for whom>`, with no file names,
  jargon or anything private. The weekly report quotes it. Then give:
  - where it is (repository, file:line at the commit you reviewed);
  - what an attacker or user can do;
  - the path you traced;
  - a proposed fix.

  Never quote a site code, key, token or a landholder's details, even when the
  finding is that one is exposed. Name the file and line instead.

If an open `security-scan` issue already covers it, comment there only if you
have something new. If a fix has landed for an open one, comment on it with the
commit and close it.

If this session has no GitHub tool that can open issues, write each finding
instead as `security/findings/<YYYY-MM-DD>-<slug>.md` in `flood-net-private`
(same title and body), and say so in the log entry. They go up with the log's
commit.

Never open an issue or comment in MegaNet or RPi_ALERT: both are public, and an
issue describing a hole publishes it before it is fixed. The only thing this
run puts in them is step 4's fixes.

## 4. Fix

Work through every open `security-scan` issue in `flood-net-private`, most
severe first. That means the ones you filed in this run and any earlier ones
still open. Skip an issue whose title carries `[Human]`, and one labelled
`hold` (the owner's way of keeping this step off it). Skip one labelled
`needs-owner` too, unless the owner has answered on it since: a comment
without the *Generated by Claude Code* footer, newer than the label. Then do
what the answer says, as far as this step's rules allow, and say on the issue
what is left.

Fix an issue in this step only when all of these hold:

- the change is to MegaNet's or RPi_ALERT's code, tests, workflows or docs, and
  you can say in one sentence what it changes;
- it needs no migration applied to the live database, no deploy, no secret, key
  or setting changed, and no RPi_ALERT release;
- you can show that it works: a check or test that fails before the change and
  passes after it, or a small local script that shows the path is closed, with
  the repository's own checks green.

Otherwise, comment on the issue with the fix you propose and why this step left
it, then leave the issue open. In the comment, put the migration in full, or
name the setting to change or the key to rotate. A finding that needs a
migration is the usual case. The owner applies it from an interactive session
(`fix flood-net-private#N`), which can run `db-migrate.yml`.

Every issue this step leaves open for the owner gets the label `needs-owner`
and, in its body just under `Plain words:`, a line `Needs from the owner:
<what to decide or do, in plain words, and exactly what to say or click>` —
for a migration, `say "fix flood-net-private#N" in a Claude Code session on
MegaNet`; for a decision, the choice, and that a reply on the issue is enough.
The weekly report reads that line to the owner, so an issue without it sits
unseen. Give an older open issue that lacks `Plain words:`, `Needs from the
owner:` or the label the same treatment.

How to make the fix:

- **MegaNet.** Follow its `CLAUDE.md` exactly. Run the cheap checks and the
  check for the area you touched before pushing. If you changed an app file,
  bump the version stamp last. Run `git pull --rebase origin main` before the
  push. Push straight to `main`, with no branch and no pull request.
- **RPi_ALERT.** Read its `CLAUDE.md`. Run `node --check` on every JS file you
  changed and `cd agent && node --test test/*.test.js` (see
  `.github/workflows/test.yml`), plus `shellcheck` on changed shell scripts if
  it is installed. Push straight to `main`, with no branch and no pull request.
  This is the owner's standing rule for both repositories.
  - Never tag a release, run `build-image.yml` or touch
    `os/release-signing-key.pem`. Base stations install only signed releases,
    so a fix reaches them when the owner cuts the next release. The summary
    says when one is due.
- **The vendored decoders.** A fix to `alert-dsp.js`, `quansheng.js`,
  `alert2.js` or `serial-gps.js` goes into MegaNet first. Then run
  `RPi_ALERT/agent/scripts/sync-meganet.sh <path to MegaNet>` and push
  RPi_ALERT as well.
- **Commits and pushes.** Make one commit per finding, so each can be reverted
  on its own. Push each repository once, at the end of this step: every
  MegaNet push starts a 20-minute smoke run. Before pushing, re-read your diff
  as an attacker would. Did the fix close the path, and did it open another?
- **Public commit messages** say what changed, not how it could have been
  abused. Never name the private repository, an issue in it, or a severity.
  For example, write "Worker: reject photo paths outside the record's own
  folder", not "Fix path traversal that let anyone read every photo".
- Don't wait for CI after pushing. MegaNet's CI doctor looks at it.
- On each issue you fixed, comment with the repository, the commit and one
  line on what changed, then close it as completed. If a push was refused,
  comment with the exact refusal and leave the issue open.

## 5. Log

Append to `flood-net-private/security/scan-log.md` (create it, with a one-line
heading, if missing):

```
## <YYYY-MM-DD> — MegaNet <commit, short> · RPi_ALERT <commit, short>
Theme: <number and name> · Depth: <N> files, <M> lines by <K> readers
Filed: #N (or none) · Updated: #N (or none) · Fixed: #N → <repo> <commit>; part of #N → <repo> <commit> (or none) · Left open: #N, why (or none)
<one or two lines on what you looked at and found nothing in, if anything notable>
```

The date is Brisbane's (`TZ=Australia/Brisbane date +%F`). Copy the `Depth:`
line `coverage.mjs record` printed. Keep the labels and the `#N → <repo>
<commit>` shape exactly: `report.mjs` and `register.mjs` read them.

Commit `security/scan-log.md` and `security/coverage.json` together and push
straight to `main` of `flood-net-private` (`git pull --rebase` first). That is
the run's only commit there. A workflow then rebuilds the findings register
(`security/findings.md`); don't edit it by hand.

## 6. Summary

Finish with a short summary for the owner:

- the commits you reviewed, the theme, and the `Depth:` line (with any files
  a reader could not finish);
- the issues filed, fixed (with their commits) and left open, with why;
- what needs the owner. That covers migrations to apply, keys or settings to
  change, and whether RPi_ALERT's `main` now has fixes that its latest release
  lacks. A shallow clone has no tags: find the newest with `git ls-remote
  --tags origin 'v*'`, fetch it, and compare it with `main`. If `main` is
  ahead with fixes, say the base stations need a new release.

The owner also gets a weekly report, about two hours after this run, from a
separate scheduled task ("Flood-Net security report", which prints
`flood-net-private/security/report.mjs` in a standing chat). It is built from the log, the issues
and `coverage.json`, so getting those right matters more than this summary.
