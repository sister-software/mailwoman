"""The subcommands, as a registry.

A command is a module exporting `NAME`, `add_parser`, plus `run` — `protocols.CLICommand`. Each new command
needs a module here and a registry entry below. `build_parser` stays unchanged.

The order matches `--help`, the pipeline order. Tokenizer training, splicing, pruning and checking are the
TypeScript tools under `packages/mtf/tools/tokenizer/`.
"""

from __future__ import annotations

from ...protocols import CLICommand
from . import evaluate, export, package, quantize, smoke, split_embeddings, train

COMMANDS: tuple[CLICommand, ...] = (
    train,
    evaluate,
    export,
    quantize,
    split_embeddings,
    package,
    smoke,
)

__all__ = ["COMMANDS"]
