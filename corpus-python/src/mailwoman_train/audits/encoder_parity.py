"""Record the tensors the training loader feeds the model, and compare a later loader against the record.

`capture` draws batches through `iter_batches` for one config, split and seed, converts each batch with
`to_tensor_batch` on the CPU, and writes two files to a record directory:

- `record.json` holds the inputs that decide the encoding and a digest per row of every model-input tensor.
- `arrays.npz` holds every tensor, concatenated over rows, so a mismatch can be located to one element.

The digest of a row's tensor is the SHA-256 of its contiguous little-endian bytes: int64 for ids, masks and labels,
float32 for every channel. The record also lists each emitted row's identity, its country and source, the batch
sizes the loader yielded, the channels present, and per channel how many rows and elements hold a nonzero value.

`verify` draws the same batches from the current loader and compares them with a record. It fails on any change
of emitted row count, row identity, batch boundaries, tensor set, dtype or shape before it compares digests, and it
reports the first differing row, tensor and element with both values. A requested input the record names but the
host cannot read raises rather than being compared as absent.

The record directory lives outside the repository, under `$MAILWOMAN_DATA_ROOT/audits/encoder-parity/`, because
its arrays hold address text's encodings at a size git should not carry.

Usage:

    python -m mailwoman_train.audits.encoder_parity capture --config <yaml> --split train --seed 43 --rows 2000 \\
        --name c6-train-2k [--set data.anchor_paint_mode=gold] [--drop-spans]
    python -m mailwoman_train.audits.encoder_parity verify --name c6-train-2k [--report <json>]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess  # nosec B404: reads the source revision from git with a fixed argument list
import sys
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterator
from dataclasses import fields, is_dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
import yaml

from ..config import Config, load_config
from ..data.loader import corpus_files
from ..data.source_reps import resolve_config_reps
from ..env import volume_path_on_host
from ..paths import data_root_path, package_path, repo_root_path
from ..train.batch import to_tensor_batch

#: The version of the record layout. `verify` refuses a record of another version.
RECORD_FORMAT = 1

#: The tensors every row has, in the order the digest table lists them.
BASE_TENSORS = ("input_ids", "attention_mask", "labels", "locale_ids", "address_system_ids")

#: The channels the loader may emit, in the encoder's block order.
CHANNELS = ("anchor", "gazetteer", "country", "street_type", "locality_surface", "code_unit")

#: Every `data` field naming a file or directory the encoding reads.
INPUT_FIELDS = (
    "tokenizer_dir",
    "anchor_lookup_path",
    "gazetteer_lexicon_path",
    "country_lexicon_path",
    "street_type_lexicon_path",
    "locality_surface_lexicon_path",
    "affix_relabel_lexicon_path",
)

#: The record files the encoding reads from the source tree rather than from the config.
SOURCE_RECORDS = (("features", "postcode-shapes.json"), ("data", "postcode-syntax.json"))

_CPU = torch.device("cpu")


def record_dir(name: str) -> Path:
    """The directory a named record lives in, under the data root."""
    return data_root_path("audits", "encoder-parity", name)


def _host_path(value: str) -> str:
    """A config path under the volume mount, rewritten to its host copy when the host keeps one."""
    on_host = volume_path_on_host(Path(value))
    return str(on_host) if on_host is not None else value


def _coerce(value: str) -> Any:
    """A `--set` value parsed as YAML, so `false`, `16` and `null` take their types."""
    return yaml.safe_load(value)


def prepare_config(config_path: Path, overrides: list[str]) -> Config:
    """Load a config, apply `section.key=value` overrides, resolve its source reps, and re-root its paths."""
    cfg = load_config(config_path)
    for override in overrides:
        key, sep, raw = override.partition("=")
        section, dot, attribute = key.partition(".")
        if not sep or not dot or not hasattr(cfg, section) or not hasattr(getattr(cfg, section), attribute):
            raise ValueError(f"--set expects section.key=value naming an existing field, got {override!r}")
        setattr(getattr(cfg, section), attribute, _coerce(raw))
    data = cfg.data
    data.corpus_dir = _host_path(data.corpus_dir)
    for attribute in INPUT_FIELDS:
        value = getattr(data, attribute, None)
        if value:
            setattr(data, attribute, _host_path(value))
    resolve_config_reps(cfg)
    return cfg


def _sha256(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(f"encoder parity: requested input {path} is not a readable file")
    return corpus_files.file_sha256(path)


def input_hashes(cfg: Config) -> dict[str, dict[str, str]]:
    """The SHA-256 of every file the encoding reads, keyed by the config field or record that names it."""
    out: dict[str, dict[str, str]] = {}
    data = cfg.data
    for attribute in INPUT_FIELDS:
        value = getattr(data, attribute, None)
        if not value:
            continue
        path = Path(value) / "tokenizer.model" if attribute == "tokenizer_dir" else Path(value)
        out[attribute] = {"path": str(path), "sha256": _sha256(path)}
    for parts in SOURCE_RECORDS:
        path = package_path(*parts)
        out["/".join(parts)] = {"path": str(path), "sha256": _sha256(path)}
    manifest = Path(data.corpus_dir) / "MANIFEST.json"
    out["corpus_manifest"] = {"path": str(manifest), "sha256": _sha256(manifest)}
    return out


def _config_snapshot(cfg: Config) -> dict[str, Any]:
    """The config's `data` and `train` sections as plain values, for the record."""

    def plain(value: Any) -> Any:
        if is_dataclass(value) and not isinstance(value, type):
            return {f.name: plain(getattr(value, f.name)) for f in fields(value)}
        if isinstance(value, dict):
            return {str(k): plain(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [plain(v) for v in value]
        return value

    return {"data": plain(cfg.data), "train": plain(cfg.train)}


def _source_revision() -> str:
    completed = subprocess.run(  # nosec B603 B607: fixed argument list
        ["git", "-C", str(repo_root_path()), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    )
    return completed.stdout.strip()


def runtime() -> dict[str, str]:
    """The interpreter and library versions an encoding depends on."""
    import sentencepiece

    return {
        "python": platform.python_version(),
        "unicode": unicodedata.unidata_version,
        "numpy": np.__version__,
        "torch": torch.__version__,
        "sentencepiece": sentencepiece.__version__,
    }


def row_identity(row: dict[str, Any]) -> str:
    """The SHA-256 of a sampled row's text and labels, which identifies the row without storing its text."""
    material = {
        "raw": row["raw"],
        "tokens": list(row.get("tokens") or []),
        "labels": list(row.get("labels") or []),
        "span_starts": None if row.get("span_starts") is None else list(row["span_starts"]),
        "span_ends": None if row.get("span_ends") is None else list(row["span_ends"]),
        "span_tags": None if row.get("span_tags") is None else list(row["span_tags"]),
        "country": row.get("country"),
        "source": row.get("source"),
    }
    return hashlib.sha256(json.dumps(material, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _drop_spans(rows: Iterator[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    """The sampled rows without their span triple, so the encoder takes the token-label path."""
    for row in rows:
        yield {key: value for key, value in row.items() if key not in ("span_starts", "span_ends", "span_tags")}


def open_batches(
    cfg: Config,
    *,
    split: str,
    seed: int,
    rows: int,
    batch_size: int,
    drop_spans: bool,
    observer: Callable[[dict[str, Any]], None],
) -> Iterator[dict[str, Any]]:
    """The loader's batches for one draw, through the interface the training loop calls."""
    from ..data.loader import batch as batch_module
    from ..data.loader import encode as encode_module
    from ..tokenizer import Tokenizer

    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    encoder = encode_module.build_row_encoder(cfg.data, tokenizer)
    # The sampler `iter_sampled_rows` reads, replaced for the token-label arm by one that drops the span triple.
    sampler = getattr(encode_module, "iter_rows")  # noqa: B009
    if drop_spans:
        setattr(encode_module, "iter_rows", lambda *a, **k: _drop_spans(sampler(*a, **k)))  # noqa: B010
    try:
        yield from batch_module.iter_batches(
            cfg, encoder, split=split, batch_size=batch_size, seed=seed, row_limit=rows, observer=observer
        )
    finally:
        setattr(encode_module, "iter_rows", sampler)  # noqa: B010


def _tensor_names(batch: dict[str, Any]) -> list[str]:
    names = [name for name in BASE_TENSORS if name in batch]
    for channel in CHANNELS:
        if f"{channel}_features" in batch:
            names += [f"{channel}_features", f"{channel}_confidence"]
    return names


def draw(
    cfg: Config, *, split: str, seed: int, rows: int, batch_size: int, drop_spans: bool
) -> tuple[dict[str, np.ndarray], list[int], list[dict[str, Any]]]:
    """Every tensor of one draw concatenated over rows, the batch sizes, and the observed rows in order."""
    observed: list[dict[str, Any]] = []
    parts: dict[str, list[np.ndarray]] = {}
    sizes: list[int] = []
    names: list[str] | None = None
    for batch in open_batches(
        cfg, split=split, seed=seed, rows=rows, batch_size=batch_size, drop_spans=drop_spans, observer=observed.append
    ):
        tensors = to_tensor_batch(batch, _CPU)
        batch_names = _tensor_names(tensors)
        if names is None:
            names = batch_names
        elif batch_names != names:
            raise ValueError(f"encoder parity: batch {len(sizes)} has tensors {batch_names}, the first had {names}")
        for name in names:
            parts.setdefault(name, []).append(np.ascontiguousarray(tensors[name].numpy()))
        sizes.append(int(tensors["input_ids"].shape[0]))
    arrays = {name: np.concatenate(chunks) for name, chunks in parts.items()}
    if len(observed) != sum(sizes):
        raise ValueError(f"encoder parity: the observer saw {len(observed)} rows, the batches held {sum(sizes)}")
    return arrays, sizes, observed


def _le_bytes(array: np.ndarray) -> bytes:
    return np.ascontiguousarray(array.astype(array.dtype.newbyteorder("<"), copy=False)).tobytes()


def digests(arrays: dict[str, np.ndarray]) -> dict[str, list[str]]:
    """A SHA-256 per row of each tensor, over its contiguous little-endian bytes."""
    return {name: [hashlib.sha256(_le_bytes(row)).hexdigest() for row in array] for name, array in arrays.items()}


def channel_counts(arrays: dict[str, np.ndarray]) -> dict[str, dict[str, int]]:
    """Per configured channel, the rows and elements holding a nonzero feature or confidence, with denominators."""
    out: dict[str, dict[str, int]] = {}
    for channel in CHANNELS:
        features = arrays.get(f"{channel}_features")
        if features is None:
            continue
        confidence = arrays[f"{channel}_confidence"]
        out[channel] = {
            "rows": int(features.shape[0]),
            "rows_with_nonzero_feature": int(np.count_nonzero(features.reshape(features.shape[0], -1).any(axis=1))),
            "rows_with_nonzero_confidence": int(np.count_nonzero(confidence.any(axis=1))),
            "feature_elements": int(features.size),
            "nonzero_feature_elements": int(np.count_nonzero(features)),
            "confidence_elements": int(confidence.size),
            "nonzero_confidence_elements": int(np.count_nonzero(confidence)),
        }
    return out


def capture(
    cfg: Config,
    *,
    config_path: Path,
    overrides: list[str],
    split: str,
    seed: int,
    rows: int,
    batch_size: int,
    drop_spans: bool,
    out_dir: Path,
) -> dict[str, Any]:
    """Draw one sample through the current loader and write its record and arrays to `out_dir`."""
    inputs = input_hashes(cfg)
    arrays, sizes, observed = draw(cfg, split=split, seed=seed, rows=rows, batch_size=batch_size, drop_spans=drop_spans)
    record = {
        "format": RECORD_FORMAT,
        "source_revision": _source_revision(),
        "config": {"path": str(config_path), "sha256": _sha256(config_path), "overrides": overrides},
        "config_snapshot": _config_snapshot(cfg),
        "inputs": inputs,
        "runtime": runtime(),
        "split": split,
        "seed": seed,
        "requested_rows": rows,
        "batch_size": batch_size,
        "drop_spans": drop_spans,
        "emitted_rows": sum(sizes),
        "batch_sizes": sizes,
        "tensors": {
            name: {"dtype": str(array.dtype), "row_shape": list(array.shape[1:])} for name, array in arrays.items()
        },
        "channels": channel_counts(arrays),
        "rows_by_country": dict(sorted(Counter(str(row.get("country")) for row in observed).items())),
        "rows_with_spans": sum(1 for row in observed if row.get("span_starts") is not None),
        "row_identity": [row_identity(row) for row in observed],
        "digests": digests(arrays),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out_dir / "arrays.npz", **arrays)  # type: ignore[arg-type]
    (out_dir / "record.json").write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
    return record


def recorded_config_path(record: dict[str, Any]) -> Path:
    """The config a record was captured with: its recorded path, or the package's copy of that file.

    A record stores the config's absolute path in the checkout it was captured in. When that checkout is gone,
    the package's config of the same name is used, and only if its SHA-256 is the recorded one.
    """
    path = Path(record["config"]["path"])
    if not path.is_file():
        path = package_path("configs", path.name)
    digest = _sha256(path)
    if digest != record["config"]["sha256"]:
        raise ValueError(f"encoder parity: {path} has sha256 {digest}, the record was captured with {record['config']}")
    return path


def _first_difference(reference: np.ndarray, actual: np.ndarray) -> dict[str, Any]:
    """The flat position and both values of the first element where two equal-shape rows differ bytewise."""
    ref = np.ascontiguousarray(reference).reshape(-1)
    act = np.ascontiguousarray(actual).reshape(-1)
    if ref.dtype.kind == "f":
        differ = ref.view(np.uint32 if ref.itemsize == 4 else np.uint64) != act.view(
            np.uint32 if act.itemsize == 4 else np.uint64
        )
    else:
        differ = ref != act
    position = int(np.argmax(differ))
    index = np.unravel_index(position, reference.shape)
    return {
        "element": [int(i) for i in index],
        "reference": ref[position].item(),
        "actual": act[position].item(),
    }


def verify(record: dict[str, Any], cfg: Config, *, out_dir: Path) -> dict[str, Any]:
    """Draw the record's sample through the current loader and compare it with the record and its arrays."""
    if record.get("format") != RECORD_FORMAT:
        raise ValueError(f"encoder parity: record format {record.get('format')} is not {RECORD_FORMAT}")
    inputs = input_hashes(cfg)
    changed_inputs = {
        key: {"recorded": record["inputs"].get(key), "now": value}
        for key, value in inputs.items()
        if record["inputs"].get(key, {}).get("sha256") != value["sha256"]
    }
    missing_inputs = sorted(set(record["inputs"]) - set(inputs))
    if missing_inputs:
        raise ValueError(f"encoder parity: the record names inputs the current config lacks: {missing_inputs}")
    arrays, sizes, observed = draw(
        cfg,
        split=record["split"],
        seed=record["seed"],
        rows=record["requested_rows"],
        batch_size=record["batch_size"],
        drop_spans=record["drop_spans"],
    )
    structural: list[str] = []
    if sum(sizes) != record["emitted_rows"]:
        structural.append(f"emitted rows {sum(sizes)} != recorded {record['emitted_rows']}")
    if sizes != record["batch_sizes"]:
        structural.append("batch sizes differ from the record")
    identities = [row_identity(row) for row in observed]
    if identities != record["row_identity"]:
        first = next(
            (i for i, (a, b) in enumerate(zip(identities, record["row_identity"], strict=False)) if a != b),
            min(len(identities), len(record["row_identity"])),
        )
        structural.append(f"sampled rows differ from the record, first at row {first}")
    shapes = {name: {"dtype": str(a.dtype), "row_shape": list(a.shape[1:])} for name, a in arrays.items()}
    if shapes != record["tensors"]:
        structural.append(f"tensor set, dtypes or shapes differ: now {shapes}, recorded {record['tensors']}")

    report: dict[str, Any] = {
        "record": str(out_dir),
        "emitted_rows": sum(sizes),
        "recorded_rows": record["emitted_rows"],
        "changed_inputs": changed_inputs,
        "structural": structural,
        "tensors": {},
        "first_mismatch": None,
    }
    if structural:
        report["equal"] = False
        return report

    now = digests(arrays)
    reference: Any = None
    for name in record["tensors"]:
        differing = [i for i, (a, b) in enumerate(zip(now[name], record["digests"][name], strict=True)) if a != b]
        report["tensors"][name] = {"rows": len(now[name]), "differing_rows": len(differing)}
        if differing and report["first_mismatch"] is None:
            if reference is None:
                reference = np.load(out_dir / "arrays.npz")
            row = differing[0]
            report["first_mismatch"] = {
                "row": row,
                "tensor": name,
                "row_identity": identities[row],
                "country": observed[row].get("country"),
                **_first_difference(reference[name][row], arrays[name][row]),
            }
    report["differing_rows"] = len(
        {
            i
            for name in record["tensors"]
            for i, (a, b) in enumerate(zip(now[name], record["digests"][name], strict=True))
            if a != b
        }
    )
    report["equal"] = report["differing_rows"] == 0
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="encoder_parity", description=__doc__.split("\n\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    cap = commands.add_parser("capture", help="record the current loader's tensors for one draw")
    cap.add_argument("--config", required=True, type=Path)
    cap.add_argument("--split", required=True, choices=("train", "val"))
    cap.add_argument("--seed", required=True, type=int)
    cap.add_argument("--rows", required=True, type=int)
    cap.add_argument("--name", required=True, help="the record directory's name under audits/encoder-parity/")
    cap.add_argument("--batch-size", type=int, default=None, help="defaults to the config's train.batch_size")
    cap.add_argument("--set", dest="overrides", action="append", default=[], help="section.key=value")
    cap.add_argument("--drop-spans", action="store_true", help="encode through the token-label path")
    ver = commands.add_parser("verify", help="compare the current loader with a record")
    ver.add_argument("--name", required=True)
    ver.add_argument("--report", type=Path, default=None)
    args = parser.parse_args(argv)

    if args.command == "capture":
        cfg = prepare_config(args.config, args.overrides)
        out_dir = record_dir(args.name)
        record = capture(
            cfg,
            config_path=args.config,
            overrides=args.overrides,
            split=args.split,
            seed=args.seed,
            rows=args.rows,
            batch_size=args.batch_size or cfg.train.batch_size,
            drop_spans=args.drop_spans,
            out_dir=out_dir,
        )
        print(
            f"captured {record['emitted_rows']} of {record['requested_rows']} requested rows in "
            f"{len(record['batch_sizes'])} batches to {out_dir}"
        )
        print(f"tensors: {', '.join(record['tensors'])}")
        print(f"channels: {json.dumps(record['channels'])}")
        return 0

    out_dir = record_dir(args.name)
    record = json.loads((out_dir / "record.json").read_text(encoding="utf-8"))
    cfg = prepare_config(recorded_config_path(record), record["config"]["overrides"])
    report = verify(record, cfg, out_dir=out_dir)
    text = json.dumps(report, indent=1)
    if args.report is not None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if report["equal"] else 1


if __name__ == "__main__":
    sys.exit(main())
