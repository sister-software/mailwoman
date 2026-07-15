# PT/RO diacritic splice — pre-registered gate spec (#900 accept-overlap)

**Status: PRE-REGISTRATION**, per the #900 splice-safety-gate contract
(`CONTRIBUTING_MODEL_WORK.mdx` § Splice safety gate): accepting a codepoint-overlapping locale is a
commitment to a per-locale non-inferiority leg, declared in advance. The FR n=3000 coordinate leg
from v5.1.0 is the template.

**Commit-record caveat (honest sequencing).** This file was authored before any leg was graded, and
its bars are unedited since. But the commit that was supposed to land it first _failed silently_ (an
`oxfmt` crash swallowed by a `tail -1` pipe), so it entered git AFTER the v266 grading below rather
than before it. The bars were not tuned to the result — v266 is a no-op, so there was nothing to tune
toward — but the git record cannot prove that ordering, and pretending otherwise is worth less than
saying so. The protocol lesson is in the night-3 postmortem: verify the commit landed, don't trust
the pipe.

## The candidate

Training-free vocab splice + FVT mean-init (the v5.1.0 / #825 recipe, `onnx-mean-init` path — no
GPU, no checkpoint): PT + RO diacritic-bearing pieces appended to the shipped v0.9.0-multisplice
vocab (73,143), embeddings expanded off the v264 (v6.3.0) ONNX. The encoder is untouched.

**Motivation** (night-3, `2026-07-15-727-stage2-kbest-plan.md`): PT and RO were never spliced. RO
`ț` byte-falls-back, and the heal deliberately skips byte-fallback words, so those rows are
unreachable from the decode side. Parity street-tag exactness: PT 0.63, RO 0.80.

## Build facts (measured at build time, pre-grading)

- Corpus: 311,155 deduped OA PT+RO street/city lines (seed 42, cap 2M rows/file).
- New pieces: **1,110** diacritic-bearing → vocab 73,143 → **74,253 (+1.5%)**.
- English byte-identity: **asserted, 0 diff** (built into the tool).
- Overlap report: `tokenizer-ptro.overlap-report.json`.

## The #900 overlap finding

New-piece non-ASCII codepoints: `º À Á Â Ã Ç É Ê Í Ó Ô Õ Ú Û â`.

| trained locale | overlap | disposition              |
| -------------- | ------- | ------------------------ |
| fr             | —       | clean, no leg needed     |
| pl             | —       | clean                    |
| it             | —       | clean                    |
| cz             | `Ú`     | **ACCEPTED** → leg below |
| es             | `À Á É` | **ACCEPTED** → leg below |
| nl             | `â`     | **ACCEPTED** → leg below |

The overlap is uppercase-only for cz/es (address text is majority lowercase, and `normalizeInput`
title-cases all-caps input — so the exposed surface is initial-capital tokens) plus a single
lowercase `â` for nl. Narrow, but narrow is a prediction, not a permission: the legs run regardless.

## Pre-registered legs — the bars, fixed now

Each accepted locale gets a coordinate non-inferiority leg on its existing OA eval set, candidate
vs the shipped v264 baseline, same resolver/config, ship-config parse (heal ON):

| leg | set                                       | n    | bar                                                                    |
| --- | ----------------------------------------- | ---- | ---------------------------------------------------------------------- |
| cz  | `data/eval/external/oa-cz-coord-1k.jsonl` | 1000 | resolve-rate ≥ baseline − 1.0pp AND mean coord error ≤ 1.05 × baseline |
| es  | `data/eval/external/oa-es-coord-1k.jsonl` | 1000 | same                                                                   |
| nl  | `data/eval/external/oa-nl-coord-1k.jsonl` | 1000 | same                                                                   |

Plus the standing battery, unchanged and non-negotiable:

- **Target legs** (the point of the splice): PT + RO parity street-tag must IMPROVE; RO
  byte-fallback words must disappear from the tokenization.
- Parity floors (`eval parity`, ship config): house_number / postcode / street must not regress.
- Golden 2pp per-tag promote gate (`eval error-analysis`).
- Gauntlet (regression + metamorphic) PASS.
- Demo presets 6/6, zero grouper-audit nodes.
- FR non-inferiority: `oa-fr-coord-150` — no overlap, so this is a control leg; a move here means
  the "no overlap ⇒ no change" reasoning is wrong and the whole splice is suspect.
