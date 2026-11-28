---
name: training-arc
description: Protocol for a training run. One run per design, launched from main after the wiring is verified end to end, graded with one paired comparison against the published model. Controls and attribution arms run only when the operator asks for them. Use before launching any training run, and before reporting any candidate's result.
---

## The default: one run, one comparison

Launch the whole design in one run. A feature with several parts trains as one run, and it splits into
single-variable runs only when the operator asks for an ablation. Grade the candidate with one paired
comparison against the published model and decide.

Don't add a self-control, a placebo run, a per-change attribution or a dry run unless the operator asks.
`launch.run.ts start` runs the same host audits a dry run would. Count each wait before adding it, and
drop any that repeats a check another step runs.

## Before launch

- **Land every pending corpus fix and new source first, then spend one run on the combined corpus.** Do the
  GPU-free work first: fixes, sources, test sets, baseline scores on the published model. Two single-fix runs in
  2026-11 (v8.5.0 on corpus v0.8.13, then v8.5.1) each surfaced the next defect only after the GPU was spent.
- **Verify the wiring end to end.** Every new input the run depends on has a caller on `main`. A new
  database table is read under the name its builder writes. A promoted database is the one the run reads.
  Run `static` and `unit-fast` (`yarn health` and `yarn test --run`) on the launch commit.
- **Launch from `main`.** A run launched from a worktree trains code that `main` may never hold.
- **The step count follows the rows.** Compute `max_steps` from the rows the run must train: the gazetteer's full
  row count for the deterministic stage, and each source's intended absolute draws for the weighted stage. Every
  corpus change states the arithmetic in the same change (rows per source, intended draws, the resulting
  `max_steps`) and flags any source whose absolute draws fall. Runs held 90,000–126,000 steps at batch 128 while
  sources were added, and v8.13.0 left 43.6% of WOF rows never drawn.
- **Hold out only what grading needs.** Borderline rows go to training. Get evaluation coverage from new sources
  rather than from rows taken out of training. A 2026-10-22 perturbation test moved 10.7.0's exact rate by at most
  0.021, so treat a claim that a loss is memorization as a hypothesis to test before acting on it.
- **State the run shape.** A copy of last run's config brings `init_from` and `ewc_lambda` with it. Write down
  `kind` (from-scratch or fine-tune) and one sentence on why. A fine-tune can't introduce a source the base never
  saw, so a corpus that adds a source trains from scratch. The from-scratch recipe is
  `packages/corpus/data/training-configs/v4.4.0-suffix-boundary-v2-base-60k.yaml`: 60k steps, no `init_from`,
  no EWC, about 4.3 h and $9 on an A100-40GB.

## Stage the arms

`mwops release stage-weights-cache` is the one stager. It copies every package's declared artifacts into the
root, links each overlay's `model.onnx` and `tokenizer.model` to the base package's inside the root, and refuses a
root that lacks a declared artifact or whose packages resolve different graphs:

```sh
# The published model, from the workspaces and the data-root overlay.
yarn mwops release stage-weights-cache --out <shipped root>
# A training export, with a card derived from the published card and the run's signed identity.
yarn mwops release stage-weights-cache --out <candidate root> \
  --export <run base>/export --recipe packages/corpus/data/training-configs/<config>.yaml
```

The report prints the graph's sha256 and md5 and the sha256 each package resolves. The candidate's md5 must
differ from the published card's `files_md5["model.onnx"]`, which the derived card keeps under
`candidate.published_card`.

## Grade with the address in view

An aggregate is a summary of visible rows, never a replacement for them. `net −13` hides the difference
between a venue being destroyed and a boundary sliding by one token.

```
mwdev_diff_parse inputs=[…] weights_cache=<candidate>
mwdev_diff_geocode inputs=[…] weights_cache=<candidate>
```

