"""The interfaces the swappable pieces satisfy.

A country's contribution and a training callback are each declared here, so someone adding either
reads one interface instead of inferring the shape from an existing implementation. Nothing
inherits from these: they are structural, checked by mypy and by `isinstance` in tests.

Each member below is a shape the tree already carries. A protocol that describes an interface
nobody implements reads as a contract and enforces nothing, so a member is added here when the
code it names exists, not in anticipation of it.
"""

from __future__ import annotations

import argparse
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class CountryModule(Protocol):
    """What one country contributes to training.

    The implementer is a module, not an instance, which is why the settings are spelled as module
    constants. `BOARD_BUCKET_MIN` is the municipality-population floor above which rows go to the
    held-out board rather than the training pool; each country sets its own, because the population
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
    """One subcommand of `python -m mailwoman_train`.

    The implementer is a module under `cli/commands/`. A command declares its own flags, so its
    body and its interface are read together instead of a hundred lines apart, and adding one
    touches no other command's code.
    """

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
    """One concern observed during a training run.

    Every hook answers None. A callback never steers the loop: it observes, writes or reports, and
    one that must stop a run raises. `state` is `Any` rather than a named type because the loop's
    state object lives in `train.trainer`, and importing it here would put the training loop behind
    every module that reads an interface.
    """

    def on_train_begin(self, state: Any) -> None: ...

    def on_step_end(self, state: Any, step: int) -> None: ...

    def on_eval_end(self, state: Any, step: int, metrics: dict[str, float]) -> None: ...

    def on_train_end(self, state: Any) -> None: ...
