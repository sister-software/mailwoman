"""The `python -m mailwoman_train` command line.

`commands/` holds one module per subcommand. `parser.py` assembles them. Callers import this module.
"""

from __future__ import annotations

from .commands import COMMANDS
from .parser import build_parser, main

__all__ = ["COMMANDS", "build_parser", "main"]
