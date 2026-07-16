"""Quantify the tokenizer's numeric-piece coverage — the vocab lever for the digit defect.

The digit-ownership incoherence (docs/.../2026-07-16-digit-incoherence-is-cross-lingual.md) is rooted
in digit fertility: `178` -> ['▁1','7','8'], and the continuations carry the postcode mass. This
audits how many multi-digit pieces the shipped tokenizer actually has, which tells the operator
whether the vocab fix is a small splice or a tokenizer retrain.
"""

import collections
import re

import sentencepiece as spm

MODEL = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.9.0-multisplice/tokenizer.model"
sp = spm.SentencePieceProcessor(model_file=MODEL)

by_len = collections.defaultdict(list)
for i in range(sp.get_piece_size()):
    core = sp.id_to_piece(i).lstrip("▁")
    if core and re.fullmatch(r"\d+", core):
        by_len[len(core)].append(sp.id_to_piece(i))

print(f"vocab: {sp.get_piece_size():,}   pure-digit pieces by length:")
for L in sorted(by_len):
    print(f"  {L}-digit: {len(by_len[L])} — {by_len[L][:10]}")
print("\nfertility of representative numbers:")
for n in ["7", "16", "24", "91", "140", "178", "1918", "90210"]:
    p = sp.encode_as_pieces(n)
    print(f"  {n:>6} -> {p} ({len(p) - 1} continuations)")
