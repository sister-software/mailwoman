---
name: deepseek-consult
description: Consult DeepSeek for architectural review, code feedback, design exploration, or second opinions. Use when the operator requests a multi-turn conversation with DeepSeek, or when an independent perspective would strengthen a design decision.
---

Consult DeepSeek through the `pi` agent harness via the `ds-consult.sh` wrapper.
**Always use the wrapper** — invoking `pi` directly is what caused the historical
"pi hung ~1h with no output" failures (see _Why the wrapper_ below).

## Invocation

```bash
S=.agents/skills/deepseek-consult/ds-consult.sh   # run from repo root

# First turn (new conversation, fast flash model):
"$S" "Here's the system. Here's the problem. N specific questions."

# Continuation turns (same conversation, stateful):
"$S" -c "Follow-up that builds on the last answer."

# Deeper turn — escalate to the pro reasoner (slower, timeout-guarded):
"$S" --pro -c "Now reason carefully through the failure modes of X."

# Long prompt with pasted code? Put it in a file:
"$S" -f /tmp/consult-prompt.md
```

The **clean answer prints to stdout**; model/elapsed/session/transcript meta go to
**stderr**. Each conversation gets a stable session id; `-c` resumes the most
recent one, `-s <id>` resumes a named one, `-n` forces a fresh one. Transcripts
accumulate under `~/.cache/ds-consult/sessions/`.

Run `"$S" -h` for all flags (`--thinking`, `--timeout`, `--tools-ro`, `--raw`, `--json`).

## Why the wrapper (don't bypass it)

`pi` is a **full coding agent** (read/bash/edit/write/grep/find/ls), not a chat
pipe. Invoked as `pi --print "<question>"` it (a) runs an agentic tool loop on
hard questions and can **edit files in the repo** mid-"consult", and (b) on
`deepseek-v4-pro` at the default `--thinking medium` spends many minutes
generating a reasoning trace with **zero output** in text mode — the "hang" we
kept hitting (verified 2026-06-08: a "be thorough" prompt ran >7.6 min, 0 bytes;
the same question scoped at `--thinking low` finished in 27s). The wrapper fixes
all of this: `--no-tools` (pure reasoning, no repo writes), `-nc -ns -ne`
(isolated reviewer — no mailwoman `AGENTS.md`/skills pollution), `--mode json`
piped through `jq` (structured final answer + error detection), stable
`--session-id` (not fragile `--continue`), and a hard `timeout`.

## Model / thinking policy

- **Default = `deepseek-v4-flash --thinking low`** (~2–30s). Use it for most
  turns, iteration, and quick checks.
- **`--pro` = `deepseek-v4-pro --thinking medium`** for deep architectural turns.
  Slower (a scoped question ~50s); always timeout-guarded (300s).
- **Keep pro prompts scoped.** Pro + a sprawling "be thorough, answer all 5
  questions" prompt is exactly what hangs. Ask one hard thing at a time, or raise
  `--timeout` deliberately. A timeout exits 124 with guidance — re-scope or drop
  to flash, don't just retry.

## When to use

- Operator says "get DeepSeek's opinion", "check with DeepSeek", "let's ask DeepSeek"
- Design decisions benefiting from an independent architectural perspective
- Code review where fresh eyes catch assumptions
- Exploring trade-offs before committing to an implementation direction
- Multi-turn deep dives (6–10 turns) progressively narrowing from problem to punch list

## Prompt crafting

1. **Context is king.** DeepSeek sees only what you send. The _first_ turn must be
   self-contained: what the system is, what's built, the specific question.
2. **Reference code inline.** DeepSeek can't read your files (the wrapper runs it
   `--no-tools`). Paste signatures, types, or critical 5–10 line snippets;
   summarize and quote rather than dumping whole files. For long context use `-f`.
3. **End with a concrete question.** "Which of these two, and what are the failure
   modes?" beats "what do you think?"