- #378 browser SLO: +1.5% vocab ≈ +1.7 MB fp32 / +0.4 MB int8 embedding table. Report the actual
  int8 artifact delta; a size regression beyond the bundle budget blocks the ship regardless of
  accuracy.

## RESULT — v266 (OA-sourced) is FALSIFIED at the data level, no GPU spent

The splice built and mean-init'd cleanly (74,253 vocab, package-shaped candidate at
`scratchpad/v266-cache`), and then did **nothing**: tokenization byte-identical to v264 on PT/RO
inputs, parity identical (PT 5/8, RO 4/5, CZ 2/3, PL 5/6, SK 1/1 — every cell unchanged). The
accepted-locale legs were never reached, because the target legs failed first. Cause, measured in the
source data rather than inferred:

- **PT: the OpenAddresses PT source text is 100% UPPERCASE** (`R PRINCIPAL`, `MACINHATA DO VOUGA` —
  188,430/188,430 STREET values `isupper()`). So every piece the splice learned is uppercase
  (`▁LOULÉ`, `▁PORTIMÃO`, `▁FAMALICÃO`); **zero** new pieces contain a lowercase `é`. Production
  title-cases all-caps input (#690 `normalizeCase`) and real queries are mixed-case, so those pieces
  can never match the text the model sees. A no-op by construction.
- **RO: the OpenAddresses RO source text is diacritic-stripped** — 43 of 149,858 rows carry any RO
  diacritic (0.03%), and none carry `ț`/`ș` (`Str. Dumitru Brumarescu` for _Brumărescu_, `Sacasel`
  for _Săcășel_). The PT+RO training corpus contained **0 lines** with RO diacritics, so the 24k
  unigram produced exactly one RO-diacritic piece (`Î`). `ț` byte-fallback is untouched
  (`en|<0xC8>|<0x9B>|ei` before and after).

The `--accept-overlap cz,es,nl` legs are therefore **moot for v266** and are NOT reported as passes:
an unchanged tokenizer trivially cannot move them, and reporting "no regression" from a no-op would
be a fake green.

## The fix, mechanism-confirmed (v267 — a NEW candidate, NOT covered by this spec)

Re-sourcing the splice text from **WOF native-language names** (`names` table, `language=''`, PT+RO;
23,768 names, 3,836 with `ț`/`ș`, 2,260 with `ã`/`õ`/`ç`) via the tool's existing `--extra-text`
feed produces 2,064 pieces **with lowercase diacritics**, and the mechanism works at the tokenizer
level:

| input                   | v264 base                | v267 WOF-name splice               |
| ----------------------- | ------------------------ | ---------------------------------- |
| `Splaiul Independenței` | `en\|<0xC8>\|<0x9B>\|ei` | `en\|ței` — **byte-fallback gone** |
| `Str. Săcășel`          | `▁S\|ă\|c\|ă\|ș\|el` (6) | `▁Săc\|ășel` (2)                   |
| `Tv. dos Fiéis`         | `▁Fi\|é\|is`             | `▁Fi\|éis`                         |
| ASCII rows              | —                        | byte-identical                     |

**But v267 is a different candidate with a wider blast surface**: its lowercase pieces overlap
`fr` (`é`), `it` (`ã`), and `pl` (`ó`) — on top of cz/es/nl. FR is the largest trained locale and is
exactly what the v5.1.0 "net-positive by luck" incident ran through. Accepting six locales requires a
fresh pre-registration with six legs, graded before promotion; that is a new gate spec, not an
amendment to this one, and it is deliberately NOT rushed to fit a shift boundary. Artifacts staged
for it: `scratchpad/v267-cache` (package-shaped, vocab 75,207), int8 39.9 MB (v264: 39.8 MB, +0.3%).

## Decision rule, fixed now

Ship **only** on a clean sweep: every accepted-locale leg within its bar, PT/RO improved, no floor
or gate regression, size within budget. Any accepted-locale leg outside its bar = the splice does
not ship as-is (the honest outcome is a narrower splice — RO-only, which has no `Á/É/À/Ú/â`
exposure — not a relaxed bar). Bars are not editable after the first measurement; a miss is an
adjudication, and the revision protocol's human-in-the-loop is the buffer, not a constant.
