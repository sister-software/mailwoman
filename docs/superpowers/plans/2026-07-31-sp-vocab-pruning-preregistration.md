# SP vocabulary-pruning probe — pre-registration (task #25, written before any measurement)

**Claim under test** (2026-07-30 tokenizer survey): the embedding table is about 72% of model
parameters (`token_embeddings.weight_quantized [73143, 384]`, 28.1M of 39.26M), and vocab
utilization is at most 24%. Pruning pieces that never fire would then shrink the int8 artifact
substantially with **zero behavior change** on every input whose segmentation never used a pruned
piece.

## Mechanism (decided before measuring)

1. **Measure the fired set over the full v0.15.0-venue feed** (684,103,970 rows, all 704 train
   extracts) and over every eval surface (eval-harness fixtures, golden sets, gauntlet cases, P0
   boards). The measurement does not sample, because a sampled fired set could prune a rare piece
   that training still uses, and this probe exists to keep that tail. Counts are taken at the unit
   the model reads: `encode()` output ids.
2. **Keep set** `K` = specials (pad/unk/bos/eos) ∪ all 256 byte-fallback pieces ∪ every
   single-codepoint piece (6,818) ∪ fired(train) ∪ fired(evals). The single-codepoint pieces set
   the reachability floor. Any char the vocab knows directly keeps its direct token, so in the
   worst case only chars absent from the vocab fall back to bytes. Prune set `P` = vocab ∖ K.
3. **Tokenizer surgery:** strip `P` from the SentencePiece model proto while preserving order
   (the #825 `tokenizer_splice.py` idiom, inverted). In a unigram model, removing pieces that never
   won a Viterbi path leaves every other path's score unchanged. Segmentation is therefore
   identical by construction for any input whose best path avoided `P`.
4. **ONNX surgery directly on the INT8 artifact:** row-gather `weight_quantized` by the old→new id
   map. Never prune and then requantize. Requantization changes the scale globally and loses
   bit-parity. Selecting rows of a quantized tensor with unchanged scale and zero-point keeps every
   kept row byte-identical.

## Bars (pass/fail, pre-registered)

- **B1 — segmentation byte-identity:** the original and pruned tokenizers produce identical piece
  sequences (modulo id renumbering) on (a) every eval-fixture raw string and (b) a fresh 1M-row
  random sample of the training feed. The bar is **zero diffs**. One diff means the keep rule is
  wrong, and the probe stops. A third guess requires a conversation with the operator.
- **B2 — logit bit-parity:** the original and pruned ONNX models, with ids remapped, produce
  **bitwise equal** logits on at least 200 eval inputs. Only the gather table changes in the graph,
  and the kept rows are byte-identical. Any difference means the surgery changed something it
  should not have.
- **B3 — the full battery:** the gauntlet (regression + metamorphic) and the `v7.0.0-base` check
  run on the pruned pair, which must **PASS with scores identical** to the shipped pair. Scores
  within margins are not enough. B1 and B2 imply identical parses, so any score delta is a defect.
- **Receipt:** artifact sizes before and after (int8 onnx + tokenizer.model), the percentage of
  params removed, and utilization telemetry (fired counts and the band of pieces that almost never
  fire).

## What this probe is NOT

This probe does not ship anything. The deliverable is the verdict, the staged artifact pair and
this record. Shipping a pruned pair is a model-artifact change and an operator decision. It would
go out on a release train with its own model-card updates (files_md5, link-dev pins), HF/R2
staging, and the browser loader's size expectations. The WASM runtime (task #26) is unaffected,
because the pruned tokenizer.model is a standard SP proto that the same runtime loads.

## Stop rules

If any bar misses, record the miss, do not promote the artifact, and add the findings to the
register. The two-guess limit from the training arcs applies to the keep rule. One revision of `K`
is allowed if B1 identifies a specific reachable class, such as a piece the normalizer produces
that the corpus walk can't see. A second miss ends the probe with a NEGATIVE verdict.
