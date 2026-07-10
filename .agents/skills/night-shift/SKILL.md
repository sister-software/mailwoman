---
name: night-shift
description: Autonomous overnight engineering shift workflow for mailwoman. Encodes pre-flight checks, salvage-first survey, idle-time policy, eval gates (with no-silent-gate-drift), diagnostic-before-fix, resume-vs-init_from, NaN protocol, compute placement, treadmill guard, and shift-end handoff. Use when the operator hands the conn for a multi-hour autonomous session, especially involving Modal training runs and HF releases.
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

## Salvage-first survey

Before writing any new module, helper, or lookup table, **search the adjacent
repos for prior art**. Two known sources — `isp-nexus/universe/mailwoman/postal/`
and `isp-nexus/universe/spatial/` — carry vetted, provenance-tracked data and
utilities (USPS directionals, ISO-3166 tables, country/region name maps) that
have been re-derived inside `mailwoman` more than once.

```bash
# Standard pre-write check (run BEFORE drafting a new file):
KW="<concept>"   # e.g. "directional", "iso-3166", "postcode", "cedex"
find /home/lab/Projects/isp-nexus /home/lab/Projects/mailwoman \
  -iname "*${KW}*" 2>/dev/null \
  | grep -viE 'node_modules|\.d\.ts$|/test/' | head -20
```

If a match exists, **import it** (and adjust as needed) rather than re-derive.
The operator has called this out twice; the cost of forgetting is a polite but
firm "I warned you about recreating existing work." Salvage-first is part of
pre-flight, not an optional optimization.

## Compute placement

**Default: Modal for heavy work, local for light work.**

| Work                                   | Where        | Why                                                           |
| -------------------------------------- | ------------ | ------------------------------------------------------------- |
| Model training                         | Modal (A100) | GPU required                                                  |
| ONNX export                            | **Modal**    | Loads PyTorch model, runs graph optimization — minutes of CPU |
| int8 quantization                      | **Modal**    | onnxruntime quantizer — seconds but adds up across iterations |
| Full golden eval (4500+ rows)          | **Modal**    | ~20s per run, ~3K ONNX inferences                             |
| Demo presets (6-11 addresses)          | Local        | Trivially small                                               |
| File edits, git operations             | Local        | Network-bound regardless                                      |
| Build script development + tests       | Local        | Iteration speed                                               |
| Single-shard parquet builds (<1M rows) | Local        | Bound by Python parquet, not GPU                              |

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

## Diagnostic before fix

When a run regresses or a tag underperforms, the next action is **the cheapest
experiment that could falsify your hypothesis** — not a code change, not a
structural retrain. The pattern that adjudicated the consolidation affix fork
(2026-06-10) is the template:

1. **State the hypothesis in one sentence.** "Affix collapsed because feature X
   interferes with feature Y" vs "Affix collapsed because the schedule starved
   its examples." These imply different fixes; conflating them wastes a full
   training cycle.
2. **Design a 2k-step probe that distinguishes them.** Resume from the latest
   checkpoint, change ONE knob in the direction the hypothesis predicts,
   re-evaluate. If the metric moves with the hypothesis → confirmed; if flat →
   the planned fix is wasted compute.
3. **Run the probe before the fix.** Even 2k steps × A100 is minutes; a
   wrong-hypothesis full retrain is hours.

Worked example: the v1.0.0 consolidation regressed US postcode 98.3 → 95.8.
First instinct was "CRF / feature-channel interference, build choreography to
zero the gazetteer clue near postcodes" (which became PR #468). The cheap
diagnostic (resume + raise affix-sampling weight, 2k steps) later showed US
postcode improved +1.6 with _zero_ postcode-position changes — the regression
was under-convergence, not interference. **Choreography wasn't essential for
the nail it was built for.** Default-off/byte-stable saved face; the diagnostic
would have saved the build cycle.

Rule of thumb: if your next planned action costs more than 30 min of GPU _and_
you can't articulate a 2k-step experiment that would falsify it, you don't
have a hypothesis yet — you have a guess. Don't launch.

## Resume vs init_from

When continuing training to recover or extend a fragile capability, `init_from`
is **not a substitute for `resume`**. The two paths look similar in config but
carry different state:

| Path        | Loads weights | Loads optimizer state (Adam moments, LR schedule, step counter) | Use when                                                                                                |
| ----------- | :-----------: | :-------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------- |
| `resume`    |      yes      |                             **yes**                             | continuing a run; recovering or extending a learned capability; any fragile, low-prevalence tag         |
| `init_from` |      yes      |                               no                                | warm-starting a _new_ run with a fresh objective; fine-tune off a different base; A/B optimizer recipes |

Why this matters: late-emergent splits (`street_prefix/suffix` in the
consolidation arc, the multi-locale country signal) sit in narrow basins that
Adam's momentum is actively _in the middle of_ at checkpoint time. A fresh
optimizer at the same weights is **not the same model**: it has no first/second
moments pointing at the basin, no warmup remaining, and a step-counter reset
that re-triggers any cosine schedule. The visible symptom is the run looks
"flat" — it isn't; it's redoing the descent from a worse starting kinematic.

Specific cost from the campaign: Run B of the consolidation arc used
`init_from` to avoid deleting Run A's later checkpoints. The result (affix
prefix flat at 64.9 at 17× density) appeared to falsify the sampling-weight
hypothesis. Run C — same recipe, **`resume`** — reproduced the predicted 75
at 2k. ~35 min A100 lost; one consult-round downstream based on a misread
result.

**Rule: never `init_from` to continue a run whose capability you are still
trying to grow.** If you need the checkpoint slot, snapshot the optimizer state
with the weights and delete the _next_ checkpoint, not the resume target.

## Pre-publish eval gate

