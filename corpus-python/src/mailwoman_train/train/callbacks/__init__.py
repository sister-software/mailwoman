"""The concerns a training run observes, one per module.

The loop runs the steps and decides when to evaluate; these four write what happened. The order in
`default_callbacks` is the order a reader of the log sees, so it is the order the run's output is
composed in, not an implementation detail.

A callback observes and never steers. One that must stop a run raises — there is no return value
the loop reads.
"""

from __future__ import annotations

from ...config import Config
from ...protocols import TrainCallback
from .checkpointer import CheckpointerCallback
from .console import ConsoleCallback
from .csv_metrics import CSVMetricsCallback
from .trackio import TrackioCallback

__all__ = [
    "CSVMetricsCallback",
    "CheckpointerCallback",
    "ConsoleCallback",
    "TrackioCallback",
    "default_callbacks",
]


def default_callbacks(cfg: Config, *, resume_step: int = 0) -> list[TrainCallback]:
    """The callbacks a run gets when the caller names none."""
    return [
        ConsoleCallback(cfg),
        CSVMetricsCallback(cfg, resume_step=resume_step),
        TrackioCallback(cfg),
        CheckpointerCallback(cfg),
    ]
