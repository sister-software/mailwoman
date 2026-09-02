---
name: eval-model
description: Deciding whether a model change may ship. The shipping decision rests on the 649-row board plus the promotion battery, run through the warm-engine mwdev tools; the six-address preset check is a SMOKE test for tag collapse and does not decide. Use before promoting any model, and read it before writing a probe script.
---

## Six addresses do not decide

This skill used to open with six US presets and a v0.5.3 baseline, under the heading "release eval".
It is kept below because it still catches what it was written to catch — a collapsed tagger, a
tokenizer/model mismatch — and those failures are worth thirty seconds before anything expensive.

It is not the shipping decision, and treating it as one ships a model graded on six US rows with no truth
coordinates, no non-US locale, no geocoding, and a baseline from a model several majors old.

## What decides

Three floors, all of which must hold:

1. **Net improved-minus-regressed ≥ 0 on the 649-row board.**
2. **No regression on FR, GB or DE** — iron rule 6, the D-rule. A winning net does not buy one.
3. **The promotion battery passes every floor declared by the eval spec**
   (`mwdev_gate --spec v9.0.0-base`). The command reports the passed and total floor counts; do not
   copy a count into this runbook because adding a floor would make it stale.

Run the first two with `mwdev_arc`, which also runs the controls that make the number mean anything:

```
mwdev_arc candidate=<staged candidate root> \
          control=<staged copy of the SHIPPED weights> \
          shape=from-scratch | fine-tune
```

`candidate` and `control` are the ROOT that CONTAINS `node_modules/@mailwoman/neural-weights-<locale>/`,
not the package directory itself. A root that is not staged is REFUSED rather than falling through to
the installed weights — do not "fix" that refusal by pointing it one level deeper.

The full protocol, and why the controls come first, is the `training-arc` skill. Read it before
launching a run, not after grading one.

## Use the warm tools, not a probe script

Every tool below holds the engines in-process. A `for` loop spawning the CLI per address pays a cold
model load each time and cannot see spans, confidence, provenance or retrieval — which is why probe
scripts keep concluding that nothing changed.

| Question                                                 | Tool                 |
| -------------------------------------------------------- | -------------------- |
| Did the board move, and is the number attributable?      | `mwdev_arc`          |
| What changed on these specific addresses?                | `mwdev_diff_parse`   |
| Why did the coordinate move — parse, retrieval, or tier? | `mwdev_diff_geocode` |
| Two configs, one changed setting                         | `mwdev_compare`      |
| The promotion battery                                    | `mwdev_gate`         |
| What does the corpus contain?                            | `mwdev_coverage`     |
| Where did this span come from?                           | `mwdev_trace`        |

`mwdev_run` with no arguments grades all 649 board rows in about a minute. That is the right
first command, and it is cheaper than the script you were about to write.

## Reading the result

An aggregate is a summary of visible rows, never a replacement for them. `net -13` does not
distinguish a destroyed venue from a boundary sliding one token, and those have different fixes.

Read the per-span confidence before calling a flip a regression: the shipped model holds
`venue "Ye Three Lords"` at 0.50 and `venue "Le Colimaçon"` at 0.45, so a candidate that moves those
tipped a coin rather than broke an answer.

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
  node packages/mailwoman/out/cli.js parse --format xml "$addr" 2>/dev/null
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

**FAIL outright** on all-locality or all-`O` output, on garbage (tokenizer/model mismatch), or on
`grouper-audit` nodes appearing in the XML — the audit injecting where the model should cover is a
coverage gap, not a pass.

Anything short of outright collapse is NOT a verdict. Six US rows cannot clear or condemn a model;
take it to the board.

## Related

- `.agents/skills/training-arc/SKILL.md` — the protocol, and the controls that precede a number
- `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx` — which evals decide a change; iron rule 6 is the D-rule
- `packages/core/test/unit/pipeline/grouper-audit.test.ts` — the audit no-op test for the v0.5.3 collapse pattern
- `docs/records/evals/model-versions/2026-05-27-v0.5.3-diagnostic-training-review.mdx` — the eval that
  produced the smoke presets
