---
name: training-arc
description: Protocol for grading a model change. Control FIRST, run-shape as an explicit decision, attribution against the placebo fine-tune rather than the shipped model. Use before launching any training run, and before reporting any candidate's board result.
---

## Why this exists

Eight training runs in one session were graded candidate-vs-shipped, and every one reported a regression
that was, in substantial part, the cost of fine-tuning at all. The controls that would have said so ran
eighth and ninth instead of first. The full ledger is
`docs/records/evals/retrospectives/2026-08-23-trailing-region-dose-arc.md`.

Nothing below is style advice. Each step is a mistake that shipped.

## The whole protocol is one call

`mwdev_arc` runs steps 1, 2 and 5 in order and applies the arithmetic:

```
mwdev_arc candidate=<staged candidate dir> \
          control=<staged copy of the SHIPPED weights> \
          null=<the no-new-data fine-tune>
```

It refuses to attribute anything when the self-control is dirty, subtracts the placebo (the `null=` arm)
before reporting a regression count, checks the D-rule, and prints the regressed ADDRESSES rather than only their number.
Omitting `control` or `null` does not skip the check quietly — the result says which control never ran
and marks the number an upper bound.

Read the rest of this file when a leg needs building, or when the tool's verdict needs auditing.

## Step 1 — the SELF-control, once per session

Stage the SHIPPED model through the identical candidate path and grade it against itself.

```
mwdev_compare inputs={"kind":"board"} \
  arm_b={"kind":"mailwoman","config":{"weights_cache":"<staged copy of the shipped weights>"}} \
  variable=["weights_cache"] grade=auto
```

Expect **0 of 649 differ**. Anything else means the rig is noisy and no candidate number from this session
means anything. It costs one board run and it is the only thing separating _"the candidate is worse"_ from
_"my harness is."_

Stage it by dereferencing symlinks — a candidate directory that points back at the shipped artifacts grades
the shipped model under the candidate's name:

```bash
for f in "$OVERLAY"/*; do cp -L "$f" "$CAND/$(basename "$f")"; done
cp -f <candidate int8> "$CAND/model.onnx"
md5sum "$CAND/model.onnx"     # MUST differ from the shipped md5
```

## Step 2 — the PLACEBO run, once per BASE

Fine-tune the base corpus with **no added data**, same steps, same seed, same brake. Export, quantize,
grade it against shipped exactly as you would a candidate.

This is the placebo — pass it to `mwdev_arc` as `null=`. Measured on `v440-step-060000`: **10 of 649 rows
regress with no new data**. The loss appears in the first 1,000 steps and is flat to 4,000: touching the
base costs those rows before the new data is read.

Consequences, both load-bearing:

- **A candidate's regressions are `candidate − placebo`, not `candidate − shipped`.** Eighteen regressions
  where the placebo has ten is eight attributable, not eighteen.
- **A fine-tune must first recover the placebo's net loss.** If the placebo nets −5, a candidate at −5 has
  achieved nothing and a candidate at −3 is an improvement.

One 4,000-step run, ~13 minutes, ~$1; the one run covers every candidate on that base.

## Step 3 — state the RUN SHAPE, do not inherit it

Copying last run's config carries `init_from` and `ewc_lambda` with it, and the shape then never gets
re-decided. Six runs in a row were fine-tunes for this reason alone.

Before launching, write down:

- `kind`: from-scratch or fine-tune
- `why`: one sentence that would survive being questioned
- `control_run`: the placebo arm (`null=`) for this base, or `none — first of lineage`

**A fine-tune cannot introduce a source the base never saw.** If the corpus adds a new source, the valid
shapes are a from-scratch base or an explicitly-scoped additive fine-tune with the placebo in hand. The
from-scratch recipe is `corpus-python/src/mailwoman_train/configs/v4.4.0-suffix-boundary-v2-base-60k.yaml` — 60k steps, no `init_from`, no EWC,
~4.3 h and ~$9 on an A100-40GB.

## Step 4 — grade with the ADDRESS in view

An aggregate is a summary of visible rows, never a replacement for them. `net −13` hides the difference
between a venue being destroyed and a boundary sliding by one token.

```
mwdev_diff_parse inputs=[…] weights_cache=<candidate>
mwdev_diff_geocode inputs=[…] weights_cache=<candidate>
```

`mwdev_diff_parse` separates the four span events — `retagged`, `moved`, `added`/`removed`, `confidence` —
which a component-map comparison reports identically. Read the **per-span confidence**: the shipped model
holds `venue "Ye Three Lords"` at 0.50 and `venue "Le Colimaçon"` at 0.45, so those rows were never confident
and a candidate that flips them changed a low-confidence answer rather than broke a confident one.

`mwdev_diff_geocode` states which of three problems moved the answer: `parse-changed` (model),
`retrieval-repointed` (ranking or gazetteer), `tier-changed` (**data coverage — no model change touches it**).
Grading a tier fall-through against a model wastes a run.

## Step 5 — the gate is against SHIPPED, and it is not the attribution

The placebo is the right baseline for _attributing_ a regression. It never authorizes shipping one:
publishing costs a user the difference from what they have today.

- net improved-minus-regressed ≥ 0 on the 649-row board
- FR, GB and DE show no regression anywhere — iron rule 6, the D-rule
- the promotion battery `mwdev_gate --gate v9.0.0-base` passes every floor declared by the gate
  spec; use the passed and total counts printed by the command rather than a count copied into this
  runbook

## Measurement invariants

An aggregate from a broken reader is indistinguishable from a finding. These invariants bind every
measurement in this protocol.

- **Declared `EngineConfig` variables must produce distinct engine IDs.** Unknown configuration
  keys and identical resolved engines are rejected at the dev-MCP boundary (#1858).
- **Requested measurement data must be present and readable.** Parquet projections reject absent
  columns, and the corpus census accepts both supported Arrow list shapes while rejecting malformed
  label values (#1858).
- **Artifact resolution sorts by mtime and prints the artifact chosen** — enforced in
  `packages/dev-mcp/compiled-tree.ts`. Never resolve by name sort: `v0.9.9` beats `v0.26.0`
  lexically.
- **A smoke run proves the config loads, not that the new rows are reached.** Read the file through
  the loader's own gate (`country_weights.get(cc)`) first.
- **`country_weights` is a hard admission filter.** A country absent from it trains on nothing
  regardless of how many rows exist. Check with `mwdev_coverage` before assuming a locale is taught.

## Reporting — the structure is part of the protocol

Lead with the addresses that changed and the attribution. Give the aggregate as a footer. If a control was
not run, say so — an unattributed regression count is not a finding.

- Name runs by version and role: "the control run (v5.0.1)", "the treatment run (v5.0.2)". Never a
  minted name — the operator has banned `the null` and `the cure` from reports; `null=` survives only
  as the literal `mwdev_arc` parameter.
- Every table names its comparison arm in its header ("vs shipped v4.4.0"), and every count carries its
  denominator.
- A derived figure states its arithmetic where it appears: "net +2 = treatment net +6 − placebo net +4".
  This rule shipped once already (commit aa6f149b2, the share figures) and recurred — in place, not in a
  footnote.
- Define each project term at first use or link the doc that does. Name the corpus recipe file, config
  key, or weight — the words `shard` and `lever` are banned in reports.
- Denominate spend: "$29 of the $40 Modal budget for this experiment", never a bare dollar figure.
- State the next action and stop. No scheduling (`tomorrow`), no wind-down narration — the operator sets
  cadence, and completion is acceptance criteria, not elapsed turns.
