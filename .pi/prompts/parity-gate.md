---
description: Run the parity gate — compare eval scores against floor bars for a version
argument-hint: "<version>"
---

Run the parity gate for Mailwoman version $1. Compare eval scores against the floor bars defined in the gate config.

## 1. Find the gate config

```bash
ls gates/ 2>/dev/null || echo "No gates/ directory"
cat gates/$1*.json 2>/dev/null || echo "No gate config found for $1"
```

Each floor tag has a `bar` (minimum F1). Tags must clear their bars in the parity scorecard.

## 2. Find the latest parity scorecard

```bash
ls docs/articles/evals/parity-scorecard-*.md | tail -1 | xargs cat
```

Extract the per-tag F1 table (Lens 2). Cross-reference against the gate config floors.

## 3. Find the ship gate doc for this version

```bash
ls docs/articles/evals/*-$1-ship-gate.md 2>/dev/null || echo "No ship gate doc found"
```

## 4. Gate checklist

For each floored tag, report: tag name, measured F1, floor bar, PASS/FAIL, delta.

Example format (from v4.3.0 gate):

| tag              | bar  | measured | status |
| ---------------- | ---- | -------- | ------ |
| us.street_prefix | 78   | 93.6     | PASS   |
| us.street_suffix | 67   | 96.6     | PASS   |
| fr.postcode      | 99.5 | 99.7     | PASS   |

## 5. Regression check

Compare against the previous parity scorecard. Any tag that regressed more than 2pp needs:

- A characterized root cause
- A documented decision (gated vs. flagged-not-gated)

```bash
ls docs/articles/evals/parity-scorecard-*.md | tail -2
# diff the Lens 2 tables between the two most recent scorecards
```

## 6. The score ledger

```bash
cat evals/scores-by-version.json | jq '.runs[-1]'
```

Confirm the ledger recorded the gate run. Verify schema version, corpus SHA, eval set SHA, training steps.
