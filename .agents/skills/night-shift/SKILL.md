---
name: night-shift
description: Autonomous overnight engineering shift workflow for mailwoman. Encodes pre-flight checks, idle-time policy, eval gates, NaN protocol, compute placement, and shift-end handoff. Use when the operator hands the conn for a multi-hour autonomous session, especially involving Modal training runs and HF releases.
---

# Night Shift Skill

## When to use

- The operator hands the conn for a multi-hour autonomous session (often via `/goal`).
- The session likely involves: launching one or more Modal training runs, shipping models to HF, updating the demo, writing docs.
- The operator is offline or asleep — decisions must be made without their input.

## When NOT to use

- Operator is actively at the keyboard. Use normal collaboration mode.
- Single-task sessions (one fix, one PR) — too much overhead.
- Sessions that don't touch model artifacts or shared resources.

## Pre-flight

Before starting autonomous work, run these checks and report findings:

```bash
# 1. Lockfile + dependency hygiene
yarn install --immutable 2>&1 | head -20
# If this fails, fix BEFORE any commits. --no-verify on later commits will hide it.

# 2. CI status from prior session
gh run list --workflow=docs-build.yml --limit 3 2>&1 | head -5
# If recent runs failed, root-cause before piling on more commits.

# 3. Modal state
modal app list 2>&1 | head -10
modal volume ls mailwoman-training | head -10
# Note any apps already running from a prior session; ensure their volume artifacts aren't stale.

# 4. Local disk + workspace state
df -h /home /mnt/playpen | tail -3
git status --short
# Surface untracked plan files or in-flight work the operator left.

# 5. Heat check (lab hardware)
sensors 2>/dev/null | grep -E "(Core|Package)" | head -3
# If CPU is already hot, prefer Modal for any heavy work this session.
```

Output a one-paragraph pre-flight summary at session start: anything that needs fixing before work begins.

## Compute placement

**Default: Modal for heavy work, local for light work.**

| Work | Where | Why |
|------|-------|-----|
| Model training | Modal (A100) | GPU required |
| ONNX export | **Modal** | Loads PyTorch model, runs graph optimization — minutes of CPU |
| int8 quantization | **Modal** | onnxruntime quantizer — seconds but adds up across iterations |
| Full golden eval (4500+ rows) | **Modal** | ~20s per run, ~3K ONNX inferences |
| Demo presets (6-11 addresses) | Local | Trivially small |
| File edits, git operations | Local | Network-bound regardless |
| Build script development + tests | Local | Iteration speed |
| Single-shard parquet builds (<1M rows) | Local | Bound by Python parquet, not GPU |

**Heat rule:** in summer (May–September) or when the lab `sensors` reports any core ≥85°C, treat ALL "either-place" work as Modal-first.

**Modal pyc cache gotcha** (observed 2026-05-28): `export_onnx` can fail with stale label dict imports after a `labels.py` change, even after `modal volume put --force`. Workaround: clear cache before invoking:

```bash
modal volume rm mailwoman-training corpus-python/src/mailwoman_train/__pycache__ -r 2>&1 | tail -1
```

If the workaround stops working, root-cause the issue rather than falling back to local export.

## NaN protocol

When training diverges:

1. **Stop** the app: `modal app stop -y <app-id>`. Don't let it burn GPU on garbage gradients.
2. **Capture** the divergence point: which step, what loss trajectory, what config differed from a known-good run.
3. **Diagnose ONE knob.** Never adjust two variables simultaneously — you lose attribution.
4. **Document** the hypothesis in the config YAML as a comment, not just the commit message. The next iteration needs to see what's already been tried.
5. **Retry.** If it diverges again with the same root, escalate: drop the feature entirely (CE-only fallback) or schedule a deeper investigation as a separate issue.

**Specifically learned (2026-05-28):**
- CRF training on a 33×33 transition table in bf16 NaN'd twice. Fix was to disable CRF training entirely. The bf16 hypothesis remains unconfirmed — needs a fp32 follow-up.
- Both NaN attempts happened post-warmup at peak LR. Warmup + LR adjustments alone don't fix the root cause.

## Pre-publish eval gate

**Before uploading a model artifact to HF, run the full per-tag error analysis and compare against the current default release:**

```bash
node --experimental-strip-types scripts/eval-error-analysis.ts --golden data/eval/golden/v0.1.2 > /tmp/<version>-error-analysis.md
```

