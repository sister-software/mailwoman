"""This module converts a checkpoint into the fp32 ONNX artifact on the volume and moves an artifact back out.

    modal run -m launch.train_remote::export_onnx --output-dir=/data/output-<run> --step=40000
    modal run -m launch.train_remote::push_artifact_r2 --volume-path=… --r2-subpath=…

The int8 graph is made on the host from the fetched fp32 file by `trainer-export quantize` in
`packages/trainer`, which writes `quantize_dynamic(QInt8)`'s graph without onnxruntime's shape inference.
A checkpoint the Rust exporter builds can skip this module: `trainer-export export-onnx` reads
`model.safetensors` or `pytorch_model.bin` directly. The push exists because this volume's container and CLI views are fully divergent —
`modal volume get` cannot pull a container-written file — so an artifact leaves the way the corpus
arrived.
"""

from __future__ import annotations

import json
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
) -> None:
    """Export a checkpoint to ONNX.

    Env-var fallbacks (MAILWOMAN_EXPORT_OUTPUT_DIR / MAILWOMAN_EXPORT_STEP /
    MAILWOMAN_EXPORT_TOKENIZER) apply when a CLI param is unset. A CLI param takes precedence.

    ``--model-dir`` bypasses the ``{output_dir}/checkpoints/step-{step}`` layout and loads a flat
    ``from_pretrained`` dir directly (``pytorch_model.bin`` + ``config.json``), writing ``model.onnx``
    into that same dir, so an ad-hoc checkpoint can be exported without restructuring it into the
    training layout.
    """
    import sys
    from pathlib import Path

    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    import torch

    from mailwoman_train.export.onnx import export_to_onnx
    from mailwoman_train.nn.encoder import MailwomanCoarseEncoder
    from mailwoman_train.tokenizer import Tokenizer
    from mailwoman_train.train.checkpoint import checkpoint_dir_name

    output_dir = output_dir or os.environ.get("MAILWOMAN_EXPORT_OUTPUT_DIR", f"{VOL_MOUNT}/output-v054")
    step = step or os.environ.get("MAILWOMAN_EXPORT_STEP", "100000")
    tokenizer_path = tokenizer_path or os.environ.get(
        "MAILWOMAN_EXPORT_TOKENIZER", f"{VOL_MOUNT}/models/tokenizer/v0.6.0-a0/tokenizer.model"
    )

    if model_dir:
        ck_dir = Path(model_dir)
        out_path = Path(f"{model_dir}/model.onnx")
    else:
        ck_dir = Path(output_dir) / "checkpoints" / checkpoint_dir_name(step)
        out_path = Path(f"{output_dir}/model.onnx")
    tokenizer = Tokenizer(Path(tokenizer_path))

    _orig_load = torch.load
    torch.load = lambda *a, **kw: _orig_load(*a, **{**kw, "map_location": "cpu"})
    model = MailwomanCoarseEncoder.from_pretrained(ck_dir)
    torch.load = _orig_load
    print(f"Exporting {ck_dir} → {out_path}")
    export_to_onnx(model, out_path, opset=17, max_length=128, pad_token_id=tokenizer.pad_id)
    print(f"ONNX exported: {out_path} ({out_path.stat().st_size / 1e6:.1f} MB)")

    # A span-scorer model's ONNX export includes a `span_scores` output. The JS k-best decoder also needs
    # the segment-transition table for decoding. The graph does not contain this table. Write it as
    # a sidecar next to model.onnx. A span-less model returns None and keeps the export unchanged.
    import json as _json

    from mailwoman_train.export.package_weights import export_semi_crf_transitions

    transitions = export_semi_crf_transitions(model)
    if transitions is not None:
        sidecar = out_path.parent / "semi-crf-transitions.json"
        sidecar.write_text(_json.dumps(transitions, indent=2) + "\n", encoding="utf-8")
        print(f"span transitions sidecar: {sidecar}")

    # The trainer writes its corpus record beside the checkpoints. A copy beside the model ties the export to its corpus.
    # The name is `CORPUS_RECORD_FILE` in `mailwoman_train.train.corpus_record`, spelled here because this module is
    # mounted from the local checkout while `mailwoman_train` comes from the volume. The volume may hold older code.
    corpus_record = ck_dir.parent / "CORPUS.json"
    if corpus_record.is_file():
        (out_path.parent / corpus_record.name).write_bytes(corpus_record.read_bytes())
        print(f"corpus record: {out_path.parent / corpus_record.name}")
    else:
        print(f"no corpus record at {corpus_record}; the run predates it")

    vol.commit()
    print("Committed to volume.")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def push_artifact_r2(volume_path: str, r2_subpath: str) -> None:
    """Push a volume artifact (e.g. an exported model.onnx) OUT to R2, container-side.

    This copies `<volume_path>` to `:s3:<bucket>/<r2_subpath>`, the bucket `MAILWOMAN_R2_BUCKET` holds. Pull it down locally with
    `rclone copy`. The bucket is versioned, and R2 answers rclone's post-upload `HEAD ?versionId=` with 501
    every time, so the copy runs with `--s3-no-head` and a size check confirms the object afterwards.

    Usage: modal run -m launch.train_remote::push_artifact_r2 \\
             --volume-path /data/output-v140-charoffset-s42/model.onnx \\
             --r2-subpath artifacts/v1.4.0-charoffset/model.onnx
    """
    import subprocess

    vol.reload()
    if not os.path.exists(volume_path):
        raise RuntimeError(f"volume artifact not found: {volume_path}")
    dst = f":s3:{BUCKET}/{r2_subpath}"
    cmd = f"rclone copyto '{volume_path}' '{dst}' --s3-no-head --s3-no-check-bucket --low-level-retries 30 --retries 8 --stats-one-line"
    print(f"push: {volume_path} -> {dst}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, check=False)  # noqa: S602
    if result.returncode != 0:
        print(f"STDERR: {result.stderr[:800]}")
        raise RuntimeError(f"rclone push failed: {result.stderr[:200]}")
    size_cmd = f"rclone size --json '{dst}'"
    sized = subprocess.run(size_cmd, shell=True, capture_output=True, text=True, check=False)  # noqa: S602
    remote_bytes = json.loads(sized.stdout or "{}").get("bytes") if sized.returncode == 0 else None
    if remote_bytes != os.path.getsize(volume_path):
        raise RuntimeError(
            f"rclone push size check failed: local {os.path.getsize(volume_path)} B, remote {remote_bytes} B"
        )
    print(f"pushed OK. Pull locally with: rclone copyto :s3:{BUCKET}/{r2_subpath} ./<local>")
