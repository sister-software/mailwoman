"""Measure which tokenizer pieces a corpus uses and prune the unused ones.

Three steps each have a `python -m` entry point. `utilization` counts used pieces. `prune` writes a
narrower tokenizer from that count. `prune_verify` checks whether it still encodes the eval surface
identically. The earlier files were `vocab_utilization.py`, `vocab_prune.py`, and
`vocab_prune_verify.py` beside the rest of `tokenizer/`, which put the hierarchy in the names.
"""

from __future__ import annotations
