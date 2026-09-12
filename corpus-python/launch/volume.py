"""Reading the container's own view: what is on the volume, and what the image actually holds.

Each of these answers a question the local machine cannot. The volume's container and CLI views are
divergent, so `modal volume ls` is not evidence about what a run will see; the image's resolved
versions are decided when Modal last built the layer, not by `pyproject.toml`; and the torch-
dependent tests skip on the local venv, so a loss-path change is unverified until it runs here.

    modal run -m launch.train_remote::debug_volume
    modal run -m launch.train_remote::versions
    modal run -m launch.train_remote::run_tests --pattern test_conventions
"""

from __future__ import annotations

import os

from .app import VOL_MOUNT, app, training_image, vol


@app.function(volumes={VOL_MOUNT: vol}, image=training_image, timeout=600)
def run_tests(pattern: str = "") -> None:
    """Run the corpus-python pytest suite INSIDE the training image, against the volume's code.

    Verify a loss-path change here BEFORE spending GPU on a probe.
    """
    import subprocess
    import sys

    # The training image ships without pytest; install container-locally (ephemeral, ~3s).
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "pytest"], check=True)  # noqa: S603
    args = [sys.executable, "-m", "pytest", f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/", "-q"]
    if pattern:
        args += ["-k", pattern]
    proc = subprocess.run(args, capture_output=True, text=True, check=False)  # noqa: S603
    print(proc.stdout[-4000:])
    if proc.returncode != 0:
        print(proc.stderr[-2000:])
        raise SystemExit(proc.returncode)


@app.function(volumes={VOL_MOUNT: vol}, image=training_image, timeout=120)
def debug_volume(config_name: str = "v1.4.0-charoffset.yaml") -> None:
    """What a container actually sees on the volume, before and after `vol.reload()`.

    The two snapshots are the point: a file the CLI reports as present can be absent from a mount
    that started before it was committed, and the difference between them says which of the two you
    are looking at.
    """
    cfgdir = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs"
    cpath = f"{cfgdir}/{config_name}"
    ctrain = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train"

    def snapshot(label: str) -> None:
        print(f"\n[{label}]")
        print("  configs dir exists:", os.path.isdir(cfgdir))
        if os.path.isdir(cfgdir):
            print("  configs:", sorted(os.listdir(cfgdir)))
        print(f"  isfile({config_name}):", os.path.isfile(cpath))
        print(
            "  v0.5.0 train dir exists:",
            os.path.isdir(ctrain),
            "slices:",
            len(os.listdir(ctrain)) if os.path.isdir(ctrain) else 0,
        )

    import modal as _m

    print("modal client version:", getattr(_m, "__version__", "?"))
    for d in [
        VOL_MOUNT,
        f"{VOL_MOUNT}/corpus/versioned",
        f"{VOL_MOUNT}/models",
        f"{VOL_MOUNT}/models/tokenizer",
        f"{VOL_MOUNT}/corpus-python/src/mailwoman_train",
    ]:
        print(f"  ls {d}:", sorted(os.listdir(d)) if os.path.isdir(d) else "MISSING")

    snapshot("pre-reload (mount as-started)")
    vol.reload()
    snapshot("post-reload")


@app.function(image=training_image, timeout=120)
def versions() -> None:
    """Print the export/quant toolchain versions baked into ``training_image``.

    The pins in `launch/app.py` are what SHOULD be installed; this is what IS. They can differ when
    a pin is edited without rebuilding, which is the state that produced an unreproducible int8
    graph.
    """
    import sys

    import onnx
    import onnxruntime
    import onnxscript
    import torch
    import transformers

    print(f"python      {sys.version.split()[0]}")
    print(f"torch       {torch.__version__}")
    print(f"transformers {transformers.__version__}")
    print(f"onnx        {onnx.__version__}")
    print(f"onnxruntime {onnxruntime.__version__}")
    print(f"onnxscript  {onnxscript.__version__}")
