---
name: deepseek-consult
description: Consult DeepSeek for architectural review, code feedback, design exploration, or second opinions. Use when the operator requests a multi-turn conversation with DeepSeek, or when an independent perspective would strengthen a design decision.
---

a

## Invocation

```bash
# First turn (new conversation):
DEEPSEEK_API_KEY=$(grep '^DEEPSEEK_API_KEY=' $HOME/Projects/playpen/.env.host | cut -d= -f2-) \
  pi --provider deepseek --model deepseek-v4-pro --print "<prompt>"

# Continuation turns (same conversation):
DEEPSEEK_API_KEY=$(grep '^DEEPSEEK_API_KEY=' $HOME/Projects/playpen/.env.host | cut -d= -f2-) \
  pi --provider deepseek --model deepseek-v4-pro --print --continue "<follow-up>"
```

**API key:** `DEEPSEEK_API_KEY` in `$HOME/Projects/playpen/.env.host`
**Model:** `deepseek-v4-pro`
**Flags:** `--print` (stdout, no TUI), `--continue` (resume prior conversation)
**Timeout:** 180s (responses take 60-90s for thorough prompts)

## When to use

- Operator says "get DeepSeek's opinion", "check with DeepSeek", "let's ask DeepSeek"
- Design decisions benefiting from an independent architectural perspective
- Code review where fresh eyes catch assumptions
- Exploring trade-offs before committing to an implementation direction
- Multi-turn deep dives (6-10 turns) progressively narrowing from problem space to punch list

## Prompt crafting

1. **Context is king.** DeepSeek has no session memory. Every turn must be self-contained. Include: what the system is, what's built, the specific question.
2. **Reference code inline.** DeepSeek can't read files. Paste signatures, types, or critical 5-10 line snippets. Don't paste whole files — summarize and quote.
3. **End with a concrete question.** "Which of these two approaches, and what are the failure modes?" beats "what do you think?"
4. **Directive controls verbosity.** "Be terse" → punch list. "Be thorough" → architecture essay. "Walk me through X step by step" → execution trace.
5. **`--continue` is stateful.** Each turn builds on the previous. Don't repeat context — build on it.

## Session pattern

```
Turn 1: "Here's the system. Here's the problem. N specific questions."
Turn 2: "Good on Q3/Q4. Restate Q1/Q2 (they were clipped)."
Turn 3: "Follow-up: implementation path for what you proposed..."
Turn 4: "How does this compose with [existing system X]?"
Turn 5: "Walk me through [specific example] end-to-end."
Turn 6: "Last turn — synthesize into a concrete plan."
```

## Operator preferences

- Prefers multi-turn (6-10 turns) that progressively deepen
- Start broad, narrow to specifics, end with an execution plan
- DeepSeek's code examples = design sketches, not copy-paste
- Operator may inject mid-conversation with additional context — incorporate into next turn
- When operator says "N turns" — that's a budget, honor it

## Evidence checklist (required for model/training consultations)

Before sending any prompt about model quality, training results, or recipe changes, include ALL of:

1. **Functional test output** — demo preset results (6 addresses, JSON or XML). Aggregate metrics without functional evidence are insufficient to conclude.
2. **Tokenizer version** — state explicitly when comparing models. Different tokenizers invalidate F1 comparisons.
3. **Raw BIO output** — not just `decodeAsJson` (which drops all-O spans). Use XML format to show coverage gaps.
4. **What-changed matrix** — for multi-variable comparisons, list each parameter that changed between the two configs.

### Verify-before-concluding guard

Add a penultimate turn to every model-quality session:

> "Before concluding — did we verify against functional tests? Do metrics and functional tests agree? If not, which do we trust?"

This prevents the "do not ship" verdict that was wrong for v0.5.3 — DeepSeek recommended reverting based on the same invalid F1 comparison.

## Failure modes

- **Hangs:** API key may have expired. Check `.env.host`.
- **Empty response:** DeepSeek occasionally returns zero-byte output. Retry with a shorter prompt. On repeated failures, check API key validity: `curl -s https://api.deepseek.com/v1/models -H "Authorization: Bearer $DEEPSEEK_API_KEY" | head -1`
- **Truncated start:** `--print` sometimes clips first lines. Use `--continue` to ask for restatement.
- **Generic answers:** Prompt lacked code context. Add file paths, types, and the specific constraint that makes this non-trivial.
- **Timeout:** For very long prompts, use `run_in_background: true` and check output file when notified.

## Cross-session continuity

DeepSeek has no memory across conversations. When a session produces important conclusions, save them to a reference file that the next session can include:

```bash
# After a productive session, save key conclusions:
echo "## DeepSeek session $(date +%Y-%m-%d) — <topic>
- Conclusion 1
- Conclusion 2
" >> docs/articles/evals/deepseek-session-notes.md
```

Then include the file content in the next session's first prompt.

## Output handling

- `pi --print` writes to stdout (captured by shell tool)
- For long responses: `2>&1 | tail -N` to get the end
- Background mode: output written to task file, read when notification arrives
- Save valuable responses to docs or design files — DeepSeek conversations don't persist
