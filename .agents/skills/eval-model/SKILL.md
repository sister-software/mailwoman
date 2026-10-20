---
name: eval-model
description: Deciding whether a model change may ship. Release eligibility comes from a release verdict against registered quality requirements, alongside the promotion battery, run through the warm-engine mwdev tools. The six-address preset check is a SMOKE test for tag collapse and does not decide. Use before promoting any model, and read it before writing a probe script.
---

## Six addresses do not decide

This skill used to open with six US presets and a v0.5.3 baseline, under the heading "release eval".
It is kept below because it still catches what it was written to catch — a collapsed tagger, a
tokenizer/model mismatch — and checking for those failures takes thirty seconds before any expensive run.

It is not the shipping decision, and treating it as one ships a model graded on six US rows. Those rows lack truth
coordinates, a non-US locale, and geocoding, and they use a baseline from a model several majors old.

## What decides

Release eligibility comes from a release verdict against registered quality requirements (policy adopted
2026-10-20, #2763). Iron rule 5 in `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx` states the procedure, and
`docs/articles/developers/knowledge-base/address-intelligence/release-quality.mdx` explains the policy. The D-rule and its FR, GB and DE
veto are removed. The procedure:

1. **Freeze the evaluation sample** with `packages/mailwoman/tools/eval-harness/heldout/dataset/freeze.run.ts`. Then
   run `dataset/overlap.run.ts` for each row's provenance class and `dataset/coverage-register.run.ts` for the coverage
   register. `dataset/compare.run.ts` reports what changed between two sample versions.
2. **Score both models on the same rows**: `heldout/per/country.run.ts --dataset <frozen sample>` writes one paired
   exact-parse outcome per row for the published model and the candidate.
3. **Evaluate against the current specification**: `release/evaluate.run.ts` writes a verdict of `pass`, `fail` or
   `insufficient_evidence` against `release/current-spec.ts`. Only `pass` permits promotion.
4. **Grade the arc**: `mwdev_arc` with `release_verdict=<verdict JSON>`, and `release_spec` to name another version.
   It refuses a verdict whose `model.onnx` sha256 or spec version differs from the candidate's, reports a missing
   verdict as `insufficient_evidence`, reports attribution separately, and lists board regressions with their
   addresses as findings to investigate rather than vetoes.

**Requirements are registered, evidence is not yet.** `release-requirements.v4.json` registers the country and
capability minima, the objective and the confidence settings (`docs/records/evals/2026-10-20-release-requirements-v3.md`).
A verdict stays `insufficient_evidence` until a frozen dataset with an overlap audit holds admitted rows for every
required country. Report release eligibility exactly as the verdict states it. Until the first verdict runs on that
dataset, the promotion battery (`mwdev_promotion_eval` with `check: "v9.0.0-base.json"` and a package-shaped
`weights_cache`) still decides with its retained-pending floors. Use the passed and total counts the command prints.
`docs/records/evals/2026-10-20-promotion-check-migration.md` lists every earlier check and its status.

Run the arc with `mwdev_arc`, which also runs the controls that make the number mean anything:

```
mwdev_arc candidate=<staged candidate root> \
          control=<staged copy of the SHIPPED weights> \
          shape=from-scratch | fine-tune
```

`candidate` and `control` are the ROOT that CONTAINS `node_modules/@mailwoman/neural-weights-<locale>/` rather than the package directory itself. A root that is not staged is refused rather than falling through to
the installed weights — do not "fix" that refusal by pointing it one level deeper.

The full protocol, and why the controls come first, is the `training-arc` skill. Read it before
launching a run rather than after grading one.

## Use the warm tools rather than a probe script

Every tool below holds the engines in-process. A `for` loop spawning the CLI per address pays a cold
model load each time and cannot see spans, confidence, provenance or retrieval — which is why probe
scripts keep concluding that no output changed.

| Question                                                 | Tool                   |
| -------------------------------------------------------- | ---------------------- |
| Did the board move, and is the number attributable?      | `mwdev_arc`            |
| What changed on these specific addresses?                | `mwdev_diff_parse`     |
| Why did the coordinate move — parse, retrieval, or tier? | `mwdev_diff_geocode`   |
| Two configs, one changed setting                         | `mwdev_compare`        |
| The promotion battery                                    | `mwdev_promotion_eval` |
| What does the corpus contain?                            | `mwdev_coverage`       |
| Where did this span come from?                           | `mwdev_trace`          |

`mwdev_run` with no arguments grades the full regression board in about a minute. That is the right
first command, and it is cheaper than the script you were about to write.

## Read the result

An aggregate is a summary of visible rows, never a replacement for them. `net -13` does not
distinguish a destroyed venue from a boundary sliding one token, and those have different fixes.

Read the per-span confidence before calling a flip a regression: the shipped model holds
`venue "Ye Three Lords"` at 0.50 and `venue "Le Colimaçon"` at 0.45, so a candidate that moves those
tipped a coin rather than broke an answer.

## Grade a decoder prior on the geocode path

A decoder prior is graded with the geocode-path options, `geocodeParseInputs`, never with bare
`classifier.parse`. Run the golden dev split through both the geocode session and the runtime
pipeline. The board alone can hide a component cost in the tens of rows that the parse-level grade
shows.

Two instruments read a prior differently from the board. `mwdev_compare` grades a golden row by its
coordinates only, and it flags `dataRoot` as an undeclared difference on every two-arm run even when
both arms read `/mnt/mw`. The structural-validity sweep parses with the classifier alone, so a row a
prior fixes stays listed in `KNOWN_INVALID` until the sweep reads the geocode path.

## Smoke check — tag collapse only

Thirty seconds, before anything expensive. Six presets, US-only, and it proves exactly one thing: the
model still emits structured tags.

```bash
yarn compile
for addr in \
  "1600 Pennsylvania Ave NW, Washington, DC 20500" \
  "350 5th Ave, New York, NY 10118" \
  "Pier 39, San Francisco, CA 94133" \
  "1060 W Addison St, Chicago, IL 60613" \
  "400 Broad St, Seattle, WA 98109" \
  "90210"; do
  echo "=== $addr ==="
  node packages/mailwoman/out/cli/main.js parse --format xml "$addr" 2>/dev/null
done
```

| Preset        | house_number | street              | locality      | region | postcode |
| ------------- | ------------ | ------------------- | ------------- | ------ | -------- |
| White House   | 1600         | Pennsylvania Ave NW | Washington    | DC     | 20500    |
| Empire State  | 350          | 5th Ave             | New York      | NY     | 10118    |
| Pier 39       | —            | Pier 39             | San Francisco | CA     | 94133    |
| Wrigley Field | 1060         | W Addison St        | Chicago       | IL     | 60613    |
| Space Needle  | 400          | Broad St            | Seattle       | WA     | 98109    |
| ZIP only      | —            | —                   | —             | —      | 90210    |

**Fail the model** on all-locality or all-`O` output, on garbage (tokenizer/model mismatch), or on
`grouper-audit` nodes appearing in the XML — the audit injecting where the model should cover is a
coverage gap rather than a pass.

A result short of total collapse is not a verdict. Six US rows cannot clear or condemn a model.
Take it to the board.

## Related

- `.agents/skills/training-arc/SKILL.md` — the protocol, and the controls that precede a number
- `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx` — which evals decide a change. Iron rule 5 is the release-quality procedure
- `packages/core/lib/pipeline/grouper-audit.test.ts` — the audit no-op test for the v0.5.3 collapse pattern
- `docs/records/evals/model-versions/2026-05-27-v0.5.3-diagnostic-training-review.mdx` — the eval that
  produced the smoke presets
