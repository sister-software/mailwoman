"""Define interfaces for CLI commands. Define the training callback interface."""

from __future__ import annotations

import argparse
from typing import Any, Protocol, runtime_checkable


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
    """One concern observed during a training run. Hooks return `None` unless they must stop the run.

    A stopping hook raises. `state` is `Any` so modules that read the interface need not import the
    training loop.
    """

    def on_train_begin(self, state: Any) -> None: ...

    def on_step_end(self, state: Any, step: int) -> None: ...

    def on_eval_end(self, state: Any, step: int, metrics: dict[str, float]) -> None: ...

    def on_train_end(self, state: Any) -> None: ...
