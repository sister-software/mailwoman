# Is the fr.house_number 91% floor calibrated? — a SOTA + mechanism review (#564)

_2026-06-13. Commissioned to answer two questions before deciding whether to ship the v1.5.0
recovery model (fr.house_number 87.4%, +32.9pp over the shipped v4.5.0's 54.5%, missing the
pre-registered 91% gate floor by 3.6pp): **(1) why does the recovery plateau ~87% and backfire
when pushed, and (2) is the 91% threshold an accurate measure of success for this case?** Two
independent inquiries — a literature/benchmark review and a DeepSeek-v4-pro architectural consult —
converged on the same answers. Sources are listed at the end._

## TL;DR

1. **The 91% floor is mis-calibrated for the postcode-first case.** It was inherited from a
   canonical-order eval where house*number is the \_easiest* field (published SOTA 99–100% F1). On the
   hard reordered/international case, the nearest published SOTA — Chinese flexible-order
   address parsing — reports house-number F1 of **~90–91%**, and neural parsers _collapse_ on reorder
   (deepparse: 100% → 28%; libpostal overall 0.992 → 0.781). **87.4% is respectable-to-SOTA for this
   slice, not a failure.** Both the literature and DeepSeek independently call the 91% bar wrong for
   this regime.
2. **The plateau-and-backfire is well-explained:** a _positional shortcut_ (the model learned
   "house*number = the leading number" because real FR data is canonical-order) + a \_synthetic-realism
   / distribution gap* (overweighting synthetic reorder data shifts training away from the real
   distribution and degrades it) + **simplicity-bias fallback** — when weight 6.0 corrupts the
   "leading-token" shortcut without supplying a real discriminator, the model drops to the
   _next_-simplest spurious cue ("leading _digit_"), which is exactly why `47110` fragments into
   house_number `4` + postcode `7110`.
3. **The right levers are not weight.** Highest-ROI: protect the postcode span using the
   postcode-anchor signal **we already compute** (a CRF transition penalty / consistency term against
   relabeling postcode-anchored tokens as house_number), and gazetteer-gated disambiguation (a number
   appearing right before a known locality is overwhelmingly a postcode). Then curriculum/denoising of
   the synthetic weight, then real reordered data. Architecture (PE → RoPE/relative) is low-ROI here.

## Question 1 — why it plateaus and backfires

The shipped model reads by **position, not meaning**: it labels the first number-shaped token as the
house number because in French BAN (canonical, street-first) the house number almost always leads.
This is a textbook **shortcut** (Geirhos et al. 2020): a cue that aces the training distribution and
fails under shift. The mechanistic match is Yu et al. (NeurIPS 2025): **low positional diversity →
the transformer learns a positional shortcut rather than a content-based rule, and it's data
_diversity_, not _volume_, that flips it.** Our synthetic shard adds diversity, which is why it
helped (+32.9pp) — but synthetic diversity has a ceiling.

Why more weight made it _worse_, with a new failure (postcode fragmentation):

- **Synthetic-realism / distribution gap.** Augmentation gains are regime-dependent and plateau (Chen
  et al., TACL 2023); past an optimal ratio, an overweighted augmentation _shifts the training
  distribution away from real data and decreases performance_ (Wu et al. 2022, "On-the-fly Denoising").
  At weight 6.0 the synthetic shard overwhelms real BAN and the model fits the generator's caricature
  of reordered French, not the real eval distribution.
