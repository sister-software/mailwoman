"""This module moves a volume artifact, such as a checkpoint file, back out through R2.

    modal run -m launch.train_remote::push_artifact_r2 --volume-path=… --r2-subpath=…

The ONNX graph is made on the host from the fetched checkpoint by `trainer-export export-onnx` in
`packages/trainer`, which reads `model.safetensors` or `pytorch_model.bin`, writes the span scorer's
`semi-crf-transitions.json` sidecar, and copies the run's `CORPUS.json` beside the graph. `trainer-export quantize`
then writes the int8 graph. The push exists because this volume's container and CLI views are fully divergent —
`modal volume get` cannot pull a container-written file — so an artifact leaves the way the corpus
arrived.
"""

from __future__ import annotations

import json
import os

from .app import BUCKET, VOL_MOUNT, app, r2_secret, training_image, vol


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
