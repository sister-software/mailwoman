---
name: eval-model
description: Demo preset release gate. Runs 6 addresses through neural-only and full pipeline, reports per-tag accuracy, BIO coverage, and grouper-audit source attribution. Flags regressions from the v0.5.3 baseline. Use before shipping any model change.
---

## Purpose

Release gate for model changes. Catches:

- Tag collapse (all-locality, all-O)
- Tokenizer/model mismatch (garbage output)
- Grouper-audit overrides (audit injecting where model should cover)
- Per-tag regressions (locality fixed but street regressed)

## Invocation

Run the compiled CLI against the 6 demo presets in both modes:

1. **Neural-only** (`--neural`): raw model output, no pipeline enhancements
2. **Full pipeline** (default): neural + QueryShape + FST + grouper-audit

```bash
# Compile first (skip if already compiled)
yarn compile

# Neural-only mode
for addr in \
  "1600 Pennsylvania Ave NW, Washington, DC 20500" \
  "350 5th Ave, New York, NY 10118" \
  "Pier 39, San Francisco, CA 94133" \
  "1060 W Addison St, Chicago, IL 60613" \
  "400 Broad St, Seattle, WA 98109" \
  "90210"; do
  echo "=== NEURAL: $addr ==="
  node mailwoman/out/cli.js parse "$addr" 2>/dev/null
done

# Full pipeline mode (XML shows source attribution)
for addr in \
  "1600 Pennsylvania Ave NW, Washington, DC 20500" \
  "350 5th Ave, New York, NY 10118" \
  "Pier 39, San Francisco, CA 94133" \
  "1060 W Addison St, Chicago, IL 60613" \
  "400 Broad St, Seattle, WA 98109" \
  "90210"; do
  echo "=== PIPELINE: $addr ==="
  node mailwoman/out/cli.js parse --format xml "$addr" 2>/dev/null
done
```

## v0.5.3 baseline (6/6 correct)

| Preset        | house_number | street              | locality      | region | postcode |
| ------------- | ------------ | ------------------- | ------------- | ------ | -------- |
| White House   | 1600         | Pennsylvania Ave NW | Washington    | DC     | 20500    |
| Empire State  | 350          | 5th Ave             | New York      | NY     | 10118    |
| Pier 39       | —            | Pier 39             | San Francisco | CA     | 94133    |
| Wrigley Field | 1060         | W Addison St        | Chicago       | IL     | 60613    |
| Space Needle  | 400          | Broad St            | Seattle       | WA     | 98109    |
| ZIP only      | —            | —                   | —             | —      | 90210    |

## What to check

1. **All 6 pass neural-only?** Each preset must have correct components at conf > 0.5.
2. **Zero grouper-audit nodes in XML?** `grep "grouper-audit"` on pipeline output. Any hit = model has coverage gaps.
3. **Confidence regression?** Any tag dropping below 0.8 from the 0.96-0.98 v0.5.3 baseline = investigate.
4. **New tag in output?** Unexpected tags (e.g. `dependent_locality` on a US address) = model confusion.

## Pass/fail criteria

- **PASS**: 6/6 neural-only correct, 0 grouper-audit nodes, no conf < 0.8 on core tags
- **INVESTIGATE**: 5/6 correct or conf < 0.8 on any core tag — run per-tag F1 eval before deciding
- **FAIL**: ≤ 4/6 correct, or grouper-audit injecting nodes, or all-locality/all-O output

## Related

- `docs/articles/evals/2026-05-27-v0.5.3-diagnostic-training-review.md` — the eval that drove this skill
- `corpus-python/src/mailwoman_train/train.py` — per-tag F1 now logged in CSV
- `core/pipeline/grouper-audit.test.ts` — audit no-op test for v0.5.3 pattern
