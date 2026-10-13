# The span decode's ship case is refuted — by the extract, on the span decode's own target class

**Question:** with T2 landed, would we still ship the span decode behind a flag, as §6 of the
[review follow-up](./2026-07-16-span-head-arc-review-follow-up.md) unanimously recommended?

**Answer: no — and not for the reason we pre-registered.** The flag rested on one number, and a plain
token decode on the extract-trained model beats that number by 8 fixtures.

---

## 1. The measurement

Paris target class, n=63, production config, int8 against int8:

|                                                 |                   | 95% Wilson     |
| ----------------------------------------------- | ----------------: | -------------- |
| v264 `token@1` (shipped)                        |     33/63 = 0.524 | [0.403, 0.642] |
| v301 `seg@1` — **the flag's entire case**       |     48/63 = 0.762 | [0.644, 0.850] |
| v310 `token@1` — **the extract without a head** | 56/63 = **0.889** | [0.788, 0.945] |

```
the flag's claim : v264 token -> v301 seg   = +23.8pp
the extract alone  : v264 token -> v310 token = +36.5pp
span decode's MARGINAL value over the extract : -12.7pp
```

§6 valued the flag "for the list and the target class (+23.8pp Paris)". On that target class the
span decode is now **second best, behind a simpler thing**. An opt-in path that loses to the default
is not a feature.

## 2. What this does and does not establish

**It does not establish "span decode < token decode."** The comparison is between **artifacts** —
v301 (old corpus) + span vs v310 (new corpus) + token. Two variables move at once.

**It is exactly the ship question.** "Should we ship this flag?" is a question about artifacts, and
the answer is no: a strictly better and strictly simpler artifact exists. A user choosing between the two
has no reason to opt into the worse one.

## 3. Why §6 was right and is now wrong

§6 recommended the flag on the belief that the span decode **owned** the bare-fragment class — that
the +23.8pp was the span head's to give. T1c and T2 falsified the belief:

- **T1c** found the cause: the house number is a **license** rather than a hint. Bare streets read as
  localities because the training distribution taught that rather than because the decode couldn't express
  the span.
- **T2** fixed the distribution. The class the span decode was ordered to rescue got rescued by
  data — further, and without a decode change.

The decision was correct given what was known. The premise moved underneath it. That is what a
pre-registered plan is for: §6's own text made the flag conditional (_"Tier 1a decides whether the
flag has a regression cost that has not been identified yet"_), and the tiers below it kept going.

## 4. Off-by-default is not free

The tempting move is to ship it off by default on the assumption that an unused flag adds no cost.
An off-by-default flag still adds the following:

- an **API surface** we have to keep.
- a **maintenance burden** on a decode path that no check validates.
- an **implicit endorsement** of weights trained on a corpus we have since replaced.
- a **worse experience for anyone who opts in**. Those users are the flag's only population.

## 5. The one open question — and it is the last one

Everything above compares artifacts. The within-model question has never been asked on a corpus that
teaches bare streets, because **no span head has ever been trained on one**. That is
`v3.2.0-fragment-span` (run `ap-jcRsH8TNQny84vVeOWLG8f`), one variable off v310: the head.

Pre-registered kill shot: **`seg@1` must beat v310's `token@1` = 56/63 (0.889)** — the bar the flag
failed by 12.7pp. If an extract-trained span head cannot beat an extract-trained plain decode on the target
class, the span head has no case **at any weight**, and the arc closes. The arc does not then tune
`span_loss_weight` or re-run. That is the treadmill the arc's own guard forbids.

## 6. What the arc bought anyway

The arc ran four phases and, as of this page, produced zero shippable artifacts.

It did produce the reason the fix exists at all. `oracle@k` and the k-best decode were the
instruments that made the headroom **visible** (oracle@10 0.775 against a 0.577 rank-1). That gap was
invisible while every check scored top-1. The gap motivated T1a's cross-tab. The cross-tab found the
digit-eating and forced the hallucination check. That check motivated T1c's board. The board found
the license. The license finding built T2's extract, and the extract fixed the class.

The arc asked whether a better decode could find the correct parse. The reply turned out to be that
the correct parse was never in the list to be found, because it was not in the training data. **The instrument
that proved the answer wasn't there is what led us to put it there.**

---

**Reproduce:** `node scratchpad/paris-3way.mjs`.
