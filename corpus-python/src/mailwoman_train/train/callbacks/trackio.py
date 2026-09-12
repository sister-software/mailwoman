"""The Trackio dashboard mirror of the CSV.

`init_tracker` answers a null tracker whenever tracking is off or the package is absent, and every
call it returns swallows its own failures. So this callback joins every run unconditionally: a
disabled tracker costs a method call per interval, and making membership conditional would put the
same decision in two places.
"""

from __future__ import annotations

from typing import Any

from ...config import Config
from ...labels import resolve_label_set
from ...observability.trackio import init_tracker
from ..state import TrainState


class TrackioCallback:
    """Mirrors the step and eval metrics to the dashboard."""

    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self._log_every = max(1, cfg.train.log_every_steps)
        self._tags = resolve_label_set(cfg.data.label_set).tags
        self._tracker: Any = None

    def on_train_begin(self, state: TrainState) -> None:
        self._tracker = init_tracker(self._cfg)

    def on_step_end(self, state: TrainState, step: int) -> None:
        if step % self._log_every or self._tracker is None:
            return
        self._tracker.log(
            {"train_loss": state.train_loss, "lr": state.learning_rate, "wall_seconds": state.elapsed},
            step=step,
        )

    def on_eval_end(self, state: TrainState, step: int, metrics: dict[str, float]) -> None:
        if self._tracker is None:
            return
        self._tracker.log(self._dashboard_metrics(state, metrics), step=step)

    def on_train_end(self, state: TrainState) -> None:
        if self._tracker is not None:
            self._tracker.finish()
            self._tracker = None

    def _dashboard_metrics(self, state: TrainState, metrics: dict[str, float]) -> dict[str, float]:
        """Per-tag F1 beside per-tag support, with F1 OMITTED where support is zero.

        A zero-support tag means the val sample contains no examples of it — a coverage gap. Logging
        F1 as 0.0 there draws a flat-zero line that reads as a model failure, so the series gets a
        gap instead and `support.<tag>` says why.
        """
        dashboard: dict[str, float] = {
            "val_loss": float(metrics.get("val_loss", float("nan"))),
            "val_macro_f1": float(metrics.get("macro_f1", 0.0)),
            "wall_seconds": state.elapsed,
        }
        tags_with_support = 0
        for tag in self._tags:
            support = int(metrics.get(f"support_tag.{tag}", 0))
            dashboard[f"support.{tag}"] = support
            if support > 0:
                dashboard[f"f1.{tag}"] = float(metrics.get(f"f1_tag.{tag}", 0.0))
                tags_with_support += 1
        dashboard["val_tags_with_support"] = tags_with_support
        for key, value in metrics.items():
            if key.startswith("cross_pollution") or key == "locale_acc":
                dashboard[key] = float(value)
        return dashboard
