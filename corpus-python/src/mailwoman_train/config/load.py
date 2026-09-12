"""Read a YAML run config into the typed schema.

Nothing here reads an environment variable. The default config lives at
``configs/stage1-coarse.yaml`` and is what the trainer consumes when ``--config`` is omitted.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .schema import Config, CorpusReceiptConfig, DataConfig


def merge_into(
    dst: Any,
    src: dict[str, Any],
    *,
    strict: bool = True,
    _path: str = "",
    _source: str = "<mapping>",
) -> None:
    """Merge ``src`` into ``dst``, key by key.

    ``strict=True`` (the default, and what every training entrypoint gets): an unknown
    key RAISES, naming the full dotted path and the config source — the 2026-07-22
    en-GB probe run A burned a launch cycle when a YAML carrying
    ``train.reinit_label_rows`` + ``train.classifier_learning_rate`` met a volume-side
    config that predated those fields and the settings went inert with zero signal
    (#1248). Config guards raise, the same discipline as ``DataConfig``'s Norway guard.

    ``strict=False`` is the override: unknown keys are silently skipped (the
    historical hasattr-check behavior). Reserved for tooling that intentionally
    consumes a partial view of a config; never for training entrypoints.
    """
    for k, v in src.items():
        dotted = f"{_path}.{k}" if _path else str(k)
        if not hasattr(dst, k):
            if strict:
                raise KeyError(
                    f"unknown config key {dotted!r} in {_source}: "
                    f"{dst.__class__.__name__} has no field {k!r}. "
                    "Either the key is a typo, or the config predates/postdates this "
                    "code — sync the volume-side source before launching (#1248)."
                )
            continue
        cur = getattr(dst, k)
        if hasattr(cur, "__dataclass_fields__") and isinstance(v, dict):
            merge_into(cur, v, strict=strict, _path=dotted, _source=_source)
        else:
            setattr(dst, k, _coerce(dst, k, v, strict=strict, path=dotted, source=_source))


def _coerce(
    dst: Any,
    key: str,
    value: Any,
    *,
    strict: bool = True,
    path: str = "",
    source: str = "<mapping>",
) -> Any:
    """Coerce ``value`` to the dataclass field's declared type when an obvious conversion
    is safe. Targets one specific misuse hazard: PyYAML's default loader parses ``5e-4`` as a
    string (YAML 1.1 spec requires a dot for floats), so a YAML config that writes
    ``learning_rate: 5e-4`` silently makes its way into ``AdamW(lr="5e-4")`` and crashes
    with a confusing ``TypeError: '<=' not supported between instances of 'float' and 'str'``.
    Defensive coercion here means the configs work regardless of whether the human used
    YAML 1.1 or YAML 1.2 numeric syntax. Only fires when the declared type is ``float`` or
    ``int`` and the source is a string that parses cleanly — leaves all other values alone.
    """
    fields = getattr(dst.__class__, "__dataclass_fields__", None)
    if not fields or key not in fields:
        return value
    if isinstance(dst, DataConfig) and key == "required_corpus_receipts":
        if not isinstance(value, list):
            raise TypeError("data.required_corpus_receipts must be a list")
        receipts: list[CorpusReceiptConfig] = []
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                raise TypeError(f"data.required_corpus_receipts[{index}] must be a mapping")
            receipt = CorpusReceiptConfig()
            merge_into(
                receipt,
                item,
                strict=strict,
                _path=f"{path}[{index}]",
                _source=source,
            )
            receipts.append(receipt)
        for receipt in receipts:
            if not isinstance(receipt.name, str):
                raise TypeError("corpus receipt name must be a string")
            if type(receipt.min_draws) is not int:
                raise TypeError(f"receipt {receipt.name!r} min_draws must be an integer")
            if receipt.source is not None and not isinstance(receipt.source, str):
                raise TypeError(f"receipt {receipt.name!r} source must be a string or null")
            if receipt.country is not None and not isinstance(receipt.country, str):
                raise TypeError(f"receipt {receipt.name!r} country must be a string or null")
            if not isinstance(receipt.component_sequence, list) or not all(
                isinstance(tag, str) for tag in receipt.component_sequence
            ):
                raise TypeError(f"receipt {receipt.name!r} component_sequence must be a list of strings")
        names = [receipt.name for receipt in receipts]
        if any(not name.strip() for name in names):
            raise ValueError("every data.required_corpus_receipts entry needs a non-empty name")
        if len(names) != len(set(names)):
            raise ValueError("data.required_corpus_receipts names must be unique")
        for receipt in receipts:
            if receipt.min_draws <= 0:
                raise ValueError(f"receipt {receipt.name!r} min_draws must be positive")
            invalid = [tag for tag in receipt.component_sequence if not tag or tag == "O" or "-" in tag]
            if invalid:
                raise ValueError(
                    f"receipt {receipt.name!r} component_sequence must contain bare component tags, got {invalid!r}"
                )
        return receipts
    declared = fields[key].type
    if not isinstance(value, str):
        return value
    if declared in (float, "float"):
        try:
            return float(value)
        except ValueError:
            return value
    if declared in (int, "int"):
        try:
            return int(value)
        except ValueError:
            return value
    return value


def load_config(path: str | Path | None, *, strict: bool = True) -> Config:
    cfg = Config()
    if path is None:
        return cfg
    p = Path(path)
    with p.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError(f"expected top-level mapping in {p}")
    merge_into(cfg, data, strict=strict, _source=str(p))
    return cfg


def csv_log_path(cfg: Config) -> Path:
    template = cfg.train.csv_log_path
    return Path(template.format(output_dir=cfg.train.output_dir))
