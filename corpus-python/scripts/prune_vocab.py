"""Task #25 (SP vocab-pruning probe) — the artifact surgery pair.

Given the fired-count measurement (measure_vocab_utilization.py) plus the eval-surface fired set,
build the pruned tokenizer.model + pruned int8 model.onnx per the pre-registered keep rule
(docs/superpowers/plans/2026-07-31-sp-vocab-pruning-preregistration.md):

    K = specials ∪ byte-fallback ∪ single-codepoint pieces ∪ fired(train) ∪ fired(evals)

Tokenizer surgery is the #825 `tokenizer_splice.py` idiom inverted: strip pruned pieces from the
SentencePiece model proto, order-preserving. Unigram invariant: a piece that never won a Viterbi
path contributes nothing to any other path's score, so segmentation is identical for every input
whose best path avoided the pruned set — asserted downstream (bar B1), not hoped.

ONNX surgery operates on the INT8 artifact directly: row-gather `token_embeddings.weight_quantized`
by the old→new id map with scale/zero-point untouched — kept rows stay byte-identical, which is
what makes bar B2 (logit bit-parity) provable rather than approximate. Never prune-then-requantize.

Usage:
    python corpus-python/scripts/prune_vocab.py \
        --tokenizer neural-weights-en-us/tokenizer.model \
        --onnx $MAILWOMAN_DATA_ROOT/models/quantized/model-v401-base-step-060000-int8.onnx \
        --train-counts $MAILWOMAN_DATA_ROOT/scratch-vocab-prune/utilization-v0150-venue.npz \
        --eval-fired $MAILWOMAN_DATA_ROOT/scratch-vocab-prune/eval-fired.json \
        --out-dir $MAILWOMAN_DATA_ROOT/scratch-vocab-prune/pruned-v1
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--onnx", required=True)
    parser.add_argument("--train-counts", required=True)
    parser.add_argument("--eval-fired", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    import onnx
    import sentencepiece as spm
    from onnx import numpy_helper
    from sentencepiece import sentencepiece_model_pb2 as sp_pb2

    sp = spm.SentencePieceProcessor()
    sp.LoadFromFile(args.tokenizer)
    vocab_size = sp.get_piece_size()

    counts = np.load(args.train_counts)["counts"]
    assert counts.shape == (vocab_size,), f"counts shape {counts.shape} != vocab {vocab_size}"
    eval_fired = set(json.loads(Path(args.eval_fired).read_text())["fired_ids"])

    keep = np.zeros(vocab_size, dtype=bool)
    keep[counts > 0] = True
    keep[list(eval_fired)] = True

    # Specials: ids 0-3 (pad/unk/bos/eos) plus any piece the proto marks non-NORMAL (control /
    # unused / byte). Byte-fallback pieces are type BYTE — kept via the same check.
    proto = sp_pb2.ModelProto()
    proto.ParseFromString(Path(args.tokenizer).read_bytes())
    assert len(proto.pieces) == vocab_size

    normal = sp_pb2.ModelProto.SentencePiece.Type.NORMAL
    single_codepoint = 0

    for i, piece in enumerate(proto.pieces):
        if piece.type != normal:
            keep[i] = True
            continue

        # The reachability floor: every single-codepoint piece stays (▁-only prefix stripped —
        # a "▁x" piece is the word-initial form of one codepoint and stays too).
        literal = piece.piece.removeprefix("▁")

        if len(literal) <= 1:
            keep[i] = True
            single_codepoint += 1

    kept_ids = np.flatnonzero(keep)
    old_to_new = np.full(vocab_size, -1, dtype=np.int64)
    old_to_new[kept_ids] = np.arange(len(kept_ids))

    print(f"[prune] vocab {vocab_size} → keep {len(kept_ids)} ({100 * len(kept_ids) / vocab_size:.1f}%)")
    print(
        f"[prune]   train-fired {int((counts > 0).sum())}, eval-fired {len(eval_fired)}, single-codepoint kept {single_codepoint}"
    )

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # --- tokenizer surgery (order-preserving strip) ---
    pruned = sp_pb2.ModelProto()
    pruned.CopyFrom(proto)
    del pruned.pieces[:]

    for i in kept_ids:
        pruned.pieces.append(proto.pieces[int(i)])

    tokenizer_out = out_dir / "tokenizer.model"
    tokenizer_out.write_bytes(pruned.SerializeToString())

    # --- ONNX surgery (int8 row-gather, quant params untouched) ---
    model = onnx.load(args.onnx)
    swapped = False

    for init in model.graph.initializer:
        if init.name == "inner.token_embeddings.weight_quantized":
            table = numpy_helper.to_array(init)
            assert table.shape[0] == vocab_size, f"embedding rows {table.shape[0]} != vocab {vocab_size}"
            new_table = np.ascontiguousarray(table[kept_ids])
            replacement = numpy_helper.from_array(new_table, name=init.name)
            init.CopyFrom(replacement)
            swapped = True
            break

    assert swapped, "embedding initializer not found"
    onnx_out = out_dir / "model.onnx"
    onnx.save(model, str(onnx_out))

    id_map_path = out_dir / "id-map.npz"
    np.savez_compressed(id_map_path, kept_ids=kept_ids, old_to_new=old_to_new)

    report = {
        "vocab_before": int(vocab_size),
        "vocab_after": int(len(kept_ids)),
        "train_fired": int((counts > 0).sum()),
        "eval_fired": len(eval_fired),
        "single_codepoint_kept": single_codepoint,
        "tokenizer_bytes": {"before": Path(args.tokenizer).stat().st_size, "after": tokenizer_out.stat().st_size},
        "onnx_bytes": {"before": Path(args.onnx).stat().st_size, "after": onnx_out.stat().st_size},
    }
    (out_dir / "prune-report.json").write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