Abort the upload if **any tag regresses >2pp from the default release**, unless:
1. The regression is explicitly expected (e.g. retraining from scratch on a new tokenizer — comparison invalid)
2. The operator pre-approved the trade (e.g. "ship v0.6.1 even if locality drops, we need the Stage 3 signal")

The 2pp threshold catches the regressions that matter without blocking on noise.

**If the gate fires:** label the artifact as experimental in the model card, add it to `releases.json` without promoting to `defaultVersion`, file a GitHub issue explaining the trade-off. The artifact still ships — it's the *promotion* that's gated.

## Idle-time policy

**Between training launches, work the backlog. Do NOT just schedule wakeups and wait.**

Scheduled wakeups (`ScheduleWakeup`) are correct for *monitoring signals*: training step counter, CI status flip, external job completion. They are wrong for "check back later in case something happened."

When training is running:

| What's running | Background work to pick up |
|----------------|---------------------------|
| First training of session | Build the next iteration's config + corpus shards |
| Second training | Address backlog issues (#-labeled GitHub items with empirical context) |
| Final training | Draft the shift report, update docs, prep ship pipeline |
| All training done | Continue with backlog OR launch the next iteration |

**The shift was a success when:** all primary goals shipped AND the buffer time produced 1-2 backlog items closed OR 1-2 additional iterations launched. Idle time is waste.

## Commit hygiene

**Forbid `--no-verify` unless explicitly justified per commit.** Pre-commit hooks exist to catch:
- Lockfile drift (the operator's `yarn ci:test:fast` would have flagged a missing workspace entry)
- Format violations (Prettier will rewrite files mid-shift if you skip the check)
- Type errors (saves a CI round trip)

When you must skip (e.g. CI is down, hook is broken), include `[skip-verify: <reason>]` in the commit body so the next session sees the justification.

**After any workspace structure change** (new package, dependency added, monorepo reorg), check CI status within 5 minutes:
```bash
gh run list --workflow=docs-build.yml --limit 1
```

Don't let a workspace change cause silent CI failures for hours.

## Shift artifact

End every autonomous shift with a structured handoff committed to a known path:

```
docs/articles/evals/YYYY-MM-DD-night-N-postmortem.md
```

Sections (in this order):

1. **What shipped** — bullets, links to HF artifacts, git tags
2. **What went well** — concrete patterns worth reusing
3. **What could've gone better** — honest, named friction points
4. **Decisions made autonomously** — what choices you made without operator input, what the alternatives were, why you chose what you chose
5. **Open questions** — things the operator should decide when they're back
6. **Concrete next steps** — bullets with file paths, branch names, issue numbers

Numbers table at the end: shift duration, models trained, total Modal time, local compute time, NaN incidents, CI failures, demo regressions.

**Don't write this at the end as an afterthought.** Sketch it as you go — the structured handoff helps you make better decisions because you're rehearsing the operator's "was that the right call?" question in real time.

## Decision rubrics

### Ship discipline
- Default to **don't ship** for any artifact you'd be uncomfortable demoing to a hostile interviewer.
- "Experimental" labels are a privilege, not a fallback. Use them when results genuinely warrant inspection (mixed signal, A/B-able), not as cover for "I uploaded too fast."

### Iteration discipline
- A model change that costs 4h of GPU and 30min of human attention should produce ONE before/after table covering 5+ tags. If you can't articulate what you expect to change before the run, don't launch.
- If a run produces an unexpected result (good OR bad), pause for 10 minutes to write up the surprise before launching the follow-up. Surprises lose information if you don't capture them while fresh.

### Time budget discipline
- A 9h shift is 9h of capacity, not 9h × (work duration). If you finish primary goals at 60% time, the remaining 40% is bonus iterations or backlog, not waiting.
- Watch for "I'm being conservative" framing applied to "I'm being idle." Conservatism means *picking a smaller scope*, not *doing less of the chosen scope*.

## Operator handoff format

At the very end of an autonomous shift, send the operator a chat-friendly summary (not just a commit link) that contains:

1. The numbers (1-2 sentences)
2. What changed in production (HF defaults, demo version, etc.)
3. Anything that needs eyes-on (regression, decision deferred, open NaN mystery)
4. Where the detailed report lives

This is *additional to* the committed shift artifact — the chat summary is what gets read first thing in the morning; the artifact is the deep dive.
