---
name: training-arc
description: Protocol for grading a model change. Control FIRST, run-shape as an explicit decision, attribution against the null rather than the shipped model. Use before launching any training run, and before reporting any candidate's board result. Written after eight runs that measured the wrong thing.
---

## Why this exists

On 2026-08-23 eight training runs were graded candidate-vs-shipped and every one reported a regression
that was, in substantial part, the cost of fine-tuning at all. The controls that would have said so were
run eighth and ninth instead of first. The full ledger is
`docs/records/evals/retrospectives/2026-08-23-trailing-region-dose-arc.md`.

Nothing below is style advice. Each step is a mistake that shipped.

## The whole protocol is one call

`mwdev_arc` runs steps 1, 2 and 5 in order and applies the arithmetic:

```
mwdev_arc candidate=<staged candidate dir> \
          control=<staged copy of the SHIPPED weights> \
          null=<the no-new-data fine-tune>
```

It refuses to attribute anything when the self-control is dirty, subtracts the null before reporting a
regression count, checks the D-rule, and prints the regressed ADDRESSES rather than only their number.
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

## Step 2 — the NULL run, once per BASE

Fine-tune the base corpus with **no added shard**, same steps, same seed, same brake. Export, quantize,
grade it against shipped exactly as you would a candidate.

This is the placebo. Measured on `v440-step-060000`: **10 of 649 rows regress with no new data**, paid in the
first 1,000 steps and flat to 4,000 — a fixed cost of touching the base, charged before the shard is read.

Consequences, both load-bearing:

- **A candidate's regressions are `candidate − null`, not `candidate − shipped`.** Eighteen regressions where
  the null has ten is eight attributable, not eighteen.
- **A fine-tune must buy back the null's net before it breaks even.** If the null is −5, a candidate at −5 has
  achieved nothing and a candidate at −3 is an improvement.

One 4,000-step run, ~13 minutes, ~$1, amortised over every candidate on that base.

## Step 3 — state the RUN SHAPE, do not inherit it

Copying last run's config carries `init_from` and `ewc_lambda` with it, and the shape then never gets
re-decided. Six runs in a row were fine-tunes for this reason alone.

Before launching, write down:

- `kind`: from-scratch or fine-tune
- `why`: one sentence that would survive being questioned
- `control_run`: the null arm for this base, or `none — first of lineage`

**A fine-tune cannot introduce a source the base never saw.** If the corpus adds a new source, the honest
shapes are a from-scratch base or an explicitly-scoped additive fine-tune with the null in hand. The
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
and a candidate that flips them tipped a coin rather than broke an answer.

`mwdev_diff_geocode` states which of three problems moved the answer: `parse-changed` (model),
`retrieval-repointed` (ranking or gazetteer), `tier-changed` (**data coverage — no model change touches it**).
Grading a tier fall-through against a model wastes a run.

## Step 5 — the gate is against SHIPPED, and it is not the attribution

The null is the right baseline for _attributing_ a regression. It is never a licence to ship one: publishing
costs a user the difference from what they have today.

- net improved-minus-regressed ≥ 0 on the 649-row board
- FR, GB and DE show no regression anywhere — iron rule 6, the D-rule
- the promotion battery `mwdev_gate --gate v9.0.0-base` passes 17/17

## Pitfalls that produced a confident wrong answer

- **A zero can mean the lever never ran.** `EngineConfig` is a plain object; a mistyped key is dropped in
  silence and both arms run the same weights. Assert the engine ids DIFFER before believing a small delta.
- **A projection reports what it lost as "unchanged."** `flattenTreeNodes` dropped `source` and then the
  resolver payload; both times the affected spans read as identical. A reader that can return a partial
  result must declare what it got, or throw.
- **A nested Arrow column is not an array.** Corpus `labels` arrives as `{list:[{element:…}]}` on some shards
  and plain on others; `Array.isArray` is false for the first and every label count reads zero.
- **Column projection can silently drop a column.** `getCursor(["country","labels"])` returns `{country}`
  alone on some writers' shards. Probe the first record.
- **Artifact resolvers must not sort by name.** `v0.9.9` beats `v0.26.0` lexically and `v8-jp-full` beats both
  numerically. Sort by mtime and PRINT the artifact chosen.
- **A smoke run proves the config loads, not that the shard is reached.** A mixed shard's other arm keeps the
  zero-rows guard from firing. Read the shard through the loader's own gate (`country_weights.get(cc)`) first.
- **`country_weights` is a hard admission filter.** A country absent from it trains on nothing regardless of
  how many rows exist. Check with `mwdev_coverage` before assuming a locale is being taught.

## Reporting

Lead with the addresses that changed and the attribution. Give the aggregate as a footer. If a control was
not run, say so — an unattributed regression count is not a finding.
