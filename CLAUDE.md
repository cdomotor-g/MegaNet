# Instructions for Claude Code

## Git workflow
- Push straight to `main` after a patch. Do not ask for permission and do not open a pull request.
- Never create branches unless explicitly asked to.
- If human tasks remain, or fall out of scope, at the end of your work: ask whether to create a new issue tagged red label `human`, with explicit, click-by-click instructions for what the human needs to do.
- When you finish work that closes an issue, close it with a comment summarizing what was done.

## Raising issues for AI agents
- If a new issue is something an AI coding agent (e.g. Claude Code) could pick up and complete, recommend a model and effort level for it.
- Put the recommendation as a tag at the very start of the issue title, so it's visible at a glance in issue lists — no need to open the issue to see it. Format: `[<Model>/<Effort>] <title>`.
  - Model abbreviations: `Opus5`, `Sonnet5`, `Haiku4.5`, `Fable5`
  - Effort abbreviations: `Low`, `Med`, `High`, `XHigh`, `Max`
  - Example: `[Sonnet5/Med] Fix flaky login test`
- Also restate the recommendation on the first line of the issue body (e.g. `Recommended: Sonnet5 / Med`), with a short reason if the choice isn't obvious.
- Issues tagged red label `human` (per the rule above) don't need a model/effort tag — they're not meant for an AI agent.
