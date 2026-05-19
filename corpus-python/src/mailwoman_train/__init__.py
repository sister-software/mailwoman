"""Mailwoman Phase 2 training package.

Subcommand CLI: ``python -m mailwoman_train <command>``. See ``cli.py`` for the registry.

Stage 1 (this phase) is coarse-only: train a token-classification head over the 7 coarse
ComponentTags (country/region/locality/dependent_locality/postcode/subregion/cedex) plus ``O``.
Stages 2 (street) and 3 (venue) are explicit future phases — do not extend the label set here.

Per the Phase 2 plan in issue #10:

- Data loading via ``datasets.load_dataset('parquet', ...)`` — streaming, memory-stable.
- Model: ``BertConfig`` + ``BertForTokenClassification`` with a small from-scratch config
  (6 layers, 256 hidden, 4 heads, 1024 FF, max_position 128, vocab from tokenizer v0.1.0).
- Training: AdamW lr 5e-4, linear warmup 1k → cosine decay, batch 256, ~50k steps.
- Eval: per-component F1/precision/recall + full-parse exact match against the golden set.
- Export: ONNX opset 17, dynamic axes; verify parity with PyTorch within 1e-4 over 1000 inputs.
- Quantize: int8 dynamic via ``onnxruntime.quantization``; verify <0.5% F1 drop vs fp32.
- Package: write ``packages/neural-weights-{en-us,fr-fr}/`` data-only dirs.
"""

__version__ = "0.1.0"
