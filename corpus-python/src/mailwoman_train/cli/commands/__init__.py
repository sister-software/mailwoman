"""The subcommands, as a registry.

A command is a module exporting `NAME`, `add_parser`, plus `run` — `protocols.CLICommand`. Each new command
needs a module here and a registry entry below. `build_parser` stays unchanged.

The order matches `--help`: the pipeline commands come first, followed by the two tokenizer commands.
The tokenizer commands sit outside the pipeline.
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
