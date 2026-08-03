---
title: "#727 Phase 3 — the JS k-best decode, measured on production config"
---

# Phase 3 — seg@1 on the production harness, and a correction to Phase 1's headline

Phase 3 built the JS/WASM side: `span_scores` through `ONNXRunner` → `NeuralParseTrace` → a k-best
semi-Markov decode (`neural/semi-markov-decode.ts`, 11 tests, brute-force verified like its Python
twin). That unlocks the measurement Phase 1 **could not make**: `seg@1` with the anchor / gazetteer /
country channels **fed**, against the real 0.573 baseline.

## The headline, and it corrects me

**Phase 1 claimed the span head beats the token decode by +7.9pp. With channels fed, that margin is
+0.75pp — two fixtures, inside noise.**

| triaged parity corpus (n=267) | v264, BIO-summed spans (night-3) | **v301, learned spans (now)** |
| ----------------------------- | -------------------------------- | ----------------------------- |
| token@1                       | 0.573                            | 0.5693                        |
| **seg@1**                     | 0.453                            | **0.5768**                    |
| oracle@5                      | 0.663                            | **0.7228**                    |
| oracle@10                     | 0.749                            | **0.7753**                    |

Phase 1's +7.9pp was measured in the channel-starved Python gate, where `token@1` reads 0.4906
instead of 0.5693. **A large part of that gap was the BIO head's starvation, not the span head's
strength.** Feed the channels and the BIO head recovers most of it. The Phase-1 doc flagged the
absolutes as non-comparable; it did not anticipate that the _margin_ would shrink this much, and the
honest correction belongs at the top rather than in a footnote.

## What survives the correction — and it's the part that matters

**1. The trained scorer beats the summed-BIO stand-in by +12.4pp** (seg@1 0.453 → 0.5768), on the
same instrument, channels fed both times. That was Phase 1's actual falsifier and it holds decisively.

**2. The secondary read passed: oracle@10 rose 0.749 → 0.7753** (+2.6pp), oracle@5 0.663 → 0.7228
(+6.0pp). The config pre-registered this: _"If seg@1 crosses but oracle@10 is flat, the scorer
reshuffled the list without learning better spans."_ It is not flat. The **list** genuinely improved.

**3. On the class the arc targets, it is not close:**

| Paris fixture (n=63, bare-fragment heavy) | v264   | **v301 span decode** |
| ----------------------------------------- | ------ | -------------------- |
| token@1                                   | 0.5238 | 0.5238               |
| **seg@1**                                 | —      | **0.7619** (+23.8pp) |
| oracle@5                                  | —      | **0.9048**           |

`token@1` is byte-identical (33/63) to the v264 baseline, so this is a clean A/B on the same encoder
state: **+23.8pp at rank 1**, and oracle@5 clears **0.90** on this fixture.

## The synthesis

The span head's value is **concentrated exactly where the BIO head fails**. On contextful addresses —
most of the general corpus — BIO + channels already works and the span decode adds ~nothing at rank 1.
On bare fragments it adds 24 points. That is a coherent result, not a disappointing one: it is the
night-3 partition (66% of street failures are bare fragments) showing up in the ledger.

**But it also means `seg@1` alone does not justify shipping the decode.** A +0.75pp aggregate margin
is not a reason to change production. The case is the **list**: oracle@5 0.723 / oracle@10 0.775
against a shipped 0.573 is ~15–20 points of headroom that only a **reranker** can collect — which is
Phase 4, and which is now the load-bearing phase rather than a nice-to-have.

## What shipped

- `ONNXRunner.InferResult.spanScores` + `maxSpan` — optional, mirroring the `localeLogits` contract; a
  pre-v3 bundle has no `span_scores` output and the BIO path is untouched.
- `NeuralParseTrace.spanScores` — threaded through `traceParse`.
- `neural/semi-markov-decode.ts` — `decodeSegmentationsKBest` + `parseSemiCRFTransitions`. **11 tests**:
  rank-1 vs brute-force argmax, the k-best **list** vs brute-force top-k _in order_, exact coverage,
  the O-length-1 rule under adversarial scores, and four sidecar-validation throws (a transition
  matrix that disagrees with `segment_types`, a non-`O` index 0, a missing `max_span`).
- The segment-type axis is read from `semi-crf-transitions.json`, never hardcoded (PLACETYPE_ORDER
  class).

`yarn ci:test:fast`: **3481 pass**, 0 fail.

## The browser side — done, and measured on the runtime that ships

`WebONNXRunner` reads `span_scores` with the same optional contract (pre-v3 bundles → `undefined` →
BIO path byte-unaffected). The decoder itself is pure TS with no ORT dependency, so **one decoder
serves both hosts**.

The read is now duplicated across `neural/onnx-runner.ts` and `neural-web/web-onnx-runner.ts`, which
is a real drift hazard — a transposed unflatten in one host would mis-tag every span (the
PLACETYPE_ORDER failure mode, one layer down). A **cross-runner parity test** pins them: the same
flat buffer must produce the same nested array on both sides.

**#378 SLO, measured on `onnxruntime-web`'s WASM EP** — the runtime the demo actually runs, not the
`onnxruntime-node` bench Phase 2 used:

|                                | ms/infer             | spans read |
| ------------------------------ | -------------------- | ---------- |
| v264 (shipped, no span output) | 14.74                | no         |
| v301 (span graph)              | 14.82                | **yes**    |
| **delta**                      | **+0.08 ms (+0.5%)** |            |

That is the **full** cost — this runner unflattens the span tensor on _every_ inference, so it
includes the decode-side marshalling, not just the graph. Reproducible via
`neural-web/span-slo.bench.test.ts` (reported, never asserted — a wall-clock threshold in CI is a
flake generator).

Combined with Phase 2's size gate (+0.22 MB int8, +0.57%), the browser cost of carrying the span head
is **+0.5% latency and +0.6% download** — and that is while _reading_ the spans. A browser that never
decodes them pays neither.

**Still not done, deliberately:** the loader does not fetch `semi-crf-transitions.json`. Nothing
consumes it in the browser yet — the rerank is Phase 4 — and wiring a fetch for data with no consumer
is the speculative structure this project keeps refusing (cf. the `<= -0.5` importance band, #1142).

## Next

Phase 4 is now the whole ballgame: resolver rerank over the k-best list + the isotonic calibration for
the ambiguity gate + option C (kind-posterior + recall-weighted loss) for the 17 locality-refusals the
span head provably does not fix. The headroom is measured (oracle@5 0.723 vs shipped 0.573); the
question is how much of it evidence-based reranking can actually collect.
