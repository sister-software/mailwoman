"""The run's progress, on stdout.

This is what a person watching `modal app logs` reads, so the two lines below are a stable surface:
the step line every `log_every_steps`, and the eval block on the eval interval.
"""

from __future__ import annotations

from ...config import Config
from ..state import TrainState

#: The five tags a reader scans first. The eval block prints these inline; the full per-tag table
#: goes to the CSV, which is where a question about a rarer tag gets answered.
HEADLINE_TAGS = ("locality", "region", "street", "house_number", "postcode")


class ConsoleCallback:
    """Prints the step line and the eval block."""

    def __init__(self, cfg: Config) -> None:
        self._log_every = max(1, cfg.train.log_every_steps)
        self._max_steps = cfg.train.max_steps

    def on_train_begin(self, state: TrainState) -> None:
        pass

    def on_step_end(self, state: TrainState, step: int) -> None:
        if step % self._log_every:
            return
        print(
            f"step {step}/{self._max_steps}"
            f"  train_loss={state.train_loss:.4f}  lr={state.learning_rate:.6f}"
            f"  rate={step / state.elapsed:.2f} steps/s"
        )

    def on_eval_end(self, state: TrainState, step: int, metrics: dict[str, float]) -> None:
        tag_summary = "  ".join(f"{tag}={metrics.get(f'f1_tag.{tag}', 0.0):.3f}" for tag in HEADLINE_TAGS)
        print(
            f"  [eval] val_loss={metrics.get('val_loss', float('nan')):.4f}"
            f"  macro_f1={metrics.get('macro_f1', 0.0):.4f}"
            f"  val_rows={metrics.get('val_rows', 0)}"
            f"\n         {tag_summary}"
        )
        # The city/region-start → postcode rate, plus the aux locale-head accuracy. Absent unless
        # self-conditioning is on, so the block only appears for the runs it describes.
        if "cross_pollution" not in metrics:
            return
        per_locale = "  ".join(
            f"{key.split('.', 1)[1]}={metrics[key] * 100:.2f}%"
            for key in sorted(metrics)
            if key.startswith("cross_pollution.")
        )
        print(
            f"         [pr3] cross_pollution={metrics['cross_pollution'] * 100:.2f}%"
            f"  ({per_locale})  locale_acc={metrics.get('locale_acc', float('nan')):.3f}"
        )

    def on_train_end(self, state: TrainState) -> None:
        pass
