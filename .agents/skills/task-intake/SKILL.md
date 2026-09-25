---
name: task-intake
description: Use for an authorized implementation or training arc expected to produce a PR or require a handoff. Creates the GitHub issue from the repo's issue-form fields, seeds its task list, and links the session so todo updates mirror into the issue. Do not create an issue for review, diagnosis-only work, or local exploration unless the operator asks for one. The todo list is the working plan; the issue is the durable copy the operator reads.
---

## Why this exists

The operator follows autonomous work through GitHub rather than the session transcript. A plan kept only
in the session must be reconstructed after a context reset or handoff. For authorized implementation and
training work, create the issue and its task list before changing the repository. The hook then copies
todo progress into that issue.

## When to use

Use this skill for an authorized implementation or training arc expected to produce a PR or require a
handoff. Do not create an issue for review, diagnosis-only work, or local exploration unless the operator
asks for one. The number of steps does not grant permission to write to GitHub.

## Step 1 — write the plan as a todo list FIRST

State the steps before touching anything. Use the development MCP for every client:

- **Codex:** The issue's task list is the durable task list. Update it with the `mwdev_issue`
  `update_tasks` action as work completes. Codex lifecycle events do not expose Claude Code's
  `TodoWrite` payload to this repository's synchronization hook.
- **Claude Code with `TodoWrite`:** Use `TodoWrite`; the hook below mirrors its list into the linked
  issue automatically.
- **Claude Code without task tools:** Keep the issue's task list current with the `mwdev_issue`
  `update_tasks` action. Enabling the task tools through `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is an
  operator decision.

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
`packages/dev-mcp/lib/hooks/todo-issue-sync.ts` PostToolUse hook rewrites the marker-delimited block after
`TodoWrite`. Codex and Claude Code sessions without `TodoWrite` use the issue tool.
The hook's interface is:

- **Fail-open and silent** — it never blocks a turn, and the `gh` work runs detached.
- **Markers required** — it never writes into an issue whose body lacks both
  `<!-- todo-sync:begin -->` and `<!-- todo-sync:end -->`; absent markers mean the issue was not
  shaped by this skill, and rewriting it would clobber prose.
- **`TodoWrite` only** — `TaskCreate`/`TaskUpdate` carry deltas a stateless hook cannot fold into a
  list; in those sessions update the issue at milestones by hand.
- **One link per checkout** — `.claude/state/linked-issue` is last-writer-wins; concurrent sessions
  in one checkout should not both link. Worktrees have their own state dir and do not collide.

## Step 4 — close out

- Check every box, or say on the issue why a box stays open. An unchecked box with no comment reads
  as forgotten rather than deferred.
- Call `mwdev_pull_request` with `action: create` and the issue number. The tool verifies the issue's task
  list, creates a Vale-checked body that says `Closes #<n>`, and starts a tracked CI monitor.
- Unlink: `rm -f .claude/state/linked-issue`.
