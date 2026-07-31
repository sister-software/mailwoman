"""Task #25 (SP vocab-pruning probe) — bars B1 + B2 from the pre-registration.

B1 — segmentation byte-identity: original vs pruned tokenizer must produce IDENTICAL piece
sequences (modulo id renumbering, checked via the id map) on (a) every eval-surface text and
(b) a fresh 1M-row random sample of the training feed. Zero diffs or the bar fails.

B2 — logit bit-parity: original vs pruned int8 ONNX on eval inputs. The graphs differ only in the
embedding gather table, and kept rows are byte-identical — so with ids remapped, outputs must be
BITWISE equal. Channel inputs are fed zeros: parity must hold for any channel values if the
surgery is sound, and the full-battery bar (B3) covers realistic feeds end-to-end.

Usage:
    python corpus-python/scripts/verify_prune.py \
        --orig-tokenizer neural-weights-en-us/tokenizer.model \
        --orig-onnx $MAILWOMAN_DATA_ROOT/models/quantized/model-v401-base-step-060000-int8.onnx \
        --pruned-dir $MAILWOMAN_DATA_ROOT/scratch-vocab-prune/pruned-v1 \
        --manifest $MAILWOMAN_DATA_ROOT/corpus/versioned/v0.15.0-venue/corpus-v0.15.0-venue/MANIFEST.json \
        --eval-texts $MAILWOMAN_DATA_ROOT/scratch-vocab-prune/eval-texts.json \
        [--sample-rows 1000000] [--logit-inputs 256] [--seed 42]
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np


def sample_training_rows(manifest_path: str, remap: tuple[str, str], n: int, seed: int) -> list[str]:
    """Fresh random sample across shards: pick shards round-robin, one random batch each."""
    import pyarrow.parquet as pq

    manifest = json.loads(Path(manifest_path).read_text())
    shards = [s["path"].replace(remap[0], remap[1], 1) for s in manifest["shards"] if s["split"] == "train"]
    rng = random.Random(seed)
    rng.shuffle(shards)
    rows: list[str] = []
    per_shard = max(1, n // len(shards) + 1)

    for shard in shards:
        pf = pq.ParquetFile(shard)
        group = rng.randrange(pf.num_row_groups)
        table = pf.read_row_group(group, columns=["raw"])
        raws = table.column(0).to_pylist()
        rng.shuffle(raws)
        rows.extend(raws[:per_shard])

        if len(rows) >= n:
            break

    return rows[:n]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--orig-tokenizer", required=True)
    parser.add_argument("--orig-onnx", required=True)
    parser.add_argument("--pruned-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--eval-texts", required=True)
    parser.add_argument("--sample-rows", type=int, default=1_000_000)
    parser.add_argument("--logit-inputs", type=int, default=256)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--data-root-remap",
        default="/data:/mnt/playpen/mailwoman-data",
    )
    args = parser.parse_args()

    import sentencepiece as spm

    pruned_dir = Path(args.pruned_dir)
    id_map = np.load(pruned_dir / "id-map.npz")
    old_to_new = id_map["old_to_new"]

    orig = spm.SentencePieceProcessor()
    orig.LoadFromFile(args.orig_tokenizer)
    pruned = spm.SentencePieceProcessor()
    pruned.LoadFromFile(str(pruned_dir / "tokenizer.model"))

    eval_texts = json.loads(Path(args.eval_texts).read_text())["texts"]
    remap = tuple(args.data_root_remap.split(":", 1))
    train_sample = sample_training_rows(args.manifest, remap, args.sample_rows, args.seed)

    # --- B1 ---
    def check(texts: list[str], label: str) -> int:
        diffs = 0

        for text in texts:
            a = orig.encode(text)
            b = pruned.encode(text)
            mapped = [int(old_to_new[i]) for i in a]

            if mapped != b or -1 in mapped:
                diffs += 1

                if diffs <= 5:
                    print(f"[B1 DIFF] {label}: {text!r}")
                    print(f"    orig  : {orig.encode(text, out_type=str)}")
                    print(f"    pruned: {pruned.encode(text, out_type=str)}")

        print(f"[B1] {label}: {len(texts):,} texts, {diffs} diffs")

        return diffs

    b1 = check(eval_texts, "eval-surface") + check(train_sample, "train-sample")

    # --- B2 ---
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    orig_session = ort.InferenceSession(args.orig_onnx, so, providers=["CPUExecutionProvider"])
    pruned_session = ort.InferenceSession(str(pruned_dir / "model.onnx"), so, providers=["CPUExecutionProvider"])

    rng = random.Random(args.seed)
    logit_texts = rng.sample(eval_texts, min(args.logit_inputs, len(eval_texts)))
    input_metas = orig_session.get_inputs()
    b2 = 0

    for text in logit_texts:
        ids = orig.encode(text)
        mapped = [int(old_to_new[i]) for i in ids]
        assert -1 not in mapped, f"unmapped id in B2 input: {text!r}"

        def feeds_for(session_ids: list[int]) -> dict[str, np.ndarray]:
            """Assemble feeds per the model's actual meta: every input is (batch, sequence[, F])."""
            feeds: dict[str, np.ndarray] = {}
            length = len(session_ids)

            for meta in input_metas:
                np_type = np.int64 if "int64" in meta.type else np.float32
                shape = tuple(1 if dim == "batch" else length if dim == "sequence" else int(dim) for dim in meta.shape)

                if meta.name == "input_ids":
                    feeds[meta.name] = np.asarray([session_ids], dtype=np.int64)
                elif meta.name == "attention_mask":
                    feeds[meta.name] = np.ones(shape, dtype=np_type)
                else:
                    feeds[meta.name] = np.zeros(shape, dtype=np_type)

            return feeds

        out_a = orig_session.run(None, feeds_for(ids))
        out_b = pruned_session.run(None, feeds_for(mapped))

        for a, b in zip(out_a, out_b, strict=True):
            if not np.array_equal(a, b):
                b2 += 1

                if b2 <= 3:
                    print(f"[B2 DIFF] {text!r}: max |Δ| {np.max(np.abs(a - b))}")

                break

    print(f"[B2] {len(logit_texts)} inputs, {b2} non-bit-equal")
    verdict = "PASS" if b1 == 0 and b2 == 0 else "FAIL"
    print(f"VERDICT: {verdict} (B1 diffs {b1}, B2 diffs {b2})")
    (pruned_dir / "verify-report.json").write_text(
        json.dumps(
            {
                "b1_eval_texts": len(eval_texts),
                "b1_train_sample": len(train_sample),
                "b1_diffs": b1,
                "b2_inputs": len(logit_texts),
                "b2_diffs": b2,
                "verdict": verdict,
            },
            indent=1,
        )
        + "\n"
    )

    raise SystemExit(0 if verdict == "PASS" else 1)


if __name__ == "__main__":
    main()
