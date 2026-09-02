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

State the steps before touching anything. Two situations, and say which you are in:

- **The session has the task tools** (`TodoWrite`, or `TaskCreate`/`TaskUpdate`). Use them; the hook
  below mirrors `TodoWrite` into the linked issue automatically.
- **It does not** — Claude Code leaves the task tools out of sessions on Fable 5 / Opus 4.8 /
  Sonnet 5 and later by default. Then the ISSUE's task list is the todo list: keep it current with
  `gh issue edit` as steps complete. Opting a session back in is `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`
  in the session env — the operator's call, not yours.

## Step 2 — create the issue from the template's fields

The `.github/ISSUE_TEMPLATE/*.yml` forms only shape the web UI — `gh issue create` bypasses them — so
mirror their headings in the body. Bug work uses the bug-report fields, feature work the
feature-request fields. Labels: `bug` or `enhancement`, plus the Area label (the dropdown's options
are real GitHub labels).

Every issue body carries a task-list section with the sync markers:

```bash
gh issue create --label enhancement --label resolver \
  --title "Feature: <one factual line>" \
  --body "$(cat <<'EOF'
## What changes

<one sentence — the behavior after the change>

## Evidence the change is needed

<the failing example today, with the address in view and measured scope>

## Scope

<locales and tiers affected; tested contracts changed; gate or board rows touched>

## Tradeoff

<what it costs — regression risk, corpus, compute, maintenance>

## Task list

<!-- todo-sync:begin -->
- [ ] <checkable assertion>
- [ ] <checkable assertion>
- [ ] <the claim completion is judged by>
<!-- todo-sync:end -->
EOF
)"
```

For a bug, the headings are: `Failing input` (exact string, original spelling), `Expected result`,
`Observed result`, `First stage that diverges`, `Evidence and scope`, `Artifacts under test`,
`Reproduction`, `Why chain` — the five-whys skill governs that last one.

## Step 3 — link the session

```bash
mkdir -p .claude/state && echo <issue-number> > .claude/state/linked-issue
```

From here every `TodoWrite` rewrites the issue's marker-delimited block via the
`packages/dev-mcp/lib/hooks/todo-issue-sync.ts` PostToolUse hook. Its contract:

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
  as forgotten, not deferred.
- The PR body says `Closes #<n>` — the PR template asserts the linked issue's task list is checked.
- Unlink: `rm -f .claude/state/linked-issue`.
