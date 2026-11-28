---
name: task-intake
description: Use when the operator asks for a tracking issue, or for a multi-session arc that a later session must resume. Creates one GitHub issue from the repo's issue-form fields, seeds its task list, and links the session so todo updates mirror into the issue. One feature gets one issue and one pull request. Never split a feature into sub-issues or create an issue only to open a PR.
---

## Why this exists

A plan kept only in the session must be reconstructed after a context reset or handoff. An issue holds
that plan where the operator and a later session can read it. The hook copies todo progress into it.

## When to use

Use this skill when the operator asks for an issue, or when the work spans sessions and a later session must
pick it up. A single-session change opens its pull request without an issue. Never create an issue for
review, diagnosis-only work or local exploration. One feature gets one issue at most and one pull request:
don't split it into sub-issues, and don't open a second issue for its CI or follow-up tasks.

## Step 1 — write the plan as a todo list FIRST

State the steps before touching anything. Use the development MCP for every client:

- **Codex:** The issue's task list is the durable task list. Update it with the `mwdev_issue`
  `update_tasks` action as work completes. Codex lifecycle events do not expose Claude Code's
  `TodoWrite` payload to this repository's synchronization hook.
- **Claude Code with `TodoWrite`:** Use `TodoWrite`; the hook below mirrors its list into the linked
  issue automatically.
- **Claude Code without task tools:** Keep the issue's task list current with the `mwdev_issue`
  `update_tasks` action. The operator decides whether to enable the task tools through
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.

## Step 2 — create the issue from the template's fields

Call `mwdev_issue` with `action: create`. Supply the feature-request fields `title`, `area`, `change`,
`evidence`, `scope`, `tradeoff`, and `tasks`. The tool applies the `enhancement` and area labels,
generates the marker-delimited task list, rejects a body that fails Vale, creates the issue, and links
the checkout.

For a bug, the headings are: `Failing input` (exact string, original spelling), `Expected result`,
`Observed result`, `First stage that diverges`, `Evidence and scope`, `Artifacts under test`,
`Reproduction`, `Why chain` — the five-whys skill governs that last one.

## Step 3 — link the session

The issue tool writes `.claude/state/linked-issue`. The `.claude/state` name is shared integration state
rather than a Claude Code-only instruction. Claude Code's
`lib/dev-mcp/hooks/todo-issue-sync.ts` PostToolUse hook rewrites the marker-delimited block after
`TodoWrite`. Codex and Claude Code sessions without `TodoWrite` use the issue tool.
The hook's interface is:

- **Fail-open and silent** — it never blocks a turn, and the `gh` work runs detached.
- **Markers required** — it never writes into an issue whose body lacks both
  `<!-- todo-sync:begin -->` and `<!-- todo-sync:end -->`; absent markers mean the issue was not
  shaped by this skill, and rewriting it would clobber prose.
- **`TodoWrite` only** — `TaskCreate`/`TaskUpdate` send deltas a stateless hook cannot fold into a
  list. In those sessions, update the issue at milestones by hand.
- **One link per checkout** — `.claude/state/linked-issue` is last-writer-wins, so concurrent sessions
  in one checkout shouldn't both link. Worktrees have their own state dir and do not collide.

## Step 4 — close out

- Check every box, or say on the issue why a box stays open. An unchecked box with no comment reads
  as forgotten rather than deferred.
- Run the touched tests, lint and Vale locally on the final head, and read each exit status from its log.
- Call `mwdev_pull_request` with `action: create` and the issue number. The body contains `Closes #<n>`.
- Merge with `mwdev_pull_request` `action: merge` without waiting for CI. It refuses only a closed pull
  request or one that conflicts with its base, and it returns the CI state it merged under in
  `checksAtMerge`. State that CI state in the report.