4. **Directive controls verbosity.** "Be terse" → punch list. "Be thorough" →
   essay (but scope it, especially on `--pro`). "Walk me through X" → trace.
5. **Sessions are stateful.** With `-c`/`-s`, each turn builds on the prior one —
   don't re-paste context, build on it.

## Session pattern

```
Turn 1: "Here's the system. Here's the problem. N specific questions."   (flash)
Turn 2: "Good on Q3/Q4. Drill into Q1: <focus>."                          (flash)
Turn 3: "Follow-up: implementation path for what you proposed…"           (flash)
Turn 4: "How does this compose with [existing system X]?"                 (--pro)
Turn 5: "Walk me through [specific example] end-to-end."                  (--pro)
Turn 6: "Last turn — synthesize into a concrete plan."                    (flash)
```

Operator preferences: prefers multi-turn (6–10) that progressively deepen; start
broad, narrow to specifics, end with an execution plan; DeepSeek's code = design
sketches, not copy-paste; may inject mid-conversation — fold it into the next
turn; "N turns" is a budget — honor it.

## Evidence checklist (required for model/training consultations)

Before any prompt about model quality, training results, or recipe changes, include ALL of:

1. **Functional test output** — demo preset results (6 addresses, JSON or XML).
   Aggregate metrics without functional evidence are insufficient to conclude.
2. **Tokenizer version** — state it when comparing models. Different tokenizers invalidate F1 comparisons.
3. **Raw BIO output** — not just `decodeAsJson` (drops all-O spans). Use XML to show coverage gaps.
4. **What-changed matrix** — for multi-variable comparisons, list every parameter that changed.

### Verify-before-concluding guard

Add a penultimate turn to every model-quality session:

> "Before concluding — did we verify against functional tests? Do metrics and functional tests agree? If not, which do we trust?"

This prevents the "do not ship" verdict that was wrong for v0.5.3 — DeepSeek recommended reverting on an invalid F1 comparison.

## Failure modes

- **Timeout (exit 124):** the model ran past the wall-clock guard. Re-scope the
  question, drop to flash / `--thinking low`, or pass a larger `--timeout` if a
  long pro turn is genuinely warranted. Do **not** blindly retry the same prompt.
- **Empty response:** the wrapper reports it and prints the key-check command.
  Retry shorter; if it persists the key may be bad —
  `curl -s https://api.deepseek.com/v1/models -H "Authorization: Bearer $DEEPSEEK_API_KEY" | head -1`.
- **`pi exited N`:** the wrapper surfaces pi's stderr. Usually a bad flag, model
  id, or missing key in `$HOME/Projects/playpen/.env.host`.
- **Generic answers:** the prompt lacked code context. Add file paths, types, and
  the specific constraint that makes this non-trivial.

## Cross-session continuity

DeepSeek has no memory across conversations. After a productive session, distill
the conclusions into a tracked notes file beside this skill so the next session
can paste them into turn 1:

```bash
$EDITOR .agents/skills/deepseek-consult/session-notes-$(date +%Y-%m-%d)-<topic>.md
```

The raw per-turn transcripts in `~/.cache/ds-consult/sessions/*.transcript.md`
are the source to distill from (and are not committed — keep notes terse and
curated, the way the existing `session-notes-*.md` are).

## Tier-2 fallback: direct curl

If `pi` itself misbehaves (e.g. a provider/streaming bug), bypass it and hit the
DeepSeek API directly. This is the path past sessions used; keep it as a backstop,
not the default — the wrapper gives sessions, isolation, and structured output for free.

```bash
KEY=$(grep '^DEEPSEEK_API_KEY=' "$HOME/Projects/playpen/.env.host" | cut -d= -f2-)
curl -s https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"<prompt>"}]}' \
  | jq -r '.choices[0].message.content'
```

Continuation = resend the prior messages array yourself (curl is stateless).
