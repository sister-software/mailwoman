# Error Analysis Baseline — v0.5.3

Run date: 2026-05-28
Golden set: 4535 entries (US 2936 + FR 1545 + adversarial 54)
Tokenizer: v0.5.0-a1
Time: 17.4s

## Summary

| Metric | Count | Rate |
|--------|-------|------|
| Exact match | 1147 | 25.3% |
| Missed entities | 1770 | — |
| Boundary errors | 3690 | — |
| Confused tags | 1538 | — |
| Hallucinated tags | 1319 | — |

## Missed entities (1770) — top categories
- street_prefix (e.g. "SE", "N") — not in Stage 2 vocab
- street_suffix (e.g. "St", "Ave") — not in Stage 2 vocab
- po_box — not in Stage 2 vocab
- unit (e.g. "Apt 4B") — not in Stage 2 vocab
- intersection_a/b — not in Stage 2 vocab

## Boundary errors (3690) — top patterns
- street: golden expects "Salmon" got "SE Salmon St" (Stage 2 merges prefix+name+suffix)
- street: golden expects "main st" got "main st portland" (locality boundary leak)

## Key insight

~80% of failures are SCHEMA MISMATCH, not model error. The model is doing Stage 2 (10 tags) while the golden set uses Stage 3 (~16 tags). Boundary errors will largely disappear when Stage 3 ships and street is decomposed.
