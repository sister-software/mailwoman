"""Stage assets from R2 onto the training volume from inside a container.

Files written by `modal volume put` do not become visible to a mounted container even after
`vol.reload()`; container-side writes followed by `vol.commit()` do propagate, so every asset
travels to R2 and then to the volume through these functions.

An overlay corpus ships only its own parquet files. Its MANIFEST refers to the base version's
files by absolute `/data/...` path, so the base must already be on the volume;
`audit_epoch_mixture` reports a base that is missing.
"""

from __future__ import annotations

import os

from .app import VOL_MOUNT, app, r2_secret, require_r2_env, training_image, vol
from .bucket import list_prefixes
from .corpora import CORPUS_VERSIONS
from .plan import (
    CORPUS_SOURCE_ROOT,
    LAYOUTS,
    WIDE,
    Copy,
    Transfer,
    corpus,
    detect_layout,
    mirror,
    plan_sync,
    resolve,
)


def _run_transfers(transfers: list[Transfer]) -> None:
    """Run each transfer and raise if a destination holds no files afterwards.

    rclone exits 0 when the source prefix is empty, so the file count is the only signal that a
    transfer copied no files.
    """
    import subprocess

    for index, transfer in enumerate(transfers):
        print(f"\n[{index + 1}/{len(transfers)}] {transfer.source} -> {transfer.destination}")
        result = subprocess.run(transfer.command, shell=True, capture_output=True, text=True, check=False)  # noqa: S602
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

        landed = sum(len(files) for _, _, files in os.walk(transfer.destination))
        if landed == 0:
            raise RuntimeError(
                f"rclone succeeded and {transfer.destination} holds no files. The R2 prefix "
                f"{transfer.source} is empty — upload it first with `mailwoman corpus upload`."
            )
        print(f"  {landed} files present")


def _clear_pycache(paths: list[str]) -> None:
    """Delete each `__pycache__` directory in `paths`, because Python can load a stale `.pyc`
    instead of the freshly copied source beside it.
    """
    import shutil

    for path in paths:
        if os.path.isdir(path):
            shutil.rmtree(path)
            print(f"  cleared {path}")


def _report_checks(paths: list[str]) -> None:
    """Print whether each path exists and raise with the list of missing paths."""
    missing = [path for path in paths if not (os.path.isfile(path) or os.path.isdir(path))]
    for path in paths:
        print(f"  {path}: {path not in missing}")
    if missing:
        raise RuntimeError(f"staging incomplete — these are not on the volume: {missing}")


def verify_staged(version: str) -> None:
    """Run the version's `verifier` when it has one. Raise with the labels of failed checks.

    The verifier module is imported from the volume's copy of the package, so an ImportError means
    the training package was not staged.
    """
    import importlib
    import sys

    target = CORPUS_VERSIONS[version].verifier
    if target is None:
        return

    module_name, function_name = target
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")
    checks = getattr(importlib.import_module(module_name), function_name)(
        f"{VOL_MOUNT}/corpus-python/src/mailwoman_train", f"{VOL_MOUNT}/corpus/versioned"
    )

    for label, present in checks.items():
        print(f"  {label}: {present}")
    missing = [label for label, present in checks.items() if not present]
    if missing:
        raise RuntimeError(f"staging incomplete: {missing}")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync(version: str = "") -> None:
    """Stage one version listed in `launch/corpora.py` and verify its expected paths."""
    entry = CORPUS_VERSIONS.get(version)
    if entry is None:
        raise RuntimeError(f"no version named {version!r}. Known: {', '.join(sorted(CORPUS_VERSIONS))}")

    plan = plan_sync(entry)
    if not plan.transfers:
        raise RuntimeError(
            f"{version!r} names no transfers — it is staged by `sync_assets` with paths on the command line."
        )

    print(f"Staging {version} from R2 (container-side)...")
    require_r2_env()
    vol.reload()
    _run_transfers(plan.transfers)
    _clear_pycache(plan.pycache_paths)
    vol.commit()

    _report_checks(plan.check_paths)
    verify_staged(version)
    print(f"\n{version} staged. Volume committed.")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync_assets(
    corpus_versions: str = "",
    tokenizer: str = "",
    code: bool = True,
    extras: str = "",
    layout: str = "",
) -> None:
    """Copy corpus versions, a tokenizer, the training code and extra files from R2 to the volume.

    Each corpus version lands at ``{VOL_MOUNT}/corpus/versioned/<version>/corpus-<version>/`` whichever way it
    was pushed. The bucket layout is read from the listing of ``corpus/<version>/`` (`detect_layout`):
    ``corpus/<version>/corpus-<version>/`` is `NESTED`, anything else is `WRAPPED`, the layout
    `mailwoman corpus upload` writes. ``--layout nested|wrapped|flat`` overrides the detection, and is the
    only way to stage `FLAT` (a flat local entry, landing at ``corpus/versioned/<version>/``).
    ``extras`` is a comma-separated list of ``<r2-path>><vol-subdir>`` pairs.
    """
    if layout and layout not in LAYOUTS:
        raise RuntimeError(f"--layout {layout!r} is not one of {', '.join(LAYOUTS)}")
    require_r2_env()
    vol.reload()

    copies: list[Copy] = []
    for name in [n.strip() for n in corpus_versions.split(",") if n.strip()]:
        chosen = layout or detect_layout(name, list_prefixes(f"{CORPUS_SOURCE_ROOT}/{name}/"))
        print(f"corpus {name}: {chosen} layout{'' if layout else ' (detected from the bucket listing)'}")
        copies.append(corpus(name, chosen))

    if tokenizer:
        copies.append(mirror(f"models/tokenizer/{tokenizer}/"))

    if code:
        copies.append(mirror("corpus-python/src/"))

    for extra in [e.strip() for e in extras.split(",") if e.strip()]:
        source, _, destination = extra.partition(">")
        copies.append(Copy(source, destination, WIDE))

    if not copies:
        raise RuntimeError("nothing selected -- pass --corpus-versions, --tokenizer or --extras")

    _run_transfers([resolve(copy) for copy in copies])
    if code:
        _clear_pycache([f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"])

    vol.commit()
    print("\nSync complete. Volume committed.")
