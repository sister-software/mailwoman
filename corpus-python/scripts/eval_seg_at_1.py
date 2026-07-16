"""#727 stage-2 Phase 1 GATE: does a segment decode over LEARNED span scores beat the token decode?

Baselines to beat (v264, ship config, triaged parity corpus): street token@1 0.573. A segment decode
over the SUMMED-BIO stand-in scored 0.453 — WORSE — which is exactly why a trained span scorer is
necessary and why decode-hardening alone was falsified (docs/articles/evals/
2026-07-15-night-3-postmortem.md). If seg@1 does not cross token@1 here, the arc is falsified: do NOT
tune span_loss_weight and re-run (that is the treadmill), run one diagnostic and fork.

This deliberately runs in Python against the torch checkpoint — Phase 1 must not depend on the ONNX
export path that Phase 2 builds.

Usage:
  uv run python scripts/eval_seg_at_1.py \
      --checkpoint /tmp/v300-ckpt \
      --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.9.0-multisplice \
      --fixtures ../mailwoman/eval-harness/fixtures/parity-corpus.triaged.jsonl
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import sentencepiece as spm
import torch

from mailwoman_train.labels import ID_TO_LABEL
from mailwoman_train.model import MailwomanCoarseEncoder
from mailwoman_train.span_scorer import SEGMENT_TYPES

# The street FAMILY, matching mailwoman/eval-harness/parity-corpus.ts PARITY_FLOORS.
STREET_TYPES = {"street", "street_prefix", "street_prefix_particle", "street_suffix"}


def fold(value: str) -> str:
    """Case-fold + collapse whitespace — the same comparison the JS parity gate uses."""
    return " ".join(value.lower().split())


def _surface(pieces: list[str]) -> tuple[str, list[tuple[int, int]]]:
    """Detokenized text + each piece's (start, end) char offsets into it.

    Offsets, not piece-concatenation: the JS parity harness reads each node's `value` by slicing the
    ORIGINAL text between the span's char offsets, so the spacing between spans survives. Joining the
    selected pieces instead silently drops the `O`-labelled bare `▁` separator and welds words
    together — `▁5 | th | ▁ | Ave` becomes "5thAve" instead of "5th Ave", which scored token@1 at
    0.285 against a known 0.573 until this was caught.
    """
    text = ""
    offsets: list[tuple[int, int]] = []
    for piece in pieces:
        chunk = piece.replace("▁", " ")
        offsets.append((len(text), len(text) + len(chunk)))
        text += chunk
    return text, offsets


def _join_runs(text: str, offsets: list[tuple[int, int]], selected: list[int]) -> str:
    """Slice each maximal contiguous run of selected pieces, join with ' ' — mirrors the JS harness.

    The JS side emits one NODE per span (street, street_suffix, …) and joins their values with a
    space; a contiguous run of pieces is exactly one such node.
    """
    if not selected:
        return ""
    runs: list[list[int]] = [[selected[0]]]
    for idx in selected[1:]:
        if idx == runs[-1][-1] + 1:
            runs[-1].append(idx)
        else:
            runs.append([idx])
    return " ".join(text[offsets[r[0]][0] : offsets[r[-1]][1]].strip() for r in runs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    args = parser.parse_args()

    tokenizer_path = args.tokenizer / "tokenizer.model" if args.tokenizer.is_dir() else args.tokenizer
    sp = spm.SentencePieceProcessor(model_file=str(tokenizer_path))
    model = MailwomanCoarseEncoder.from_pretrained(args.checkpoint).eval()

    if not model.use_span_scorer:
        raise SystemExit("checkpoint has no span scorer — wrong checkpoint?")

    rows = [json.loads(line) for line in args.fixtures.read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = [r for r in rows if not r.get("dropped") and r.get("expect", {}).get("street")]

    token_hit = seg_hit = 0

    for row in rows:
        pieces = sp.encode(row["input"], out_type=str)
        ids = torch.tensor([[sp.piece_to_id(p) for p in pieces]])
        mask = torch.ones_like(ids)
        text, offsets = _surface(pieces)

        with torch.no_grad():
            out = model(input_ids=ids, attention_mask=mask)

        # token@1 — the shipped decode's shape: BIO argmax over street-family pieces.
        # strict=True: pieces and labels are the same sequence — a length mismatch is a bug, not
        # something to silently truncate past.
        bio = [ID_TO_LABEL[int(i)] for i in out.logits[0].argmax(-1)]
        token_street = _join_runs(
            text,
            offsets,
            [i for i, lab in enumerate(bio) if lab != "O" and lab.split("-", 1)[1] in STREET_TYPES],
        )

        # seg@1 — the semi-Markov argmax segmentation over street-family segments.
        segmentation = model.semi_crf.decode(out.span_scores, mask.sum(dim=1).long())[0]
        seg_street = _join_runs(
            text,
            offsets,
            [
                i
                for (start, length, type_id) in sorted(segmentation)
                if SEGMENT_TYPES[type_id] in STREET_TYPES
                for i in range(start, start + length)
            ],
        )

        gold = fold(" ".join(row["expect"]["street"]))

        if fold(token_street) == gold:
            token_hit += 1

        if fold(seg_street) == gold:
            seg_hit += 1

    total = len(rows)
    print(f"parity street-scored fixtures: {total}")
    print(f"  token@1 : {token_hit}/{total} = {token_hit / total:.4f}")
    print(f"  seg@1   : {seg_hit}/{total} = {seg_hit / total:.4f}")
    verdict = "PASS — trained span scorer beats the token decode" if seg_hit > token_hit else "FAIL"
    print(f"\nGATE (seg@1 > token@1): {verdict}")
    print(
        "\nNOTE: these numbers are CHANNEL-STARVED and are NOT comparable to the JS harness's\n"
        "  `mailwoman eval parity --weights-cache` (v264 street token@1 0.573). This script feeds no\n"
        "  anchor/gazetteer/country channels, no postcodeRepair, no word-consistency heal — the #718\n"
        "  trap — so token@1 here reads ~0.35 on the same model. The GATE is still valid as a RELATIVE\n"
        "  comparison: both heads read the same starved encoder state. Do not quote these absolutes."
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
