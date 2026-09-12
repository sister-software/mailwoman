"""Staging assets from R2 onto the training volume, container-side.

Container-side is not a preference. On this volume the CLI write -> container read path is broken:
files written by `modal volume put` are visible to `modal volume ls/get` but NOT to a mounted
container, and `vol.reload()` does not bridge it. Container-side writes plus `vol.commit()` do
propagate, so every asset routes local -> R2 -> here.

Two entry points, and the difference is whether the transfer is NAMED:

    modal run -m launch.train_remote::sync --version v8cjk_kr
    modal run -m launch.train_remote::sync_assets --corpus-versions v0.31.0-example

`sync` runs a row of `launch/corpora.py`, which records what that version stages and what must be
on the volume afterwards. `sync_assets` takes the paths on the command line and records nothing.
Reach for `sync_assets` while a corpus is still being tried; add the row when it becomes a run
somebody will repeat, because a transfer nobody can enumerate is a corpus that quietly stops being
staged. Fifty-line clones — one per version, differing only in path strings — is how this file once
reached fifty-seven of them.

An overlay corpus ships only its own new slices; its MANIFEST names the base version's slices by
absolute `/data/...` path, so the base must already be on the volume. Neither entry point checks
that — `audit_epoch_mixture` does, and it reports which slice is missing.
"""

from __future__ import annotations

import os

from .app import VOL_MOUNT, app, r2_secret, training_image, vol
from .corpora import CORPUS_VERSIONS
from .plan import WIDE, WRAPPED, Copy, Transfer, corpus, mirror, plan_sync, resolve


def _run_transfers(transfers: list[Transfer]) -> None:
    """Run each transfer, and refuse one that moved nothing.

    rclone EXITS 0 WHEN THE SOURCE PREFIX IS EMPTY. Without the file count the caller reads a clean
    run and a training job fails much later on a missing slice, with nothing pointing back here.
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
    """Remove the stale bytecode a container-side write of new `.py` over old leaves behind.

    The `.pyc` imports in preference to the source beside it, so without this the run imports the
    PREVIOUS code and reports success against it.
    """
    import shutil

    for path in paths:
        if os.path.isdir(path):
            shutil.rmtree(path)
            print(f"  cleared {path}")


def _report_checks(paths: list[str]) -> None:
    """Print each verified path and raise naming every absence.

    Raising rather than printing is the point: a sync whose verify block only prints leaves the
    operator to read a wall of True/False, and a launch against a half-staged volume trains on the
    wrong data and reports success.
    """
    missing = [path for path in paths if not (os.path.isfile(path) or os.path.isdir(path))]
    for path in paths:
        print(f"  {path}: {path not in missing}")
    if missing:
        raise RuntimeError(f"staging incomplete — these are not on the volume: {missing}")


def verify_staged(version: str) -> None:
    """Run the row's `verifier`, if it has one, and raise naming every check that failed.

    The module is imported from the VOLUME's copy, so an ImportError here reports that the training
    package did not land.
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
def sync(version: str = ""):
    """Stage one named version from `launch/corpora.py` and verify what it promised to leave behind."""
    entry = CORPUS_VERSIONS.get(version)
    if entry is None:
        raise RuntimeError(f"no version named {version!r}. Known: {', '.join(sorted(CORPUS_VERSIONS))}")

    plan = plan_sync(entry)
    if not plan.transfers:
        raise RuntimeError(
            f"{version!r} names no transfers — it is staged by `sync_assets` with paths on the command line."
        )

    print(f"Staging {version} from R2 (container-side)...")
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
):
    """Pull named corpus versions, a tokenizer, the training code and arbitrary extra files from R2.

    Layout contract, matching what `mailwoman corpus upload` writes:

        :s3:{BUCKET}/corpus/<version>/  ->  {VOL_MOUNT}/corpus/versioned/<version>/corpus-<version>/

    Args:
        corpus_versions: comma-separated version names, e.g. ``v0.24.0-trailing-region-structured``.
        tokenizer: tokenizer subdirectory under ``models/tokenizer/``; empty syncs the flat directory.
        code: sync ``corpus-python/src/`` (default true -- a run reads the volume's copy, not git).
        extras: comma-separated ``<r2-path>><vol-subdir>`` pairs for gazetteer files, eval fixtures.

    Usage:
        modal run -m launch.train_remote::sync_assets \
            --corpus-versions v0.24.0-trailing-region-structured
    """
    vol.reload()

    # The same constructors the table rows use, so an ad-hoc transfer and a named one put a corpus
    # version in the same place. A second spelling of the layout here is how they come to disagree.
    copies: list[Copy] = [corpus(name.strip(), WRAPPED) for name in corpus_versions.split(",") if name.strip()]

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
