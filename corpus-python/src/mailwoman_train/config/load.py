"""Read a YAML run config into the typed schema without consulting environment variables."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .schema import Config, CorpusReceiptConfig, DataConfig, ValidationCoverageConfig


def merge_into(
    dst: Any,
    src: dict[str, Any],
    *,
    strict: bool = True,
    _path: str = "",
    _source: str = "<mapping>",
) -> None:
    """Merge ``src`` into ``dst``, key by key.

    With ``strict=True``, an unknown key raises a ``KeyError`` that gives its dotted path and the
    config source. Training entrypoints must stay strict, because a skipped key silently leaves a
    setting at its default. This happens when the volume holds older code than the YAML expects.

    With ``strict=False``, unknown keys are skipped. Only tooling that reads part of a config
    should use it.
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
    """Validate list-of-mapping fields and convert numeric strings to the field's declared type.

    ``required_corpus_receipts`` and ``required_validation_coverage`` are parsed into their
    dataclasses and validated here. For a ``float`` or ``int`` field, a string that parses is
    converted, because PyYAML reads ``5e-4`` as a string under YAML 1.1. Every other value is
    returned unchanged.
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
    if isinstance(dst, DataConfig) and key == "required_validation_coverage":
        if not isinstance(value, list):
            raise TypeError("data.required_validation_coverage must be a list")
        wanted: list[ValidationCoverageConfig] = []
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                raise TypeError(f"data.required_validation_coverage[{index}] must be a mapping")
            entry = ValidationCoverageConfig()
            merge_into(entry, item, strict=strict, _path=f"{path}[{index}]", _source=source)
            wanted.append(entry)
        for entry in wanted:
            if not isinstance(entry.country, str) or not entry.country.strip():
                raise ValueError("every data.required_validation_coverage entry needs a country")
            if entry.split not in ("val", "test"):
                raise ValueError(
                    f"validation coverage for {entry.country!r} names split {entry.split!r}; "
                    "only 'val' and 'test' are held out"
                )
            if type(entry.min_rows) is not int or type(entry.min_street_rows) is not int:
                raise TypeError(f"validation coverage for {entry.country!r} needs integer minimums")
            if entry.min_rows <= 0:
                raise ValueError(f"validation coverage for {entry.country!r} min_rows must be positive")
            if entry.min_street_rows < 0:
                raise ValueError(f"validation coverage for {entry.country!r} min_street_rows cannot be negative")
            # Street rows are a subset of rows, so this floor can never pass and is a config error.
            if entry.min_street_rows > entry.min_rows:
                raise ValueError(
                    f"validation coverage for {entry.country!r} asks for {entry.min_street_rows} street rows "
                    f"within {entry.min_rows} rows, which no split can satisfy"
                )
        keys = [(entry.country, entry.split) for entry in wanted]
        if len(keys) != len(set(keys)):
            raise ValueError("data.required_validation_coverage entries must be unique per country and split")
        return wanted
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
    """Load the YAML file at ``path`` over the schema defaults. ``None`` returns the defaults."""
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
    """Return the CSV log path with ``{output_dir}`` filled in."""
    template = cfg.train.csv_log_path
    return Path(template.format(output_dir=cfg.train.output_dir))
