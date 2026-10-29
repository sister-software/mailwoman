"""The subcommands, as a registry.

A command is a module exporting `NAME`, `add_parser`, plus `run` — `protocols.CLICommand`. Each new command
needs a module here and a registry entry below. `build_parser` stays unchanged.

The order matches `--help`, the pipeline order. Tokenizer training, splicing, pruning and checking are the
TypeScript tools under `packages/mtf/tools/tokenizer/`. ONNX export, int8 quantization and the embedding split are
`trainer-export export-onnx`, `quantize` and `split-embeddings` in `packages/trainer`, and the weights package is
`packages/mailwoman/tools/release-tools/package-weights.run.ts`.
"""

from __future__ import annotations

from ...protocols import CLICommand
from . import evaluate, smoke, train

COMMANDS: tuple[CLICommand, ...] = (
    train,
    evaluate,
    smoke,
)

__all__ = ["COMMANDS"]
