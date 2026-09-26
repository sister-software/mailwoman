"""The structural interfaces a country module, a CLI command, and a training callback satisfy."""

from __future__ import annotations

import argparse
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class CountryModule(Protocol):
    """What one country contributes to training, as a module rather than an instance.

    `BOARD_BUCKET_MIN` is the municipality-population floor above which rows go to the held-out
    board rather than the training pool; each country sets its own because the population
    distributions differ.
    """

    COUNTRY_CODE: str
    """ISO 3166-1 alpha-2, lower case — the same string that keys the country registry."""

    LABEL_SET_NAME: str
    """The label set this country's rows are tagged against, e.g. `stage3-jp`."""

    BOARD_BUCKET_MIN: int

    def build_corpus(self, args: argparse.Namespace) -> dict[str, Any]:
        """Write this country's parquet parts and answer the build's own statistics.

        The argument is a parsed `Namespace` because the builders read a dozen or more settings off
        one — source paths, row budgets, the seed, the augmentation fractions. Answering a plain row
        count would discard the per-register alignment rates the recipes are judged on.
        """
        ...


@runtime_checkable
class CLICommand(Protocol):
    """One subcommand of `python -m mailwoman_train`, implemented as a module under `cli/commands/`."""

    NAME: str
    """The subcommand as typed, which may be kebab-case where the module name cannot be."""

    def add_parser(self, subparsers: Any) -> None:
        """Register this command's parser and flags on the shared subparser action."""
        ...

    def run(self, args: argparse.Namespace) -> int:
        """Do the work and answer a process exit code."""
        ...


@runtime_checkable
class TrainCallback(Protocol):
    """One concern observed during a training run; hooks answer None and one that must stop a run
    raises, and `state` is `Any` to keep the training loop out of every module that reads an
    interface."""

    def on_train_begin(self, state: Any) -> None: ...

    def on_step_end(self, state: Any, step: int) -> None: ...

    def on_eval_end(self, state: Any, step: int, metrics: dict[str, float]) -> None: ...

    def on_train_end(self, state: Any) -> None: ...
