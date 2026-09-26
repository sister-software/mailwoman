"""SP vocab-pruning artifact surgery: rebuild ``tokenizer.model`` and the int8 ``model.onnx`` from a keep set.

Tokenizer surgery strips pruned pieces order-preserving; a piece that never won a Viterbi path
contributes no score to any other path, so segmentation is identical for every input whose best
path avoided the pruned set. ONNX surgery row-gathers ``token_embeddings.weight_quantized`` by the
old→new id map with scale and zero-point untouched, so kept rows stay byte-identical.
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
    # These checks use raises, not asserts, so a silently wrong artifact cannot ship under
    # `python -O`.
    if counts.shape != (vocab_size,):
        raise ValueError(f"counts shape {counts.shape} != vocab {vocab_size}")
    eval_fired = set(json.loads(Path(args.eval_fired).read_text())["fired_ids"])

    keep = np.zeros(vocab_size, dtype=bool)
    keep[counts > 0] = True
    keep[list(eval_fired)] = True

    # Any piece the proto marks non-normal — control, unused or byte — is kept; byte-fallback
    # pieces are type byte.
    proto = sp_pb2.ModelProto()
    proto.ParseFromString(Path(args.tokenizer).read_bytes())
    if len(proto.pieces) != vocab_size:
        raise ValueError(f"tokenizer has {len(proto.pieces)} pieces, vocab is {vocab_size}")

    normal = sp_pb2.ModelProto.SentencePiece.Type.NORMAL
    single_codepoint = 0

    for i, piece in enumerate(proto.pieces):
        if piece.type != normal:
            keep[i] = True
            continue

        # Reachability floor: every single-codepoint piece stays, with the ▁ prefix stripped so a
        # word-initial form of one codepoint also stays.
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

    pruned = sp_pb2.ModelProto()
    pruned.CopyFrom(proto)
    del pruned.pieces[:]

    for kept_id in kept_ids:
        pruned.pieces.append(proto.pieces[int(kept_id)])

    tokenizer_out = out_dir / "tokenizer.model"
    tokenizer_out.write_bytes(pruned.SerializeToString())

    model = onnx.load(args.onnx)
    swapped = False

    for init in model.graph.initializer:
        if init.name == "inner.token_embeddings.weight_quantized":
            table = numpy_helper.to_array(init)
            if table.shape[0] != vocab_size:
                raise ValueError(f"embedding rows {table.shape[0]} != vocab {vocab_size}")
            new_table = np.ascontiguousarray(table[kept_ids])
            replacement = numpy_helper.from_array(new_table, name=init.name)
            init.CopyFrom(replacement)
            swapped = True
            break

    if not swapped:
        raise ValueError("embedding initializer not found; the graph has no table to prune")
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
