"""Scratch audit for #1248: which keys would a strict merge reject?

Walks every YAML in src/mailwoman_train/configs/ recursively against the
dataclass field tree (Config -> data/model/train/eval), collecting EVERY
unknown dotted key path (not just the first, which is all a raising _merge
reports). Also records non-unknown-key load errors separately (e.g. the YAML
Norway guard) so the two failure classes don't blur.
"""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from mailwoman_train.config import Config, load_config  # noqa: E402

CONFIGS_DIR = Path(__file__).resolve().parent.parent / "src" / "mailwoman_train" / "configs"


def audit_keys(node: object, schema: type, prefix: str, junk: list[str]) -> None:
    if not isinstance(node, dict):
        return
    fields = {f.name: f for f in dataclasses.fields(schema)}
    for key, value in node.items():
        dotted = f"{prefix}.{key}" if prefix else str(key)
        field = fields.get(str(key))
        if field is None:
            junk.append(dotted)
            continue
        # Recurse into nested dataclass sections (data/model/train/eval).
        field_type = field.type
        if isinstance(field_type, type) and dataclasses.is_dataclass(field_type):
            audit_keys(value, field_type, dotted, junk)


def main() -> None:
    total_junk: dict[str, list[str]] = {}
    other_errors: dict[str, str] = {}
    files = sorted(CONFIGS_DIR.glob("*.yaml"))
    for path in files:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        junk: list[str] = []
        audit_keys(data, Config, "", junk)
        if junk:
            total_junk[path.name] = junk
        # Also surface non-junk load failures (strict merge raises on the first
        # unknown key; the Norway guard raises ValueError on retyped keys).
        try:
            load_config(path)
        except Exception as exc:  # noqa: BLE001 — audit wants every failure class
            other_errors[path.name] = f"{type(exc).__name__}: {exc}"

    print(f"audited {len(files)} config files\n")
    if total_junk:
        print("JUNK KEYS (unknown to the dataclass schema):")
        for name, keys in total_junk.items():
            for key in keys:
                print(f"  {name}: {key}")
    else:
        print("JUNK KEYS: none — every key in every config resolves against the schema.")
    print()
    if other_errors:
        print("OTHER LOAD ERRORS (not unknown-key):")
        for name, err in other_errors.items():
            print(f"  {name}: {err}")
    else:
        print("OTHER LOAD ERRORS: none.")


if __name__ == "__main__":
    main()
