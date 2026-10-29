"""Write what the Python loader reads from each training config, one JSON line per file.

``python -m mailwoman_train.config.dump <config.yaml>...`` is the Python side of the comparison with the TypeScript
resolver in ``packages/corpus/lib/training/config/load.ts`` (#2874). Each scalar records its Python type, so an int
and a float stay distinct across JSON, and each mapping records its keys in order with their types. A refusal is
recorded with its exception class and message. The module goes when the loader it reads goes.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

from ..source_rights import SourceRightsError
from .load import admitted_sources, corpus_version, csv_log_path, load_config, load_training_config


def typed(value: Any) -> Any:
    """Mark each scalar's Python type and each mapping's key order, as the TypeScript side marks them."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        return {"$int": str(value)}
    if isinstance(value, float):
        return {"$float": repr(value)}
    if isinstance(value, dict):
        return {"$map": [[typed(key), typed(entry)] for key, entry in value.items()]}
    if isinstance(value, (list, tuple)):
        return [typed(entry) for entry in value]
    return {"$other": repr(value)}


def _refusal(exc: Exception) -> dict[str, str]:
    """The class and message of a refusal. A ``KeyError``'s ``str`` quotes its message, so its argument is read."""
    message = str(exc.args[0]) if isinstance(exc, KeyError) and exc.args else str(exc)
    return {"type": type(exc).__name__, "message": message}


def dump(path: Path) -> dict[str, Any]:
    """What the loader reads from one config, its derived values, and its source admission."""
    out: dict[str, Any] = {"name": path.name}
    try:
        cfg = load_config(path)
        out["config"] = typed(asdict(cfg))
        out["admitted_sources"] = admitted_sources(cfg)
        out["corpus_version"] = corpus_version(cfg)
        out["csv_log_path"] = str(csv_log_path(cfg))
    except (KeyError, TypeError, ValueError) as exc:
        out["load_error"] = _refusal(exc)
        return out
    stderr = io.StringIO()
    try:
        with contextlib.redirect_stderr(stderr):
            _cfg, record = load_training_config(path)
        out["admission"] = record.to_json()
    except SourceRightsError as exc:
        out["admission_error"] = _refusal(exc)
    out["admission_log"] = stderr.getvalue().splitlines()
    return out


def main(argv: list[str]) -> None:
    for argument in argv:
        print(json.dumps(dump(Path(argument)), ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
