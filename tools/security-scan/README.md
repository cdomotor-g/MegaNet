# Weekly security review

A scheduled Claude Code task (Settings → Scheduled tasks on claude.ai/code,
"Flood-Net weekly security review") starts a fresh cloud session every Monday
morning, Brisbane time. The session reads `brief.md` in this directory and does
what it says: review the code like a security reviewer, and file what it finds
as issues in the **private** `cdomotor-g/flood-net-private` repository, never
here.

Why a person-style review as well as CodeQL (`.github/workflows/codeql.yml`):
CodeQL matches known-dangerous patterns. It cannot tell that the agent API has
stopped being read-only, that a migration granted `anon` a table `db/README.md`
does not list as public, or that a site code slipped into a fixture. Those are
the rules in `CLAUDE.md`, and checking them takes reading.

Why findings go to the private repository: this one is public, and an issue
describing a hole publishes it before it is fixed (`SECURITY.md`).

## Changing what it looks at

Edit `brief.md` and push. Each run reads it fresh from `main`, so the scheduled
task itself never needs touching. The schedule and the task's prompt are on
claude.ai/code under Scheduled tasks.

## Fixing a finding

Findings are issues in `flood-net-private` labelled `security-scan`. To fix
one, start a Claude Code session on this repository and say "fix
flood-net-private#N". The fix goes to `main` like any other patch, with a
commit message that says what changed but not how it could have been abused;
the session then closes the private issue with the commit. Anything that needs
a person (rotating a key, a Supabase setting) is marked `[Human]` on the issue.

The run's ledger — which commit each run reviewed and which area it went deep
on — is `security/scan-log.md` in the private repository.
