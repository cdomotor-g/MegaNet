# Weekly security review

A scheduled Claude Code task (Settings → Scheduled tasks on claude.ai/code,
"Flood-Net weekly security review") starts a fresh cloud session every Monday
morning, Brisbane time. The session reads `brief.md` in this directory and does
what it says. It reviews this repository and
[`cdomotor-g/RPi_ALERT`](https://github.com/cdomotor-g/RPi_ALERT) the way a
security reviewer would, and files what it finds as issues in the **private**
`cdomotor-g/flood-net-private` repository, never here. Then it fixes what it
safely can and pushes the fixes to `main`.

**Why RPi ALERT is in the same review.** The two trust each other. A base
station posts readings with its own ingest token, and it takes settings,
restarts, updates and team SSH keys from the Base Stations tab. So a hole on
either side can be a way into the other. One of the review's areas reads the
link from both ends at once.

**Why a person-style review as well as CodeQL** (`.github/workflows/codeql.yml`).
CodeQL matches known-dangerous patterns. It cannot tell that the agent API has
stopped being read-only, that a migration granted `anon` a table `db/README.md`
does not list as public, or that a site code slipped into a fixture. Those are
the rules in `CLAUDE.md`, and checking them takes reading.

**Why findings go to the private repository.** Both code repositories are
public, and an issue describing a hole publishes it before it is fixed
(`SECURITY.md`).

## The scheduled task's settings

- **Repositories.** The task needs all three attached: `cdomotor-g/MegaNet`,
  `cdomotor-g/RPi_ALERT` and `cdomotor-g/flood-net-private`. A scheduled run
  cannot attach a repository by itself. The run on 25/10/2026 had no
  `add_repo` tool, so it reviewed MegaNet from an anonymous clone and could not
  file anything.
- **Approvals: Automatically approve.** The run pushes to three repositories,
  and a scheduled run has nobody there to click an approval. With approvals on,
  it stops at the first one; the first run, 19/10/2026, ended after about a
  minute without a review.
- If it ever cannot reach the private repository anyway, the brief tells it to
  put the findings in its final summary, which only the owner sees, and never
  anywhere public.

## Changing what it looks at

Edit `brief.md` and push. Each run reads it fresh from `main`, so the scheduled
task itself never needs touching. The schedule and the task's prompt are on
claude.ai/code under Scheduled tasks.

## What it fixes, and what it leaves for you

Findings are issues in `flood-net-private` labelled `security-scan`. In the same
run, after filing, it works through every open one, most severe first. It fixes
an issue when the fix is a change to MegaNet's or RPi_ALERT's code that it can
test. It pushes that fix straight to `main`, comments on the issue with the
commit, and closes the issue. Public commit messages say what changed, but not
how it could have been abused.

It leaves an issue open, with the fix written out on it, when the fix needs any
of these:

- **A migration on the live database.** It drafts the migration on the issue.
  To apply it, start a Claude Code session on this repository and say "fix
  flood-net-private#N".
- **A key, secret or setting changed** (Supabase, Cloudflare, GitHub). These
  issues are titled `[Human]`.
- **An RPi ALERT release.** A fix on RPi_ALERT's `main` reaches base stations
  only in a signed release, and the run never cuts one. Its summary says when
  `main` has fixes the latest release lacks. To release, bump
  `agent/package.json`'s version on RPi_ALERT, then run Actions → build-image
  → Run workflow with the matching `v…` tag (RPi_ALERT's README, *Developing*).

Every issue it leaves for you is labelled `needs-owner` and says, on a
`Needs from the owner:` line, what to decide or do. For a decision, a reply on
the issue is enough: the next run reads it and acts on it.

To keep the run's hands off an issue, label it `hold`, or put `[Human]` in its
title. Any issue can still be fixed by hand: start a session on the repository
the issue is about and say "fix flood-net-private#N".

## How deep it reads

The code is far bigger than one session can read in a morning: about 375,000
lines here and 16,000 in RPi ALERT. Until November 2026 each run named an area
and "read" it in a few minutes, which in practice meant skimming. Now each run
also reads about 40,000 lines line by line, split between up to six reader
subagents working side by side, and records which file versions it has read
(`security/coverage.mjs` and `scope.json` in the private repository). The
front door (the Worker, sign-in and admin pages, ingest, workflows, the Pi's
web server, updater and root helpers) is read again every four weeks, the rest
every three to six months, and anything changed since its last reading is due
straight away. On top of that each run takes one theme that cuts across files,
in turn: the link from Flood-Net to a Pi, the link from a Pi to Flood-Net, the
read-only API and the database's grants, private data, and workflows and the
release path. This costs several times what the skimming did (that was about
US$0.70 a run).

## What you hear, and where it is kept

- **A weekly report on your phone**, from the scheduled task "Flood-Net
  security report", about two hours after the review: whether the review ran
  and how much it read, what it found and patched that week, what is waiting
  on you, and the running totals. It prints `security/report.mjs` from the
  private repository, so it is the same every week and costs almost nothing.
  If the review stops running, the report says so.
- **The findings register**, `security/findings.md` in the private repository:
  every finding ever filed, in plain words, with its fix. A workflow there
  (`security-register.yml`) rebuilds it whenever a `security-scan` issue
  changes.
- **The run's log**, `security/scan-log.md` in the private repository: which
  commit of each repository a run reviewed, its theme and depth, and what it
  filed, fixed and left open.
