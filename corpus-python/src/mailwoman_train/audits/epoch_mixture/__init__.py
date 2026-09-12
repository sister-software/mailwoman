"""Full-epoch requested-vs-realized source/country mixture audit.

2026-08-09 training-substrate audit (HANDOFF-CODEX-TO-CLAUDE §6, action 7): the 250k-row
prefix audits ended before any source exhausted, so the non-stationary sampler — a source
deleted and the mixture renormalized mid-epoch — was invisible to them. This audit consumes
ONE full row-limited epoch (the unit the trainer loops) and reports the mixture at two
levels:

- **draw level** — ``_raw_row_stream``'s own output (pre-augmentation), counted per fixed
  window of draws. This is the direct stationarity receipt for the cycling-sampler repair:
  every window of the epoch must hold every source at its requested share.
- **emitted level** — the same stream through ``emit.emit_row`` under the config's augmentation
  policy, counting what fills the trainer's ``row_limit`` budget. Augmented copies compete with
  originals for that budget, and augmentability is source-specific, so
  ``distortion_vs_draw_share`` quantifies the realized-weight distortion per source for
  quota design. The affix relabel pass mutates labels, never row counts, so its lexicon is
  deliberately left out of the policy here.

The emitted pass runs the SAME function the trainer runs (``emit.emit_row``), which is what
makes its counts comparable with a training run's. It reimplemented that step until #2243, and
the copy omitted ``augment_exclude_sources`` — so an excluded source was reported with the
count it would have had if augmented. It still skips ``iter_rows``' shuffle buffer, which
reorders rows and cannot change counts. With every probability at zero the two passes consume
the rng identically and their counts are byte-equal (pinned by the test).

Three modules: `passes` runs the epoch, `receipts` holds the hypothesis a recipe asserts about its
corpus and the bytes that bind a passing audit to it, `cli` reads a recipe and prints the mixture.

Typical volume-side run (see ``train_remote.py::audit_epoch_mixture``)::

    python -m mailwoman_train.audits.epoch_mixture \
      --config src/mailwoman_train/configs/v4.3.3-suffix-boundary-base-60k.yaml \
      --json epoch-mixture-audit.json
"""

from __future__ import annotations

from .cli import DOSE_OUTLIER_MULTIPLE, main, print_summary, run
from .passes import (
    AUGMENT_KEYS,
    DrawPass,
    EmittedPass,
    audit_mixture,
    emitted_per_source,
    normalized_augment,
    requested_shares,
    run_draw_pass,
    run_emitted_pass,
)
from .receipts import (
    CorpusReceiptError,
    component_sequence,
    contains_contiguous,
    corpus_receipt_binding,
    matches_receipt,
    verify_corpus_receipt_binding,
    verify_corpus_receipt_report,
)

__all__ = [
    "AUGMENT_KEYS",
    "DOSE_OUTLIER_MULTIPLE",
    "CorpusReceiptError",
    "DrawPass",
    "EmittedPass",
    "audit_mixture",
    "component_sequence",
    "contains_contiguous",
    "corpus_receipt_binding",
    "emitted_per_source",
    "main",
    "matches_receipt",
    "normalized_augment",
    "print_summary",
    "requested_shares",
    "run",
    "run_draw_pass",
    "run_emitted_pass",
    "verify_corpus_receipt_binding",
    "verify_corpus_receipt_report",
]
