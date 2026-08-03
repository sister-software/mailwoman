# Template: evidence

An `evidence` page reports a measurement. It is dated by construction: a later reader needs to know what ran,
against what baseline, and what it cost. Register rules are in [`../writing-system.md`](../writing-system.md)
under Register by role.

## Frontmatter skeleton

Copy this to the top of the new page. This role carries no fields beyond `role:`.

```yaml
---
title: Pre-publish 2D eval gate
description: The two-dimensional threshold that runs before any weights release, and the regression it was built from.
role: evidence
---
```

## Section order

1. `# Title` — what was measured.
2. **What ran.** Candidate, baseline, dataset, date. One paragraph.
3. **Method.** Enough for someone else to run it again.
4. **Numbers.** A table. Deltas carry their units.
5. **Losses.** What got worse. This section is not optional and does not go last by accident.
6. **Caveats.** Mechanism first. Circularity caveats are mandatory.
7. **Reproduce.** The command, and a link to the run.

## Opening move

Lead with what was measured and against which baseline, in one sentence, before any interpretation.

## Exemplar paragraph

> The pre-publish gate compares a candidate model's per-tag output against a baseline and exits non-zero if
> any tag violates either of two dimensions: a recall drop on a tag that had recall to lose, or a
> hallucination spike on a tag whose false-positive count runs away. Both dimensions are needed, and the
> v0.6.1 release is the receipt. A recall-only gate would have passed it: `dependent_locality` went from 0
> hallucinated spans to 1066, while its nominal recall improved from 0% to 30%. The recall dimension alone
> would have caught the `locality` drop (39.7% → 31.1%, −8.6pp) and the `house_number` drop (79.0% → 75.9%,
> −3.1pp) and shipped the third failure anyway.

<!-- illustrative -->

```
GATE FAILED: 3 violation(s).
- locality (recall) — recall 39.7% → 31.1% (Δ -8.6pp; baseline > 10%)
- house_number (recall) — recall 79.0% → 75.9% (Δ -3.1pp; baseline > 10%)
- dependent_locality (hallucination) — hallucinated 0 → 1066 (Δ +1066; new rate 2665.0%)
```

## Checks before commit

- Losses are reported in their own section, with the same precision as the wins.
- Each caveat states its mechanism, not only its existence.
- If the eval set and the training set share a source, the page says so beside the number it affects.
- Every number carries the command that produced it, or a link to the run that did.
- Deltas carry units (`pp`, `%`, `ms`), and a magnitude that could be zero says which zero it is.
- The audit checklist in [`../writing-system.md`](../writing-system.md) has been run over the draft.
