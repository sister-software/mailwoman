"""The argument parser, assembled from the command registry."""

from __future__ import annotations

import argparse
from typing import Any

from .commands import COMMANDS

DESCRIPTION = "Train, evaluate, export and package the Stage 1 coarse address model."


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m mailwoman_train", description=DESCRIPTION)
    subparsers = parser.add_subparsers(dest="cmd", required=True)
    for command in COMMANDS:
        command.add_parser(subparsers)
    return parser


def main(argv: list[str] | None = None) -> Any:
    """Parse and dispatch. Answers the chosen command's exit code."""
    # The math SDPA kernel is the only one that runs stably on Radeon 780M — flash and
    # mem-efficient hang. Importing torch lazily keeps a help-only invocation fast, and its absence
    # is normal in a lint-only environment.
    try:
        from ..nn.encoder import force_math_sdpa

        force_math_sdpa()
    except ImportError:  # pragma: no cover — torch may not be installed
        pass
    args = build_parser().parse_args(argv)
    return args.func(args)