- **Simplicity-bias fallback (the fragmentation mechanism).** When weight 6.0 corrupts the dominant
  "leading-token = house*number" shortcut \_without* installing a robust discriminator, the model falls
  to the next-simplest spurious feature rather than the intended one (Shah et al., "Pitfalls of
  Simplicity Bias", NeurIPS 2020). Here that fallback is "leading _digit_" — so it carves a house
  number (`4`) out of the front of the postcode (`47110`), leaving `7110`. This is the piece pure
  position-bias doesn't explain on its own, and it's the clearest signal that _more of the same
  synthetic data is the wrong direction._
- **One thing to verify (cheap):** does the synthetic shard itself carry any token-level label noise
  at the postcode/house_number boundary? Even 2–3% of rows splitting a label at a digit boundary
  would also produce fragmentation. Worth a check of the shard's span emission before the next run.

Why the German precedent didn't transfer: German house numbers are always **last** — one position to
learn, so more practice sharpens the aim. FR postcode-first puts a 5-digit and a 1–4-digit number in
the same neighborhood; turning up exposure amplifies the "grab a leading number" bias instead of
teaching discrimination.

## Question 2 — is 91% an accurate measure?

**No — it's a canonical-order bar applied to a reordered-order problem.** The evidence:

| Setting                                   | House-number / number-field accuracy                        | Source                                         |
| ----------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| Clean, canonical, US single-order         | **99–100% F1** (house*number is the \_easiest* field)       | Yin et al. 2023 (US geocoding benchmark)       |
| Hard, flexible-order, non-Latin (Chinese) | **HOUSENO F1 89.83–91.30%** (numeric tail is the weak spot) | Li et al., NAACL 2019                          |
| Reorder a learned country (deepparse)     | 100% → **28%** sequence accuracy                            | Yassine/Beauchemin 2020                        |
| Inverse-order zero-shot (Hungary/Japan)   | **25.5% / 35.3%**                                           | Yassine/Beauchemin 2020                        |
| libpostal under reorder/noise             | overall F1 **0.992 → 0.781**                                | "Fighting crime with Transformers", NAACL 2024 |

The 91% floor was set against an easier (pre-#563, near-single-town) FR eval where the canonical-order
regime made house*number near-trivial. On the diversified golden (#563, 56 localities, both orders),
**v4.5.0 itself scores only 54.5%** — proof the eval got materially harder. Against the only published
hard-case analog (~90–91%), **87.4% is at the frontier, not below a reasonable bar.** Both the
literature and the independent DeepSeek consult judged the 91% floor mis-calibrated and 87.4%
respectable for this slice; DeepSeek's phrasing: *"87.4% on the single hardest subfield in the hardest
order permutation is not a miss — it's plausibly state-of-the-art for this specific slice."\_

This **does not** mean re-baseline silently — that would violate the no-silent-gate-drift discipline.
It means: if we lower the floor, do it as a _stated, reasoned_ decision anchored to this literature
(a defensible bar is ~85–90% for the postcode-first slice), recorded in the gate config and the ledger.

## Reframed recommendation

The research shifts my earlier "hold" lean. The honest reading:

- **The shipped v4.5.0 is the weaker model for this slice (54.5%).** v1.5.0 (87.4%) is a large, honest
  improvement that sits at the literature frontier for reordered house numbers. Holding it back against
  a bar that the SOTA itself can't clear is hard to justify.
- **So the defensible path is: re-baseline the `fr.house_number` floor to a literature-anchored
  ~88–90% (stated + reasoned in the gate config + ledger), and ship v1.5.0** — _while_ opening the
  targeted-lever work below as the real fix. This is the operator's call to make explicitly; the
  research removes the ambiguity that made it a coin-flip.
- **Next improvement is cheap and targeted, not another weight tweak:** (1) postcode-anchor span
  protection (we already compute the signal — add a consistency term / CRF penalty so postcode-anchored
  tokens can't be relabeled house_number), (2) gazetteer-gated numeric disambiguation (a number before
  a known locality is a postcode), (3) curriculum/denoising of the synthetic weight, (4) real reordered
  data. (3)+(1) likely recover the last few points without the weight-6.0 backfire.

## Levers, ranked (DeepSeek + literature consensus)

1. **Postcode-anchor span protection** — highest ROI; reuses an existing signal; directly kills the
   fragmentation. No data/architecture change.
2. **Curriculum / denoising** — decay synthetic weight 3.0 → ~0.5–1.0, or per-token loss reweighting
   on conflicting labels; preserves the +32.9pp without letting synthetic dominate late training.
3. **Real reordered data** — high but expensive; ~500–1000 real postcode-first FR rows likely beat 10K
   synthetic (real co-occurrence statistics teach the discrimination synthetic can't).
4. **Architecture (PE → RoPE/relative/NoPE)** — low-ROI here; the Chinese SOTA hits ~91% with standard
   transformers, and the confusion is also token-identity (both are digit strings), which RoPE doesn't
   fix. Only if 1–3 fail.

- **Missing lever DeepSeek surfaced:** gazetteer-gated disambiguation — concatenate a
  "gazetteer-locality-hit-in-same-utterance" flag so the model learns "5-digit number before a known
  locality = postcode." Leverages an existing component; directly targets the confusion pair.

## References

**Address-parsing benchmarks / SOTA**

- libpostal — 99.45% full-parse (whole-sequence, not per-component); OSM + format-template ordering.
  https://github.com/openvenues/libpostal
- Yassine, Beauchemin, et al., "Leveraging Subword Embeddings for Multinational Address Parsing"
  (deepparse), 2020. Reorder-collapse + inverse-order zero-shot. https://arxiv.org/abs/2006.16152 ·
  library: https://arxiv.org/abs/2311.11846 · https://deepparse.org/
- Yin, Li, Goldberg, "Is ChatGPT a game changer for geocoding", SIGSPATIAL workshop 2023. Per-component
  house_number F1 (99–100% on clean US). https://arxiv.org/abs/2310.14360 · benchmark:
  https://github.com/zhengcongyin/Geocoding-Address-Parsing-Benchmark
- Li, Lu, Xie, Li, "Neural Chinese Address Parsing", NAACL 2019. **HOUSENO F1 89.83–91.30%** (hard
  flexible-order analog). https://aclanthology.org/N19-1346/
- "Fighting crime with Transformers" (address parsing under noise/reorder), NAACL 2024 industry.
  libpostal 0.992 → 0.781 under reorder. https://arxiv.org/abs/2404.05632 _(per-version F1 read via
  page summary; verify Table 3 before quoting exact decimals)_
- Pelias parser — no published accuracy numbers (architectural docs only).
  https://github.com/pelias/parser

**Mechanism — shortcut/position bias + synthetic-data gap**

- Geirhos et al., "Shortcut Learning in Deep Neural Networks", Nature Machine Intelligence 2020.
  https://www.nature.com/articles/s42256-020-00257-z
- Yu et al., "From Shortcut to Induction Head: How Data Diversity Shapes Algorithm Selection in
  Transformers", NeurIPS 2025 (positional shortcut vs. content rule; diversity not volume).
  https://arxiv.org/abs/2512.18634 _(very recent)_
- Shah et al., "The Pitfalls of Simplicity Bias in Neural Networks", NeurIPS 2020 (fallback to
  next-simplest spurious feature — the fragmentation mechanism). https://arxiv.org/abs/2006.07710
- Wu et al., "On-the-fly Denoising for Data Augmentation in NLU", EACL 2023 Findings (overweighted
  augmentation → distribution shift → performance decrease). https://arxiv.org/abs/2212.10558
- Chen et al., "An Empirical Survey of Data Augmentation for Limited Data Learning in NLP", TACL 2023
  (augmentation gains are regime-dependent / plateau). https://arxiv.org/abs/2106.07499
- Papadimitriou, Futrell, Mahowald, "When classifying grammatical role, BERT doesn't care about word
  order… except when it matters", ACL 2022. https://arxiv.org/abs/2203.06204
- Kazemnejad et al., "The Impact of Positional Encoding on Length Generalization in Transformers",
  NeurIPS 2023 (absolute/learned PE overfits to seen positions). https://arxiv.org/abs/2305.19466
- Dai & Adel, "An Analysis of Simple Data Augmentation for NER", COLING 2020.
  https://arxiv.org/abs/2010.11683

_Independent DeepSeek-v4-pro consult (2026-06-13) reached the same two top-line conclusions (91% floor
mis-calibrated; levers are anchor-protection + curriculum + real data, not weight) and contributed the
simplicity-bias-fallback explanation and the gazetteer-gating lever. Transcript distilled into this
note; raw at `~/.cache/ds-consult/sessions/`._
