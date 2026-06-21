# The relabel probe — #511 confirms the #492 contradiction theory (2026-06-10 evening)

Same-day sequel to [the width gate + affix audit](./2026-06-10-width-gate-affix-audit.md). That
note ended with a theory (the affix ceiling is contradictory base-corpus labels at ≥ 1,039:1) and
a fix design (#511, a loader-level relabel pass). This note records the probe that tested it.

## Design

`v1.0.6-relabel-probe`: single-variable contrast against probe 0 (v1.0.4) — same clean
consolidation step-040000 checkpoint, same shard weights (synth-affix 20.0), same +4k steps,
choreography off, ONE change: `data.affix_relabel_lexicon_path` set. Probe 0 is the measured
control: prefix 81.0 at +2k decaying to 61.1 at +4k with relabel off.

The relabel pass (`corpus-python/src/mailwoman_train/relabel.py`) applies the affix shard
builder's exact split semantics to every street span at load time, after augmentation. Builder
parity is the critical property — "W Park Ave" gets NO split because the builder rejects
affix-shaped names, and a looser pass would introduce a third labeling. Vocab is codex-derived
(`scripts/build-affix-relabel-lexicon.mjs`, 16 directional + 549 suffix variants). Pre-train
audit on 250K real base rows across five shards: every sampled split correct, per-shard split
rates 8–87% consistent with the 69.4% aggregate measurement.

Design was pressure-tested in a 3-turn DeepSeek consult (curl fallback — the `pi` wrapper timed
out again at 180s): concurrence on all-rows scope (GB splits are schema-correct; a country filter
adds brittleness), relabel probability 1.0 (partial relabeling is a weaker dose of the same
contradiction — p=0.9 still leaves ~156:1), and probe decisiveness. Its push-back we adopted: the
32-row affix eval is too small to gate on (one instance ≈ 4pp); expand to ≥100/≥100 instances
before the full-run gate. One correction ours: the probe keeps shard weight 20.0 for probe-0
parity — the weight-reduction discussion belongs to the full run.

## Result: HOLD

Scored with `score-affix` (fp32, ship-config channels), real-affix eval (n=32):

|                                | +2k (step 42000) | +4k (step 44000) | probe 0 control |
| ------------------------------ | ---------------- | ---------------- | --------------- |
| street_prefix recall           | 88.0             | 84.0             | 81.0 → 61.1     |
| street_prefix F1               | 93.6             | 91.3             | —               |
| street_suffix F1               | 96.7             | **100.0**        | ~59             |
| street F1                      | 87.5             | 87.5             | —               |
| spine (hn/loc/region/postcode) | 100 each         | 100 each         | —               |

Honest reading of the strict criterion: we pre-registered "drop ≤ 2pts +2k→+4k"; prefix recall
dropped 4.0 (F1 2.3). That is exactly ONE flipped instance (tp 22→21) on a 25-instance eval —
the quantization noise the consult flagged — against the control's 20-point collapse, while
suffix ROSE to 100. Verdict: HOLD, with the caveat recorded here rather than hidden.

Residual misses at +4k: four prefixes, all prefix+ordinal/numeric names ("Northwest 23rd
Avenue", "E 63rd Street", "NE Loop 410"). The suffix splits fire correctly even on those rows
(`model street="northwest 23rd"`). A long tail that 4k corrective steps on a 20.0-weight resume
has not migrated; the full run owns it.

## The full run

`v1.1.0-relabel-consolidation` launched the same evening (from scratch, 40k): the v4.2.0 recipe
on the consistent mix with both anti-contradiction compensations REVERTED as stated decisions —
synth-affix 17.0 → 2.0 and affix tag class-weights 2.0/4.0 → 1.5/1.5 (suffix now appears on ~65%
of base street rows; a 4× boost on a majority tag risks over-fire). Gate: the v4.2.0 ship floors
unchanged, affix measured at 20k AND 40k (stability is the claim under test), plus the consult
watches (folded-street invariance, short-street recall, house_number→street_prefix transition).
The expanded NAD-native affix eval re-baselines before the verdict; the 32-row result is recorded
alongside, not substituted. All hold → v4.3.0 candidate.

## Probe economics, for the record

The entire #492 → #511 arc — three falsification probes, the audit, the corpus measurement, the
fix, and its confirmation — cost under one hour of A100 total. The width run alone (the
hypothesis the ladder was built to avoid betting on blind) would have been ~1h for a 6/12 FAIL
with no explanation. Pre-registered cheap probes against a measured control remain the best
purchase in this project.
