# Word-consistency heal: re-diagnosis, contract fix, ship default-ON (night-3)

**Model:** v264 (v6.3.0 shipped weights) — no retrain; every change is decode-side library code.
**Change set:** PR #1132. **Gate revision (explicit):** the parity gate now grades the ship-config
parse (heal ON, `--no-word-consistency` for pre-heal continuity). Floors untouched.

## What was wrong

The per-word BIO consistency heal (`neural/word-consistency.ts`, built for #727) was shelved
default-OFF at the 2026-06-19 gate: street −12.6 on the adversarial golden, attributed to "the
confidence-weighted vote amplifies noise on byte-soup rows," with a confidence-gated variant named
as the path to a clean win.

Night-3 re-diagnosis: the regression was **two defects in the heal**, not vote noise —

1. **Contract bug.** The vote re-decoded words whose pieces already AGREED in type whenever local
   type-mass preferred another type, silently overriding viterbi's global decision. Single-piece
   `▁Broadway` (B-street) flipped to O; all-street `Gamle` rewrote to locality. The module docstring
   had always claimed "a word whose pieces already agree is left byte-identical" — the code only
   honored that when the vote happened to agree. Now enforced structurally: the vote runs ONLY on
   words whose pieces disagree in type.
2. **Grouping bug.** Punctuation continuation pieces joined the preceding word's vote group
   (`Ave` + `,` — the comma piece carries no `▁` sentinel), and their `O` mass manufactured a fake
   intra-word disagreement that killed the real span. This is the whole ordinal-street golden class
   (`1st Ave, ND`: the street dies at the comma, not at the ordinal). Fixed by
   `splitOnPunctuation`: punctuation-only pieces separate vote groups like whitespace — which also
   rescues slash compounds (`Unit 12/345` keeps unit ≠ house_number).

A `minMeanConfidence` floor (the hypothesized fix) was implemented and measured **net-negative** on
the fragment-heavy parity corpus — fragment rows are low-confidence but heal correctly. It ships as
an unused opt. `skipByteFallbackWords` (raw `<0xNN>` pieces void the vote premise) is part of the
ship default.

## Measurements

Gate bars (config-canonical, unchanged): parity floors house_number ≥ 0.97 / postcode ≥ 0.97 /
street ≥ 0.90; golden 2pp per-tag promote gate; demo presets 6/6.

### Golden per-locale-f1 (dev us/fr/adversarial, v264, anchor+gazetteer fed)

| file        | macro F1 off → on | street F1 off → on |
| ----------- | ----------------- | ------------------ |
| us          | 48.0 → **48.3**   | 82.0 → **82.2**    |
| fr          | 42.2 → **51.5**   | 90.8 → **91.8**    |
| adversarial | 66.0 → **66.5**   | 85.7 → 85.7        |

The historical −12.6 street regression is not just neutralized — every file improves or holds.

### Parity floors (triaged corpus, 321 live, canonical `eval parity`)

| label        | off    | on (ship)  | floor | verdict           |
| ------------ | ------ | ---------- | ----- | ----------------- |
| house_number | 0.7671 | **0.8082** | 0.97  | FAIL (arc target) |
| postcode     | 0.9722 | **0.9861** | 0.97  | **PASS**          |
| street       | 0.5431 | **0.5730** | 0.90  | FAIL (arc target) |

### Golden error-analysis (2pp promote gate): PASS

Worst regression country −0.4pp (n=245, noise); gains locality +1.9, venue +1.0, po_box +3.7;
exact-match 24.5% → 25.5%. Full tables: `scratchpad/ea-wc-{off,on}.md` (session artifacts).

### Demo presets (eval-model): PASS

6/6 both modes, zero grouper-audit nodes. The `Pier 39` unit-tag quirk (conf 0.03) is pre-existing
v264 behavior — identical with the heal off.

### Diacritic locales (parity subset, heal ON — the "visibility, not regression" check)

| locale | street-tag exact | resolve-locality |
| ------ | ---------------- | ---------------- |
| CZ     | 2/3              | **3/3**          |
| PL     | 5/6              | 2/2              |
| PT     | 5/8              | 2/2              |
| RO     | 4/5              | 3/3              |
| SK     | 1/1              | 1/1              |

The city never resolves wrong; only the street surface string misses. Confirms the night-2
hypothesis that prior splice-era wins were measured on resolve while the new parity metric measures
surface exactness. Residual PT/RO cases are byte-fallback words the heal deliberately skips — the
splice coverage gap stands (smaller than night-2 believed).

## Scope

Decode-side only: no ONNX change, no #378 SLO impact, browser runtime shares the classifier. Ship
sites: `core/pipeline/runtime-pipeline.ts` (`safeClassify`) + `mailwoman/geocode-core.ts`
(`parseForGeocode`), via the shared `WORD_CONSISTENCY_SHIP_DEFAULT` constant. The
2026-06-19 gate history is preserved in the module docstring with the corrected attribution.
