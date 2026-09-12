"""The run's metrics, as a CSV one column per tag wide.

Two row kinds share the file. A step row fills the loss and LR columns and leaves the val columns
empty; an eval row fills the val columns. A reader tells them apart by whether `val_loss` is blank,
which is why a step row writes empty strings rather than zeros.
"""

from __future__ import annotations

import csv
from typing import IO, Any

from ...config import Config, csv_log_path
from ...evaluation.metrics import eval_csv_row
from ...labels import resolve_label_set
from ..state import TrainState


class CSVMetricsCallback:
    """Appends the step and eval rows to `train_log.csv`."""

    def __init__(self, cfg: Config, *, resume_step: int = 0) -> None:
        self._path = csv_log_path(cfg)
        self._log_every = max(1, cfg.train.log_every_steps)
        self._tags = resolve_label_set(cfg.data.label_set).tags
        # A resumed run appends to the run's existing CSV; a fresh one starts the file and writes
        # the header. Appending to a file that is not there would lose the header entirely.
        self._append = resume_step > 0 and self._path.is_file()
        self._handle: IO[str] | None = None
        self._writer: Any = None

    def on_train_begin(self, state: TrainState) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = self._path.open("a" if self._append else "w", encoding="utf-8", newline="")
        self._writer = csv.writer(self._handle)
        if not self._append:
            self._writer.writerow(
                ["step", "wall_seconds", "train_loss", "lr", "val_loss", "val_macro_f1"]
                + [f"f1.{tag}" for tag in self._tags]
            )

    def on_step_end(self, state: TrainState, step: int) -> None:
        if step % self._log_every or self._writer is None or self._handle is None:
            return
        self._writer.writerow(
            [step, f"{state.elapsed:.1f}", f"{state.train_loss:.6f}", f"{state.learning_rate:.8f}", "", ""]
            + [""] * len(self._tags)
        )
        self._handle.flush()

    def on_eval_end(self, state: TrainState, step: int, metrics: dict[str, float]) -> None:
        if self._writer is None or self._handle is None:
            return
        self._writer.writerow(eval_csv_row(step, state.elapsed, metrics, self._tags))
        self._handle.flush()

    def on_train_end(self, state: TrainState) -> None:
        if self._handle is not None:
            self._handle.close()
            self._handle = None
            self._writer = None
