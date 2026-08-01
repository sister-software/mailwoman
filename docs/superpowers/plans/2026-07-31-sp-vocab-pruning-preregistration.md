# SP vocabulary-pruning probe — pre-registration (task #25, written before any measurement)

**Claim under test** (2026-07-30 tokenizer survey): the embedding table is ~72% of model
parameters (`token_embeddings.weight_quantized [73143, 384]`, 28.1M of 39.26M) at ≤24% vocab
utilization — pruning never-fired pieces shrinks the int8 artifact substantially at **zero
behavior change** on every input whose segmentation never used a pruned piece.

## Mechanism (decided before measuring)

1. **Fired-set measurement over the FULL v0.15.0-venue feed** (684,103,970 rows, all 704 train
   shards — no sampling: a sampled fired-set risks pruning a rare-but-practiced piece, the exact
   tail this probe exists to keep) plus every eval surface (eval-harness fixtures, golden sets,
   gauntlet cases, P0 boards). Counted at the unit the model reads: `encode()` output ids.
2. **Keep set** `K` = specials (pad/unk/bos/eos) ∪ all 256 byte-fallback pieces ∪ every
   single-codepoint piece (6,818 — the reachability floor: any char the vocab knows directly
   keeps its direct token, capping worst-case segmentation drift at byte-fallback for truly
   unknown chars only) ∪ fired(train) ∪ fired(evals). Prune set `P` = vocab ∖ K.
3. **Tokenizer surgery**: strip `P` from the SentencePiece model proto, order-preserving
   (the #825 `tokenizer_splice.py` idiom, inverted). Unigram property: removing pieces that never
   won a Viterbi path leaves every other path's score unchanged — segmentation is IDENTICAL for
   any input whose best path avoided `P`, by construction.
4. **ONNX surgery on the INT8 artifact directly**: row-gather `weight_quantized` by the old→new
   id map. Never prune-then-requantize — requantization changes the scale globally and forfeits
   bit-parity; row-slicing a quantized tensor with unchanged scale/zero-point keeps every kept
   row byte-identical.

## Bars (pass/fail, pre-registered)

- **B1 — segmentation byte-identity**: piece sequences identical (modulo id renumbering) between
  original and pruned tokenizer on (a) every eval-fixture raw string and (b) a fresh 1M-row
  random sample of the training feed. Bar: **zero diffs**. One diff = the keep rule is wrong →
  stop, no third guess without an operator conversation.
- **B2 — logit bit-parity**: original vs pruned ONNX on ≥200 eval inputs (ids remapped): logits
  **bitwise equal**. The graph is unchanged except the gather table; kept rows are byte-identical;
  anything non-equal means the surgery touched something it shouldn't have.
- **B3 — the full battery**: gauntlet (regression + metamorphic) + the `v7.0.0-base` gate on the
  pruned pair — **PASS with scores identical** to the shipped pair (not merely within margins:
  B1+B2 imply identical parses; any score delta is a defect).
- **Receipt**: artifact sizes before/after (int8 onnx + tokenizer.model), % params removed,
  utilization telemetry (fired counts; the near-zero-practice band).

## What this probe is NOT

Not a ship. The deliverable is the verdict + the staged artifact pair + this record. Shipping a
pruned pair is a model-artifact change that rides a release train with its own card lockstep
(files_md5, link-dev pins), HF/R2 staging, and the browser loader's size expectations — operator
decision. The WASM runtime (task #26) is untouched: the pruned tokenizer.model is a standard SP
proto the same runtime loads.

## Stop rules

Any bar misses → record the miss, no artifact promotion, findings to the register. The 2-guess
envelope from the training arcs applies to the keep rule: one revision of `K` is allowed if B1
names a specific reachable class (e.g. a normalizer-produced piece the corpus walk can't see);
a second miss ends the probe with a NEGATIVE verdict.
