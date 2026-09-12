"""The subcommands, as a registry.

A command is a module exporting `NAME`, `add_parser` and `run` — `protocols.CLICommand`. Adding one
is a module here and one line below; no other command's code is touched, and `build_parser` does
not grow.

The order is the order `--help` lists them: the pipeline as it runs, then the two tokenizer
commands, which stand outside it.
"""

from __future__ import annotations

from ...protocols import CLICommand
from . import evaluate, export, package, quantize, smoke, tokenizer, train, verify_tokenizer

COMMANDS: tuple[CLICommand, ...] = (
    train,
    evaluate,
    export,
    quantize,
    package,
    smoke,
    tokenizer,
    verify_tokenizer,
)

__all__ = ["COMMANDS"]
