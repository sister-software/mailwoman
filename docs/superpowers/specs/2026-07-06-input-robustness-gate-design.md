# Input-robustness gate — design

**Date:** 2026-07-06
**Status:** approved (operator, this session)
**Owners:** docs (`@mailwoman/docs`), eval (`scripts/eval/gauntlet`), normalize (`@mailwoman/normalize`)

## Problem

Input-perturbation robustness is a real, implemented capability — three absorption
layers plus a standing metamorphic gate — but it was never written up, and an audit found
three perturbation classes with no stability gate at all. The concept is invisible to a reader
of the docs, and the gate silently omits abbreviation swaps, single-character corruptions, and
number-spelling variants.

Two deliverables, docs first:

1. Document the current state.
2. Extend the metamorphic gate's perturbation set to cover the untested classes, recording the
   ones that legitimately fail as tracked, non-blocking xfails rather than hiding or blocking on
   them.

## Current state (verified against source, 2026-07-06)

Three absorption layers sit upstream of the gate:

1. **Deterministic `normalize/`** — Unicode NFC, punctuation, whitespace collapse + trailing-
   punctuation trim (`normalize/whitespace.ts`). Note: `normalize/abbreviations.ts` (Rd→Road etc.)
   EXISTS but is opt-in (`normalize/compute.ts`) and NOT wired into the runtime pipeline —
   abbreviation handling is deliberately the model's job.
2. **Model-side case normalization** (`neural/case-normalize.ts`) — #690 all-caps title-casing +
   #829 all-lowercase restore, on by default, offset-stable.
3. **Trained-in variation** via corpus shard augmentation — casing
   (`corpus/src/shard-recipes/intersection.ts`, `locale.ts`), abbreviation variants
   (`street-affix.ts`, `unit.ts` #454, `fr-bare-street.ts`).

Gates:

- **Metamorphic INV/DIR** (`scripts/eval/gauntlet/metamorphic.ts`) — the un-gameable layer. Grades
  the ASSEMBLED geocode (coordinate + tier), never parse F1. INV = label-preserving perturbations
  must not move the coordinate (`INV_EPSILON_KM = 0.001`, 1m) or tier. Current INV set:
  `lower`, `upper`, `ws`, `trail-dot`, `comma-tight`. DIR = drop the postcode, must stay within
  5km. Known deterministic failures live in `KNOWN_INV_XFAIL` (currently empty; INV is 35/35 green)
  with anti-rot bookkeeping — an xfail that starts passing is flagged.
- **Golden `graceful/*` slices** (`data/eval/golden/v0.1.2`) — small labeled adversarial slices
  (`graceful/typo|mis-casing|mis-punctuation|whitespace`, ~10 typo cases).
- **`perturb-golden.ts`** — a one-off perturbation generator (delimiter-strip, lowercase, glue),
  never a standing gate.

### Coverage matrix (article centerpiece)

| Class | normalize/ (runtime) | Trained (corpus aug) | Gated |
|---|---|---|---|
| Casing | yes (case-normalize #690/#829) | yes | INV[lower/upper] green |
| Spacing | yes (whitespace.ts) | incidental | INV[ws], INV[comma-tight] |
| Abbreviation swap | capable but OFF at runtime (deliberate) | yes | golden entries only — no stability gate |
| Number spelling | no | no | nowhere |
| Typos (single-char edit) | no | no | ~10 labeled golden cases only |
| Transpositions | no | no | folded into golden typo slice |

## Deliverable 1 — docs

- New `docs/articles/concepts/input-robustness.mdx`: the three absorption layers, then the gates,
  closing with the coverage matrix. Current state only.
- Match sibling concept articles (`what-mailwoman-is.mdx`, `eval-discipline.mdx`) for frontmatter,
  tone, structure. House voice.
- One pointer row/sentence in `CONTRIBUTING_MODEL_WORK.mdx`'s gate section + a cross-link from
  `eval-discipline.mdx`.

## Deliverable 2 — metamorphic INV extension

Extend `scripts/eval/gauntlet/metamorphic.ts`:

1. **`abbrev`** — expanded→abbreviated suffix perturbation, sourced by INVERTING the
   `normalize/abbreviations.ts` table (import it; do not duplicate the data). Strict INV (≤1m): the
   model trains on both forms, the coordinate must not move. Single-letter abbreviations (N/S/E/W/R)
   are excluded — ambiguous with initials. Applies only to bases containing an expandable suffix;
   add realistic bases where a locale lacks one.
2. **`transpose` + `typo-sub`** — deterministic single-character edits at a FIXED position (middle
   of the longest alphabetic token ≥5 chars, never the house number or postcode). NO RNG. New
   tolerance-band relation (≤5km, modeled on DIR), NOT the 1m INV epsilon — a corrupted input may
   legitimately shift the parse.
3. **`number-spell`** — ordinal street swap (`5th Ave` ↔ `Fifth Ave`) and spelled-out house number
   (`100` → `One Hundred`). Tolerance-band relation. EXPECTED to fail initially (never trained,
   never normalized); record in a known-xfail map (the band analog of `KNOWN_INV_XFAIL`) so the gate
   documents the gap non-blocking.

Report per class. Update the coverage-matrix rows this changes; note xfail'd gaps honestly.

### Out of scope

Casing/spacing additions (already green), corpus/training changes, matcher block-stability,
promoting `perturb-golden`.

## Verification

1. Before: metamorphic 35/35 green baseline recorded.
2. After: existing INV green (zero regressions); `abbrev` INV passes; `transpose`/`typo-sub` pass
   the 5km band or are xfail-recorded with the failing case named; `number-spell` likely xfails —
   record it.
3. MDX frontmatter/imports match sibling articles.