`mwdev_diff_parse` separates the four span events — `retagged`, `moved`, `added`/`removed`, `confidence` —
and a component-map comparison reports all four identically. Read the per-span confidence: the shipped model
holds `venue "Ye Three Lords"` at 0.50 and `venue "Le Colimaçon"` at 0.45, so those rows were never confident
and a candidate that flips them changed a low-confidence answer rather than broke a confident one.

`mwdev_diff_geocode` states which of three problems moved the answer: `parse-changed` (model),
`retrieval-repointed` (ranking or gazetteer), `tier-changed` (data coverage). A model change never moves `tier-changed`.

A seed pair trained on one fixed corpus moves more board rows than a corpus change does, so a from-scratch arm's
board row delta can't attribute a regression on its own. Read a regression's addresses and per-token margins
before calling it the change's.

## Release eligibility

Release eligibility comes from the registered quality requirements (iron rule 5 in
`docs/engineering/CONTRIBUTING_MODEL_WORK.mdx`):

- a release verdict from `packages/mailwoman/tools/eval-harness/release/evaluate.run.ts`, computed on paired outcomes
  from `heldout/per/country.run.ts --dataset` over a sample frozen by `heldout/dataset/freeze.run.ts`, for this exact
  `model.onnx` and the current spec. Only `pass` permits promotion, and the report states the verdict as given
- board regressions are findings to investigate with their addresses. A release report lists each accepted loss
- the promotion battery `mwdev_promotion_eval --spec v9.0.0-base` passes every floor declared by the eval
  spec. Use the passed and total counts printed by the command

## Attribution, when the operator asks for it

`mwdev_arc` runs the attribution arms and applies the arithmetic:

```
mwdev_arc candidate=<staged candidate dir> \
          control=<staged copy of the SHIPPED weights> \
          null=<the no-new-data fine-tune>
```

- The self-control stages the shipped model through the candidate path and grades it against itself. Zero rows
  should differ.
- The placebo (`null=`) fine-tunes the base with no added data, same steps, same seed. Measured on
  `v440-step-060000`, 10 of 649 rows regress with no new data, so an attributed regression count is
  `candidate − placebo`.

A call that omits `control` or `null` reports which arm never ran and marks the number an upper bound.

## Measurement invariants

An aggregate from a broken reader is indistinguishable from a finding. These invariants bind every
measurement in this protocol.

- **Declared `EngineConfig` variables must produce distinct engine IDs.** Unknown configuration
  keys and identical resolved engines are rejected at the dev-MCP boundary (#1858).
- **Requested measurement data must be present and readable.** Parquet projections reject absent
  columns, and the corpus census accepts both supported Arrow list shapes while rejecting malformed
  label values (#1858).
- **Artifact resolution sorts by mtime and prints the artifact chosen** — enforced in
  `lib/dev-mcp/process/compiled-tree.ts`. Never resolve by name sort: `v0.9.9` beats `v0.26.0`
  lexically.
- **A smoke run proves the config loads rather than that the new rows are reached.** Read the file through
  the loader's own check (`country_weights.get(cc)`) first.
- **`country_weights` is a hard admission filter.** A country absent from it trains on zero rows
  regardless of the row count. Check with `mwdev_coverage` before assuming a locale is taught.
- **A corpus change carrying a hypothesis declares `data.required_corpus_receipts`.** Each receipt states
  the minimum sampled rows and may constrain source, country, and a contiguous component sequence.
  Run Modal's CPU-only `audit_epoch_mixture` before allocating a GPU. A missing source, or a label
  order whose source is drawn zero times, must stop the run (#1869).

## The report

Lead with the addresses that changed. Give the aggregate as a footer.

- Name runs by version and role: "the candidate (v8.21.0)", "the published model (11.3.0)". Never a minted name.
- Every table identifies its comparison arm in its header ("vs published 11.3.0"), and every count states its
  denominator.
- A derived figure states its arithmetic where it appears: "net +2 = treatment net +6 − placebo net +4".
- Define each project term at first use or link the doc that does.
- Denominate spend: "$29 of the $40 Modal budget for this experiment", never a bare dollar figure.
- State the next action and stop.
