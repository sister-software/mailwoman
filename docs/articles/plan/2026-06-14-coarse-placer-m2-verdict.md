# Coarse-placer M2 — the open-set rule, verdict + decision (#244)

_M2 of the coarse-placer soft country prior. Goal (from the soft-signal spec + the OA-breadth verdict):
an **open-set / novelty method** so never-trained off-map families are caught without the in-map cost the
raw confidence threshold imposes — to clear the ~88/88 ceiling a linear char-ngram model hits, and make a
default-on integration defensible._

## TL;DR

The fix was **a decision rule, not a new model or a retrain.** The OA-broadened model already carries the
open-set signal in its `OTHER` head; the ceiling was _how we read it_. Reading total **in-map mass**
`1 − P(OTHER)` as the reject score (and routing on the in-map argmax) **decouples "is it in-map?" from
"which country?"** and clears 90/90 post-hoc. Wired as an opt-in `openSet` rule on `CoarsePlacer`;
the `mailwoman geocode --place-country` flag uses it.

## Phase 1 — post-hoc score comparison (component probe)

On the **frozen** model (no retrain), over the leave-one-family-out probe (in-map test 55 k vs off-map
HELDOUT 66 k — baltic/oceania/middle-east never trained), honest dev→test (threshold picked on a dev half,
frozen on a disjoint test half), metric = `min(in-map routing accuracy, heldout-caught)`:

| score                                         |      honest dev→test min |
| --------------------------------------------- | -----------------------: |
| **`p_inmap` = 1 − P(OTHER)**                  | **91.3** ✅ clears 90/90 |
| `maxprob` (top in-map softmax — the old rule) | 89.1 (the known ceiling) |
| `maxlogit`                                    |                     83.6 |
| `energy` = logsumexp(in-map logits)           |                     83.4 |
| Mahalanobis (tied-cov, in-map-logit space)    |                     76.2 |

Full report: `docs/articles/evals/2026-06-14-coarse-placer-m2-openset.md`.

**Why `p_inmap` wins (and isn't gaming `maxprob`):** `maxprob` rejects an address whose probability mass is
**spread** across several in-map countries (e.g. 0.4 FR / 0.4 GB / 0.2 OTHER → top 0.4, rejected) even though
it is clearly _not_ off-map. `p_inmap` sums the in-map mass (0.8 → kept) and lets the argmax route it. So the
two jobs — reject vs route — stop fighting over one softmax. **Mahalanobis underperforms** because a linear
model's in-map-logit space isn't a clean Gaussian manifold; the discriminative `OTHER` head _is_ the
detector. ⇒ **Phase 2 (a retrained binary reject-head) is unnecessary.** (Independently sanity-checked with
DeepSeek, which had pre-registered Mahalanobis/reject-head; it agreed the reasoning is sound and the simpler
rule is the right call.)

## Phase 3 — the assembled-pipeline gate (grade the pipeline, not the component)

Re-ran the country-disambiguation gate (parse → resolve, the real wiring) on the **bundled int8** model with
the open-set rule. Report: `docs/articles/evals/2026-06-14-coarse-placer-m2-pipeline-gate.md`.

| rule              | in-map right-country      |  wins | regressions | off-map      |
| ----------------- | ------------------------- | ----: | ----------: | ------------ |
| M1 max-prob (0.9) | 64.7 → 85.3 (+20.6pp)     |     7 |           0 | 0→0 graceful |
| **M2 open-set**   | 64.7 → **91.2** (+26.5pp) | **9** |       **0** | 0→0 graceful |

The two **new** wins are exactly the cases the rule targets — **Birmingham, AL** (US/GB homograph: placer US
0.79, the max-prob rule abstained → resolved to Birmingham UK; open-set keeps it → US) and **Los Angeles**
(US 0.81). Byte-stability invariant (abstain/OTHER ⇒ OFF≡ON) holds; 0 violations.

## Decision: the threshold, and the asymmetry

DeepSeek's sharpest point: **90/90 is the wrong objective for a _soft_ prior.** The prior never filters — it
only re-ranks, tier-safe — so a wrong off-map guess costs ~nothing (the M1 + M2 gates both show off-map
0→0, 0 regressions), while a false _reject_ of an in-map address forfeits the disambiguation win. The cost is
**asymmetric** → bias toward in-map recall, and set the threshold on the **assembled pipeline**, not the
component min.

On the assembled gate the threshold is a **flat optimum** in [0.5, 0.9] (identical 9 wins / 0 regressions —
the homograph wins are all high-mass). So we keep **`abstainBelow` 0.9**: it captures every win, keeps
off-map catch high on the component (≈88% at 0.9-ish), and minimizes in-map _misrouting_ exposure (inject
only when confident). The rule — not the threshold — is the M2 lever (+5.9pp in-map over max-prob).

## Status + what's gated

- **Shipped in M2 (this branch):** the `openSet` rule on `CoarsePlacer` (opt-in, default-off → byte-stable);
  `--place-country` uses it. The whole prior remains **default-off** overall.
- **Default-ON (no flag) is NOT taken here.** The 54-row homograph set under-tests in-map **misrouting** —
  the placer injecting a _wrong in-map country_ (seen as a harmless neutral flip on off-map "San Jose, Costa
  Rica" → ES, but a real risk if the address were in-map). The remaining gate before default-on: a broad
  in-map non-regression eval **across all 11 countries** (NL-vs-DE, ES-vs-IT … misroute classes the
  homograph set doesn't cover). That's the M2.5 / pre-default-on step.
- **Residual upgrade (documented, not needed now):** a full in-map posterior _distribution_ as the
  `anchorPosterior` (vs today's one-hot argmax) would let the resolver break in-map ties itself — the natural
  fix for the misrouting risk, and a clean follow-on.

## Reproduce

```bash
yarn compile
# Phase 1 — post-hoc score comparison on the frozen model:
node scripts/coarse-placer/eval-openset.mjs --model /mnt/playpen/mailwoman-data/coarse-placer/model \
  --out-md docs/articles/evals/2026-06-14-coarse-placer-m2-openset.md
# Phase 3 — assembled-pipeline gate with the open-set rule (bundled int8 model):
node --experimental-strip-types scripts/eval/coarse-placer-country-disambig.ts --openset --abstain-below 0.9 \
  --out-md docs/articles/evals/2026-06-14-coarse-placer-m2-pipeline-gate.md
```
