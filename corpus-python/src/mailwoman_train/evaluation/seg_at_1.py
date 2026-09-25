from __future__ import annotations

import argparse
import json
from pathlib import Path

import sentencepiece as spm
import torch

from ..labels import ID_TO_LABEL
from ..nn.encoder import MailwomanCoarseEncoder
from ..nn.span_scorer import SEGMENT_TYPES

STREET_TYPES = {"street", "street_prefix", "street_prefix_particle", "street_suffix"}


def fold(value: str) -> str:
    return " ".join(value.lower().split())


def _surface(pieces: list[str]) -> tuple[str, list[tuple[int, int]]]:
    text = ""
    offsets: list[tuple[int, int]] = []
    for piece in pieces:
        chunk = piece.replace("▁", " ")
        offsets.append((len(text), len(text) + len(chunk)))
        text += chunk
    return text, offsets


def _join_runs(text: str, offsets: list[tuple[int, int]], selected: list[int]) -> str:
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

        bio = [ID_TO_LABEL[int(i)] for i in out.logits[0].argmax(-1)]
        token_street = _join_runs(
            text,
            offsets,
            [i for i, lab in enumerate(bio) if lab != "O" and lab.split("-", 1)[1] in STREET_TYPES],
        )

        if model.semi_crf is None:
            raise RuntimeError("this checkpoint has no span scorer; seg@1 needs one to decode")
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
        "  trap — so token@1 here reads ~0.35 on the same model. The CHECK is still valid as a RELATIVE\n"
        "  comparison: both heads read the same starved encoder state. Do not quote these absolutes."
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
