# Width gate + affix miss audit — the #492 ladder closes (2026-06-10)

The probe ladder for issue #492 ran three falsification experiments in one day, each
individually GO'd by the operator, each with a pre-registered gate. All three hypotheses
fell. The audit that followed found the real constraint, and it was in the data the whole
time.

## The ladder

| Probe                                        | Hypothesis                                                  | Result                                                                                                         | Verdict   |
| -------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------- |
| Probe 0 (v1.0.4, choreography off, +4k)      | choreography suppression erodes affix recall                | decay reproduced 81 → 61.1 with choreography OFF                                                               | falsified |
| Frozen-encoder head (v1.0.5, init 40k, 2k)   | shared-BIO output competition; a dedicated head bypasses it | prefix 38.7 / suffix 46.2, P=100 / R≈25 — the head only finds what the frozen representation already separates | falsified |
| Width 48M (v2.0.0, 512H/8 heads/FF2048, 40k) | 29M is capacity-bound                                       | prefix **64.9** — identical to 29M Run A's 64.9 at matched 5× density                                          | falsified |

## Width gate (fp32-to-fp32, pre-registered floors)

FAIL, 6 of 12 checks:

| Check           | Floor     | Got                                                  |     |
| --------------- | --------- | ---------------------------------------------------- | --- |
| street_prefix   | ≥ 78      | 64.9                                                 | ✗   |
| street_suffix   | ≥ 67      | 59.1                                                 | ✗   |
| US street       | ≥ 80.4    | 79.8                                                 | ✗   |
| US locality     | ≥ 72.9    | 71.6                                                 | ✗   |
| unit            | ≥ 90.6    | 87.1                                                 | ✗   |
| postcode        | no-reg    | 98.1                                                 | ✓   |
| country         | 83.3 band | 87.5                                                 | ✓   |
| US micro        | no-reg    | 85.4                                                 | ✓   |
| region          | no-reg    | 89.5                                                 | ✓   |
| FR (both)       | no-reg    | pass                                                 | ✓   |
| DE deorder int8 | ≥ 83.8    | NOT FOUND (harness wart on the int8 leg; immaterial) | ✗   |

NOT promoted. Artifacts banked: int8 md5 `33527afae87526f667c7e83453a723e6` (43 MB —
the size alone disqualifies it as a ship default). The intersection rider
(`synth-intersection: 2.0`) was a data no-op: the v0.4.12 manifest carries zero
intersection-named shards, so the weight sampled nothing. Recorded on #487.

## The audit (`scripts/eval/audit-affix-misses.ts`)

Hypothesis: misses are out-of-distribution surface forms the shard builder never varies.
**Refuted.** Misses spread evenly across the shard's bread-and-butter forms (prefix-abbr
65% missed, prefix-full 38%, suffix-abbr 56%, suffix-full 57% — `1 W Pratt St` is a miss).
No form feature separates hits from misses.

What separates them: **every missed affix is absorbed into the `street` span**
(`model street="w pratt st"`, `"se division st"`, `"e 63rd street"`). The model labels the
affix confidently — the other way.

## The other way is what the corpus teaches

Sampled 1M rows across 5 base shards (v0.3.0 train):

- **69.4%** of street-bearing rows label an affix surface monolithically
  (30.8% start with a directional, 64.5% end with a common suffix —
  `South County Road 175 West` is all `B/I-street`).
- Effective gradient mass: ~467M contradictory examples vs 90K × 5.0 = 450K shard-weighted
  split examples. **At least 1,039:1**, flooring base source-weights at 1.0.
- The loader amplifies it: `augment.py::_expand_token` label inheritance plus
  `augment_directional_prob: 0.3` mints fresh monolithic variants every epoch.

One mechanism explains every observation in the ladder: the 64.9 equilibrium is the mixing
ratio (architecture-independent by construction); the transient decay is early shard
exposure being reabsorbed; P=100 because the base never splits, so the model never falsely
splits; the frozen head's R≈25 because contradictory supervision collapsed the
representation distinction the head would have needed.

## Disposition

Fix is a corpus lever, filed as **#511**: a deterministic loader-level relabel pass
(leading directional → `street_prefix`, trailing USPS C1 suffix from `@mailwoman/codex` →
`street_suffix`, after augmentation, lineage-stamped). Pre-registered expectations and
design points live on the issue. Any retrain needs operator GO per #492's standing rule.

Method note for future audits: the audit script must mirror `score-affix`'s ship-config
construction exactly (tokenizer file + anchor lookup + gazetteer lexicon +
`suppressGazetteerNearPostcode`). Its first run graded the default symlink with zero-filled
channels — all-"(nothing)" output is that crash's signature, and rates above 100% mean
double-counted rows.
