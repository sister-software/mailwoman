# #727 stage-2 Phase 2 — ONNX export of the span scores + the #378 SLO check

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The v301 span scorer's outputs become consumable outside torch: `span_scores` as a named
ONNX output, the segment-transition table as a JSON sidecar, and a measured verdict on the #378
browser SLO (size + latency). Phase 3's JS decoder consumes both.

**Architecture:** Extend `export_to_onnx`'s existing wrapper/`with_locale` pattern with a
`with_spans` toggle — outputs are fetched **by name**, so appending `span_scores` is
backward-compatible (a consumer that never asks for it pays nothing; ORT prunes unfetched graph
branches). The transition table follows the `export_crf_transitions` JSON-sidecar precedent —
transitions are decode-time data, not graph.

**Gate (pre-registered):**

1. ONNX `span_scores` ≈ torch `span_scores` (atol 1e-3 fp32) on random inputs — parity or no ship.
2. int8 size delta vs v264's 39.8 MB within +1 MB (the head is 101k params ≈ +0.1 MB int8).
3. Fetching ONLY `logits` from the span-enabled graph costs ≤5% latency vs the v264 graph — the
   browser must not pay for spans it doesn't decode. (5% is noise floor, not a tuned number.)

**Non-goals:** JS decode (Phase 3), rerank/option-C (Phase 4), any promotion — v301 is a probe
checkpoint; this phase proves the _path_, not the artifact.

## Global constraints

- Quantization runs on Modal — the LOCAL onnxruntime trips ShapeInferenceError on the dynamo graph
  (documented in `quantize_onnx`); the training image's pinned ORT is the quantizer.
- Export runs local CPU (torch export of a 39M model is minutes; the checkpoint is already local).
- `use_span_scorer=False` exports byte-identically to today — the `with_spans` toggle must default
  off and the no-span path must not change.

## Tasks

### Task 1: `with_spans` in the export wrappers (TDD)

- Test: tiny geometry model with `use_span_scorer=True` → exported ONNX has outputs
  `["logits", "span_scores"]` (+ `locale_logits` when locale head present); ONNX `span_scores`
  matches torch within atol 1e-3; a `use_span_scorer=False` model exports `["logits"]` only.
- Implement: mirror `with_locale` — each wrapper gains `with_spans`, return tuple appends
  `out.span_scores`, `output_names` appends `"span_scores"`.

### Task 2: `export_semi_crf_transitions()` sidecar (TDD)

- Test: returns the sidecar dict — `segment_types`, `transitions` (T×T), `start_transitions`,
  `end_transitions`, `max_span` — for a span model; `None` for a span-less model; segment_types round-trips
  `SEGMENT_TYPES` exactly (the PLACETYPE_ORDER dual-maintenance class — the JS decoder must read the
  axis from the file, never hardcode it).
- Implement in `package_weights.py` next to `export_crf_transitions`.

### Task 3: export v301 fp32 locally + parity-check against torch on real inputs.

### Task 4: quantize on Modal + measure the SLO

- `modal run …::quantize_onnx` on the uploaded fp32.
- Size: int8 vs v264's 39,838,216 bytes.
- Latency: python onnxruntime, 128-token input, 200 iters — (a) v264 graph fetch `logits`,
  (b) v301 graph fetch `logits` only, (c) v301 graph fetch `logits`+`span_scores`.
  Gate is (b) vs (a) ≤5%; (c)−(b) is the _decode cost budget_ Phase 3 inherits, record it.

### Task 5: verdict doc + commit + PR update.
