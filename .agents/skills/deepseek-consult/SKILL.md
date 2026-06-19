---
name: deepseek-consult
description: Consult DeepSeek for architectural review, code feedback, design exploration, or second opinions. Use when the operator requests a multi-turn conversation with DeepSeek, or when an independent perspective would strengthen a design decision. Includes per-category calibration (trust structure, test numbers) and an extended verify-before-concluding guard for quantitative predictions.
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

**Extended for quantitative predictions:** when DS recommends a path based on a
quantitative prediction (a threshold, a step count, a percentage), the
penultimate turn also asks for the probe that would falsify it cheaply, **and
the probe is run before the recommended path**. The exchange:

> "Before we proceed: what's the 30-minute experiment that would falsify the
> 'X clears threshold Y at step Z' prediction? If it holds, we continue down
> your path; if it falsifies, we re-scope."

Two things this catches: (a) predictions that can't be cheaply falsified
(usually too vague to act on anyway), (b) predictions DS would itself
de-weight if asked to design a falsifier. The night-shift skill's
"Diagnostic before fix" pairs with this — same probe, different framing.

## Calibration — structure vs numbers

DeepSeek's quality is **not uniform across answer types**. The mailwoman
campaign produced enough turns to characterize the asymmetry; calibrate the
next session against it:

| Contribution type                                                                                                                                                                                                    | Track record                                                               | How to weight                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Structural** — reframes, architectural alternatives, naming the problem, probe-ladder design, eliminating an option as unsound (weight-merge on from-scratch models, frozen-encoder probe, label-partition design) | strong; multiple turns where DS named the load-bearing reframe we'd missed | trust, but cross-check ethos; structural advice survives even when downstream numerics miss |
| **Procedural** — pre-registered gates, evidence checklists, "verify functional tests before concluding"                                                                                                              | strong                                                                     | apply directly                                                                              |
| **Quantitative** — predicted F1 / accuracy / step-count thresholds (e.g. "5× clears ≥72", "75 is not a transient", capacity-tell at step-N)                                                                          | weak; 0/3 on the consolidation arc                                         | treat as hypothesis to falsify, not gate to lower; run the cheap probe                      |

**Operational rule: trust the structure, test the numbers.** When DS hands
back a structural reframe, fold it in. When it hands back a quantitative
prediction with a threshold, write it down as a _pre-registered prediction_
and verify with a probe. Don't build a follow-up plan that depends on the
quantitative prediction holding.

### Scoreboard maintenance

Every consult on a quantitative question gets a one-line entry in the session
notes, scored after the experiment:

```
Session: <id>
- structural: <count predicted-and-held / count predicted>
- quantitative: <count predicted-and-held / count predicted>
- counter-evidence: <one line per falsified prediction>
```

The scoreboard is the corrective to "DeepSeek said X, so we did X." It's also
the calibration record for the next session — if DS missed three quantitative
predictions in a row, the next consult opens with that fact on the table.

Example entry (consolidation-tradeoff-2026-06-10, retrospective):

- structural: 3/3 — frozen-encoder probe design, label-partition for affix head, curriculum-erosion reframe
- quantitative: 0/3 — "5× clears ≥72" (Run A held at 64.9), "75 is not a transient" (Run C decayed 75→52.9), "try reweighting first" (Run C carried tag-weight 4.0 and decayed anyway)
- counter-evidence: capacity-tell at step-8000 was framed for a steady-state miss; transient-then-decay shape wasn't anticipated.

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
- **Wrapper hangs on long pro+low prompts:** documented twice in the campaign
  (wrapper timed out at 180s on a long flash+low prompt during the #511 design
  consult). Fall through to the tier-2 curl path below; note the wrapper failure
  in the session-notes so it gets fixed eventually, but don't block the consult
  on it.

## Cross-session continuity

DeepSeek has no memory across conversations. After a productive session, distill
the conclusions into a tracked notes file beside this skill so the next session
can paste them into turn 1:

```bash
$EDITOR .agents/skills/deepseek-consult/session-notes-$(date +%Y-%m-%d)-<topic>.md
```

The raw per-turn transcripts in `~/.cache/ds-consult/sessions/*.transcript.md`
are the source to distill from (and are not committed — keep notes terse and
curated, the way the existing `session-notes-*.md` are). Include the calibration
scoreboard line (above) in any notes file for a quantitative consult.

## Tier-2 fallback: direct curl

If `pi` itself misbehaves (e.g. a provider/streaming bug, the long-prompt hang
above), bypass it and hit the DeepSeek API directly. This is the path past
sessions used; keep it as a backstop, not the default — the wrapper gives
sessions, isolation, and structured output for free.

```bash
KEY=$(grep '^DEEPSEEK_API_KEY=' "$HOME/Projects/playpen/.env.host" | cut -d= -f2-)
curl -s https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d @prompt.json \
  | jq -r '.choices[0].message.content'
```

Continuation = resend the prior `messages` array yourself (curl is stateless).