**Before uploading a model artifact to HF, run the full per-tag error analysis and compare against the current default release:**

```bash
node mailwoman/out/cli.js eval error-analysis --golden data/eval/golden/v0.1.2 > /tmp/<version>-error-analysis.md
```

Abort the upload if **any tag regresses >2pp from the default release**, unless:

1. The regression is explicitly expected (e.g. retraining from scratch on a new tokenizer — comparison invalid)
2. The operator pre-approved the trade (e.g. "ship v0.6.1 even if locality drops, we need the Stage 3 signal")

The 2pp threshold catches the regressions that matter without blocking on noise.

**If the gate fires:** label the artifact as experimental in the model card, add it to `releases.json` without promoting to `defaultVersion`, file a GitHub issue explaining the trade-off. The artifact still ships — it's the _promotion_ that's gated.

### No silent gate drift

The 2pp pre-publish gate measures against **canonical floors from the config**,
not against whatever table happens to be in the current postmortem. Any
relaxation lives in a separate, explicit "gate-revision" note with a stated
reason; the table in the doc cites the config bars verbatim above any
scorecard.

When writing a scorecard or comparison table in `docs/articles/evals/`:

1. **Quote the config-canonical bar above the table.** Example:
   `gate (config v1.0.0-consolidation.yaml): affix prefix ≥78, suffix ≥67, US street ≥80.4, …`
2. **Don't drop rows that fail.** A row that fails the canonical bar is the
   most important row in the table; if it's "noisy" or "out of scope," say so
   in a footnote next to the row, don't remove it.
3. **Any cell with a softer threshold than the config gets a marker** (e.g.
   `*` with a footnote stating the relaxation and rationale). Don't re-baseline
   silently.

The 2026-06-10 consolidation doc relaxed `affix 78/67 → 72/64` and dropped the
US-street row from one table; the operator caught it on review. No decision
flipped on the relaxed numbers (luck), but ~2h of detection lag is the kind of
friction that ends with "did we just ship a regression?" The
`feedback-no-silent-gate-drift` memory exists; this rule is what keeps the
next doc from triggering it.

When a regression is genuinely the right thing to ship (e.g. guardrail gains that
justify a tag dip), the path is: state the trade-off in the doc, file the
gate revision separately, and the operator promotes — not the agent silently
lowering the bar in the table.

## Idle-time policy

**Between training launches, work the backlog. Do NOT just schedule wakeups and wait.**

Scheduled wakeups (`ScheduleWakeup`) are correct for _monitoring signals_: training step counter, CI status flip, external job completion. They are wrong for "check back later in case something happened."

When training is running:

| What's running            | Background work to pick up                                             |
| ------------------------- | ---------------------------------------------------------------------- |
| First training of session | Build the next iteration's config + corpus shards                      |
| Second training           | Address backlog issues (#-labeled GitHub items with empirical context) |
| Final training            | Draft the shift report, update docs, prep ship pipeline                |
| All training done         | Continue with backlog OR launch the next iteration                     |

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

Numbers table at the end: shift duration, models trained, total Modal time, local compute time, NaN incidents, CI failures, demo regressions, GPU lost to error (if any).

**Don't write this at the end as an afterthought.** Sketch it as you go — the structured handoff helps you make better decisions because you're rehearsing the operator's "was that the right call?" question in real time.

## Decision rubrics

### Ship discipline

- Default to **don't ship** for any artifact you'd be uncomfortable demoing to a hostile interviewer.
- "Experimental" labels are a privilege, not a fallback. Use them when results genuinely warrant inspection (mixed signal, A/B-able), not as cover for "I uploaded too fast."

### Iteration discipline

- A model change that costs 4h of GPU and 30min of human attention should produce ONE before/after table covering 5+ tags. If you can't articulate what you expect to change before the run, don't launch.
- If a run produces an unexpected result (good OR bad), pause for 10 minutes to write up the surprise before launching the follow-up. Surprises lose information if you don't capture them while fresh.

### Treadmill guard (codified)

Two opposite-direction failures on consecutive iterations = **fork, not a
branch**. Stop, name the fork, consult; do not run a third recipe variant
solo. The pattern: iteration N pushes knob K up to fix tag A and hurts tag B;
iteration N+1 pushes K down to fix B and re-hurts A. That's a capacity or
stability constraint, not a tuning problem, and no further K-only iteration
will resolve it.

The consolidation arc hit this exactly at Run C (high density → transient
affix peak + FR-region collapse; moderate density → stable ~65 affix ceiling

- no FR collapse). Treadmill guard fired; campaign STOPPED; the fork went to
  the operator with three named options (re-baseline + ship / architecture
  escalation / hold). No fourth iteration was launched.

### Time budget discipline

- A 9h shift is 9h of capacity, not 9h × (work duration). If you finish primary goals at 60% time, the remaining 40% is bonus iterations or backlog, not waiting.
- Watch for "I'm being conservative" framing applied to "I'm being idle." Conservatism means _picking a smaller scope_, not _doing less of the chosen scope_.

## Operator handoff format

At the very end of an autonomous shift, send the operator a chat-friendly summary (not just a commit link). **Order matters — lead with what the operator needs to act on, not with what shipped.**

1. **Anything that needs eyes-on, in priority order** — merge wall, decision deferred, regression to review, open NaN mystery. This is what gets read first; everything below is context.
2. **What changed in production** — HF defaults, demo version, npm tags. Empty is fine; say so.
3. **The numbers (1–2 sentences)** — headline result + the cost (Modal $, GPU hours).
4. **Where the detailed report lives** — link to the committed postmortem.

This is _additional to_ the committed shift artifact — the chat summary is what gets read first thing in the morning; the artifact is the deep dive. The morning-shift skill consumes this; if you want the handoff to feel smooth, write it the way you'd want to read it half-awake.
