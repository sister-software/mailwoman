"""Where a training run writes, and which checkpoint each attempt starts from.

The training function runs under `modal.Retries`, so an attempt may be the second or third after a
preemption or a crash. Every attempt makes the same decision, from what is on the volume: the newest
complete checkpoint in the run's own output directory wins, because it is this run's latest progress.
With none, an attempt starts from ``branch_from`` when the launch named one, otherwise from scratch.

A fresh start is the entrypoint's decision, made once before the GPU function is spawned: it clears the
output directory through the CPU preflight. An attempt therefore never deletes anything, so a retry
cannot discard the checkpoints an earlier attempt saved.

This module imports neither `modal` nor the training package, so it is tested locally.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath


@dataclass(frozen=True)
class RunPaths:
    output_dir: str
    csv_log_path: str

    @property
    def run_base(self) -> str:
        return str(PurePosixPath(self.output_dir).parent)


def resolve_run_paths(output_dir: str, csv_log_path: str, volume_mount: str) -> RunPaths:
    """The checkpoint directory and CSV log a run writes on the volume.

    A config whose ``output_dir`` is under the mount keeps it. Any other lands at
    ``<mount>/output/checkpoints``. The log follows ``{output_dir}`` when the config names it, and otherwise
    sits beside the checkpoint directory.
    """
    prefix = volume_mount.rstrip("/") + "/"
    resolved = output_dir if output_dir.startswith(prefix) else f"{prefix}output/checkpoints"
    base = str(PurePosixPath(resolved).parent)
    log = csv_log_path.replace("{output_dir}", resolved) if "{output_dir}" in csv_log_path else f"{base}/train_log.csv"
    return RunPaths(resolved, log)


def resume_point(latest_checkpoint: str | None, branch_from: str) -> str | None:
    """The checkpoint an attempt resumes from: this run's latest, else the branch point, else ``None`` (scratch)."""
    if latest_checkpoint:
        return latest_checkpoint
    return branch_from or None


def check_clearable(output_dir: str, volume_mount: str) -> None:
    """Raise unless ``output_dir`` is a run directory strictly inside the mount, never a shared root.

    A fresh start deletes this directory, so a config pointing it at the mount itself, at the corpus or at
    the models tree must be refused rather than obeyed.
    """
    path = PurePosixPath(output_dir)
    mount = PurePosixPath(volume_mount)
    if mount not in path.parents:
        raise ValueError(f"refusing to clear {output_dir}: it is not inside {volume_mount}")
    parts = path.relative_to(mount).parts
    first = parts[0]
    # Older configs write `<mount>/models/checkpoints/<run>`; that one run directory is clearable.
    if first == "models" and len(parts) >= 3 and parts[1] == "checkpoints":
        return
    if first in {"corpus", "corpus-python", "models", "audits", "gazetteer", "eval"}:
        raise ValueError(f"refusing to clear {output_dir}: {mount / first} holds shared assets, not one run")
