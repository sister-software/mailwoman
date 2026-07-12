#!/usr/bin/env python3
"""Down-convert an OpenAPI 3.1 spec to 3.0.3 for progenitor.

progenitor 0.14 parses OpenAPI via the `openapiv3` crate, which only understands 3.0.x. Our
published specs are 3.1, so this script rewrites the handful of 3.1-only constructs the specs
actually use into their 3.0 equivalents. It is deterministic and lossless for our purposes:

  - `openapi: 3.1.x`            -> `openapi: 3.0.3`
  - `info.summary`             -> dropped (3.0 Info has no `summary`)
  - `info.license.identifier`  -> dropped (3.0 License has no SPDX `identifier`)
  - `const: X`                 -> `enum: [X]`
  - `type: [T, "null"]`        -> `type: T` + `nullable: true`
  - `type: [A, B, ...]`        -> `type` removed (an untyped/any schema; a union of concrete
                                  types has no single-`type` 3.0 form)
  - a `{type: "null"}` entry in `oneOf`/`anyOf` -> entry removed + `nullable: true` on the parent

This is the ONE derived step in the Rust regen pipeline; see clients/README.md. Do not hand-edit
the vendored `openapi/*.yaml` — they are this script's output.

Usage: downgrade-spec.py <input-3.1.yaml> <output-3.0.yaml>
"""

import sys

import yaml


def downgrade(node):
    """Recursively rewrite a parsed OpenAPI node in place, returning the rewritten node."""
    if isinstance(node, list):
        return [downgrade(item) for item in node]
    if not isinstance(node, dict):
        return node

    # const -> single-value enum
    if "const" in node:
        node["enum"] = [node.pop("const")]

    # multi-type arrays (3.1) -> single type + nullable, or drop when it's a real union
    t = node.get("type")
    if isinstance(t, list):
        non_null = [x for x in t if x != "null"]
        has_null = "null" in t
        if len(non_null) == 1:
            node["type"] = non_null[0]
        else:
            # a union of >1 concrete types has no single-`type` 3.0 form: leave it untyped (any)
            node.pop("type", None)
        if has_null:
            node["nullable"] = True

    # a `{type: "null"}` member of oneOf/anyOf -> drop it, mark the parent nullable
    for combiner in ("oneOf", "anyOf"):
        if isinstance(node.get(combiner), list):
            kept = [s for s in node[combiner] if s != {"type": "null"}]
            if len(kept) != len(node[combiner]):
                node["nullable"] = True
            node[combiner] = kept

    return {k: downgrade(v) for k, v in node.items()}


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8") as fh:
        spec = yaml.safe_load(fh)

    spec["openapi"] = "3.0.3"
    info = spec.get("info", {})
    info.pop("summary", None)
    if isinstance(info.get("license"), dict):
        info["license"].pop("identifier", None)

    spec = downgrade(spec)

    with open(dst, "w", encoding="utf-8") as fh:
        fh.write("# GENERATED — do not edit. 3.0.3 down-convert of the published 3.1 spec.\n")
        fh.write("# Produced by clients/rust/scripts/downgrade-spec.py (see clients/README.md).\n")
        yaml.safe_dump(spec, fh, sort_keys=False, allow_unicode=True, width=100)
    print(f"wrote {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
