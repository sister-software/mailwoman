"""Turning a checkpoint into the artifact that ships: fp32 ONNX, int8, and the way back out.

    modal run -m launch.train_remote::export_onnx --output-dir=/data/output-<run> --step=40000
    modal run -m launch.train_remote::quantize_onnx --fp32-path=… --int8-path=…
    modal run -m launch.train_remote::push_artifact_r2 --volume-path=… --r2-subpath=…

Quantization runs HERE rather than locally because the dynamo-exported graph trips onnx shape
inference in some local onnxruntime builds; the training image's pinned one quantizes it cleanly.
The push exists because this volume's container and CLI views are fully divergent — `modal volume
get` cannot pull a container-written file — so an artifact leaves the way the corpus arrived.
"""

from __future__ import annotations

import os

from .app import BUCKET, VOL_MOUNT, app, r2_secret, training_image, vol


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=600,
)
def export_onnx(
    output_dir: str = "",
    step: str = "",
    tokenizer_path: str = "",
    model_dir: str = "",
):
    """Export a checkpoint to ONNX.

    Env-var fallbacks (MAILWOMAN_EXPORT_OUTPUT_DIR / MAILWOMAN_EXPORT_STEP /
    MAILWOMAN_EXPORT_TOKENIZER) are kept for back-compat with prior workflows; CLI params take
    precedence when set.

    ``--model-dir`` bypasses the ``{output_dir}/checkpoints/step-{step}`` layout and loads a FLAT
    ``from_pretrained`` dir directly (``pytorch_model.bin`` + ``config.json``), writing ``model.onnx``
    into that same dir. Used to export an ad-hoc checkpoint — e.g. the #825 B-splice expanded-but-not-
    fine-tuned model for the mean-init ablation — without restructuring it into the training layout.
    """
    import sys
    from pathlib import Path

    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    import torch

    from mailwoman_train.export.onnx import export_to_onnx
    from mailwoman_train.nn.encoder import MailwomanCoarseEncoder
    from mailwoman_train.tokenizer import Tokenizer

    output_dir = output_dir or os.environ.get("MAILWOMAN_EXPORT_OUTPUT_DIR", f"{VOL_MOUNT}/output-v054")
    step = step or os.environ.get("MAILWOMAN_EXPORT_STEP", "100000")
    tokenizer_path = tokenizer_path or os.environ.get(
        "MAILWOMAN_EXPORT_TOKENIZER", f"{VOL_MOUNT}/models/tokenizer/v0.6.0-a0/tokenizer.model"
    )

    if model_dir:
        ck_dir = Path(model_dir)
        out_path = Path(f"{model_dir}/model.onnx")
    else:
        ck_dir = Path(f"{output_dir}/checkpoints/step-{step}")
        out_path = Path(f"{output_dir}/model.onnx")
    tokenizer = Tokenizer(Path(tokenizer_path))

    _orig_load = torch.load
    torch.load = lambda *a, **kw: _orig_load(*a, **{**kw, "map_location": "cpu"})
    model = MailwomanCoarseEncoder.from_pretrained(ck_dir)
    torch.load = _orig_load
    print(f"Exporting {ck_dir} → {out_path}")
    export_to_onnx(model, out_path, opset=17, max_length=128, pad_token_id=tokenizer.pad_id)
    print(f"ONNX exported: {out_path} ({out_path.stat().st_size / 1e6:.1f} MB)")

    # #727 stage-2: a span-scorer model's ONNX carries a `span_scores` output, but the JS k-best
    # decoder (neural/semi-markov-decode.ts, PR #1154) also needs the segment-transition table, which
    # is DECODE-TIME data, not part of the graph. Write it as a sidecar next to model.onnx so the
    # grade's oracle@k / seg@1 arc reads can consume it. Returns None (no file) for a span-less model,
    # keeping the export byte-identical for every pre-#727 recipe.
    import json as _json

    from mailwoman_train.export.package_weights import export_semi_crf_transitions

    transitions = export_semi_crf_transitions(model)
    if transitions is not None:
        sidecar = out_path.parent / "semi-crf-transitions.json"
        sidecar.write_text(_json.dumps(transitions, indent=2) + "\n", encoding="utf-8")
        print(f"span transitions sidecar: {sidecar}")

    vol.commit()
    print("Committed to volume.")


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=600,
)
def quantize_onnx(
    fp32_path: str = "",
    int8_path: str = "",
):
    """Int8-quantize an fp32 ONNX on the volume, in the training image."""
    import hashlib
    import sys
    from pathlib import Path

    # RELOAD BEFORE READING. This function is almost always called right after `export_onnx` wrote its
    # fp32 to the volume, and a container that started with an older view reads the PREVIOUS model —
    # silently, since the path is the same. Two checkpoints exported to `model.onnx` in sequence and
    # quantized in between produced byte-identical int8 artifacts because of this, which reads as "the
    # two checkpoints are the same model" rather than as a stale mount.
    vol.reload()

    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")
    from mailwoman_train.export.quantize import quantize_dynamic_int8

    fp32 = Path(fp32_path)
    int8 = Path(int8_path)

    if not fp32.is_file():
        raise RuntimeError(f"no fp32 at {fp32} after vol.reload() — export it first")

    # The INPUT's digest travels with the output. An int8 artifact is otherwise unattributable: nothing
    # in the file says which checkpoint it came from, and the fp32 it was made from is usually
    # overwritten by the next export.
    fp32_md5 = hashlib.md5(fp32.read_bytes()).hexdigest()

    print(f"Quantizing {fp32} (md5 {fp32_md5}) → {int8}")
    quantize_dynamic_int8(fp32, int8)
    int8_md5 = hashlib.md5(int8.read_bytes()).hexdigest()
    print(f"int8 written: {int8} ({int8.stat().st_size / 1e6:.1f} MB, md5 {int8_md5})")
    vol.commit()
    print("Committed to volume.")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def push_artifact_r2(volume_path: str, r2_subpath: str):
    """Push a volume artifact (e.g. an exported model.onnx) OUT to R2, container-side.

    This copies `<volume_path>` to `:s3:mailwoman-assets/<r2_subpath>`; pull it down locally with
    `rclone copy`. Rides R2's intermittent 501s with retries.

    Usage: modal run -m launch.train_remote::push_artifact_r2 \\
             --volume-path /data/output-v140-charoffset-s42/model.onnx \\
             --r2-subpath artifacts/v1.4.0-charoffset/model.onnx
    """
    import subprocess

    vol.reload()
    if not os.path.exists(volume_path):
        raise RuntimeError(f"volume artifact not found: {volume_path}")
    dst = f":s3:{BUCKET}/{r2_subpath}"
    cmd = f"rclone copyto '{volume_path}' '{dst}' --low-level-retries 30 --retries 8 --stats-one-line"
    print(f"push: {volume_path} -> {dst}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, check=False)  # noqa: S602
    if result.returncode != 0:
        print(f"STDERR: {result.stderr[:800]}")
        raise RuntimeError(f"rclone push failed: {result.stderr[:200]}")
    print(f"pushed OK. Pull locally with: rclone copyto :s3:{BUCKET}/{r2_subpath} ./<local>")
