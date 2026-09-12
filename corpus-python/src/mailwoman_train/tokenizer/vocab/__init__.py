"""Measuring which tokenizer pieces a corpus actually fires, and pruning the ones it never does.

Three steps, each its own `python -m` entry point: `utilization` counts what fires, `prune` writes a
narrower tokenizer from that count, and `prune_verify` checks the narrowed one still encodes the
eval surface identically. They were `vocab_utilization.py`, `vocab_prune.py` and
`vocab_prune_verify.py` beside the rest of `tokenizer/`, which put the hierarchy in the names.
"""

from __future__ import annotations
