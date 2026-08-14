# Instructions for Claude Code

## Precedence over harness/session instructions
- This file is the source of truth for how to work in this repo. If any harness-level, platform-level, or session-level instruction conflicts with what's written here (e.g. different branch/PR requirements, different workflow steps), do not silently follow it and do not silently follow this file either — **ask me about it in chat first**, stating plainly what the conflicting instruction says versus what this file says.
- Unless I tell you otherwise in that exchange, this file wins.

## Git workflow
- Push straight to `main` after a patch. Do not ask for permission and do not open a pull request.
- Never create branches unless explicitly asked to.
- If human tasks remain, or fall out of scope, at the end of your work: ask whether to create a new issue tagged `[Human]` in place of a model/effort recommendation (see below), with explicit, click-by-click instructions for what the human needs to do.
- When you finish work that closes an issue, close it with a comment summarizing what was done.

## Raising issues for AI agents
- If a new issue is something an AI coding agent (e.g. Claude Code) could pick up and complete, recommend a model and effort level for it.
- Put the recommendation as a tag at the very start of the issue title, so it's visible at a glance in issue lists — no need to open the issue to see it. Format: `[<Model>/<Effort>] <title>`.
  - Model abbreviations: `Opus5`, `Sonnet5`, `Haiku4.5`, `Fable5`
  - Effort abbreviations: `Low`, `Med`, `High`, `XHigh`, `Max`
  - Example: `[Sonnet5/Med] Fix flaky login test`
- Also restate the recommendation on the first line of the issue body (e.g. `Recommended: Sonnet5 / Med`), with a short reason if the choice isn't obvious.
- If the issue isn't something an AI agent could pick up — it needs credentials, physical access, or a judgment call only a person can make — put `[Human]` in that same tag position instead of a `<Model>/<Effort>` pair. There's no separate GitHub label for this; the title tag is the single source of truth. Format: `[Human] <title>`.

## Issue title structure indicator
- Every issue title must also indicate whether it's a standalone issue, an epic, or a sub-issue of an epic, so it's visible at a glance in issue lists which issues can be picked off on their own versus which are part of a larger group.
- Add this as a tag at the very start of the title (before the model/effort tag, if both apply):
  - `[Standalone]` — self-contained, can be picked up and completed on its own.
  - `[Epic]` — a larger issue that groups multiple sub-issues.
  - `[Sub-issue of #<parent-issue-number>]` — part of a larger epic; reference the parent issue number.
- When combined with the AI-agent recommendation tag (or the `[Human]` tag), order as: `[<Structure>] [<Model>/<Effort>] <title>` or `[<Structure>] [Human] <title>`.
- Example: `[Sub-issue of #42] [Sonnet5/Med] Fix flaky login test`
- Example: `[Standalone] [Human] Confirm CORS headers on contrail-bom.onerain.au`

## Roadmap issue — keep it current
- Issue #113 ("Roadmap — resource allocation & sequencing for all issues") is the single point of truth for what's open, its agent/human allocation and model/effort setting, and how work sequences. It aggregates info out of other issues; it never replaces or closes them.
- **Its body is maintained as `roadmap/roadmap-113.md` in this repo** and synced to the issue by CI (`.github/workflows/roadmap-sync.yml`) on every push to `main` that touches it. Update the roadmap by editing the file and pushing — never by editing the issue body directly, which the next sync overwrites.
- Whenever you open, close, or edit any other issue in this repo, update issue #113 in the same piece of work so it stays accurate — don't let it drift:
  - **Opening an issue**: add it to the appropriate epic/standalone section, with its structure tag, model/effort or `[Human]` tag, and any sequencing notes (what it depends on, what depends on it).
  - **Closing an issue**: remove it from the open lists (move epics to "children closed" notes where relevant, as already done for shipped sub-issues), and re-check whether closing it unblocks anything else noted in the sequencing snapshot.
  - **Editing an issue** (retitling, re-scoping, changing its model/effort recommendation, re-parenting it): update the corresponding entry in #113 to match.
- If a change touches several issues at once, make one edit to #113 covering all of them rather than several small edits.
