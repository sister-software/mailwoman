"""The `--smoke-mode` flag, shared by the two commands that train.

`train` takes it as an override and `smoke` defaults it to `constant`, so it lives beside them
rather than inside either. It is CLI policy, not config: `constant` overrides whatever schedule the
recipe named, and `long-tail` changes nothing but warns.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

#: Below this, a cosine tail occupies enough of a smoke run's visible window to hide divergence.
LONG_TAIL_MIN_STEPS = 10000


def apply_smoke_mode(args: argparse.Namespace, cfg: Any) -> None:
    """Translate `--smoke-mode` into `cfg.train.lr_schedule`.

    `long-tail` keeps cosine and only warns when `max_steps` is short, because the operator may
    know something the threshold does not — a wrong warning costs a line of output, a wrong error
    costs the run.
    """
    mode = getattr(args, "smoke_mode", None)
    if mode is None:
        return
    if mode == "constant":
        cfg.train.lr_schedule = "constant"
        return
    if mode == "long-tail":
        if cfg.train.max_steps < LONG_TAIL_MIN_STEPS:
            sys.stderr.write(
                f"warning: --smoke-mode long-tail expects max_steps>={LONG_TAIL_MIN_STEPS}; got "
                f"{cfg.train.max_steps}. Cosine tail may mask divergence.\n"
            )
        return
    raise ValueError(f"unknown --smoke-mode={mode!r}")


def add_smoke_mode_flag(parser: argparse.ArgumentParser, *, help_text: str) -> None:
    parser.add_argument("--smoke-mode", choices=("constant", "long-tail"), default=None, help=help_text)
