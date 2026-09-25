"""Stage assets from R2 onto the training volume from inside a container.

Files written by `modal volume put` do not become visible to a mounted container, even after
`vol.reload()`. Container-side writes followed by `vol.commit()` do propagate, so every asset travels
from the local machine to R2 and then to the volume through these functions.

    modal run -m launch.train_remote::sync --version v8cjk_kr
    modal run -m launch.train_remote::sync_assets --corpus-versions v0.31.0-example

`sync` stages a row of `launch/corpora.py`, which lists what the version stages and what must exist on
the volume afterwards. `sync_assets` takes its paths from the command line and records no state. Use
`sync_assets` for a trial corpus, and add a row to `launch/corpora.py` once other runs will repeat it.

An overlay corpus ships only its own parquet files. Its MANIFEST refers to the base version's files by
absolute `/data/...` path, so the base must already be on the volume. Neither function checks this.
`audit_epoch_mixture` checks it and reports the missing file.
"""

from __future__ import annotations

import os

from .app import VOL_MOUNT, app, r2_secret, training_image, vol
from .corpora import CORPUS_VERSIONS
from .plan import WIDE, WRAPPED, Copy, Transfer, corpus, mirror, plan_sync, resolve


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
    """Delete each `__pycache__` directory in `paths`.

    Python can load a stale `.pyc` instead of the freshly copied source beside it, so a run would
    execute the previous code.
    """
    import shutil

    for path in paths:
        if os.path.isdir(path):
            shutil.rmtree(path)
            print(f"  cleared {path}")


def _report_checks(paths: list[str]) -> None:
    """Print whether each path exists and raise with the list of missing paths.

    The function raises so that a half-staged volume stops the sync before a training run uses it.
    """
    missing = [path for path in paths if not (os.path.isfile(path) or os.path.isdir(path))]
    for path in paths:
        print(f"  {path}: {path not in missing}")
    if missing:
        raise RuntimeError(f"staging incomplete — these are not on the volume: {missing}")


def verify_staged(version: str) -> None:
    """Run the version's `verifier`, if it has one, and raise with the labels of failed checks.

    The verifier module is imported from the volume's copy of the package. An ImportError therefore
    means the training package was not staged.
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
) -> None:
    """Copy corpus versions, a tokenizer, the training code and extra files from R2 to the volume.

    Corpus versions land in the layout that `mailwoman corpus upload` writes:

        :s3:{BUCKET}/corpus/<version>/  ->  {VOL_MOUNT}/corpus/versioned/<version>/corpus-<version>/

    Args:
        corpus_versions: Comma-separated version names, such as ``v0.24.0-trailing-region-structured``.
        tokenizer: A subdirectory of ``models/tokenizer/``. An empty value skips the tokenizer.
        code: Whether to copy ``corpus-python/src/``. Training runs import the volume's copy.
        extras: Comma-separated ``<r2-path>><vol-subdir>`` pairs, such as gazetteer files or eval fixtures.

    Usage:
        modal run -m launch.train_remote::sync_assets \
            --corpus-versions v0.24.0-trailing-region-structured
    """
    vol.reload()

    # These are the constructors that `launch/corpora.py` rows use, so both entry points share one layout.
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
