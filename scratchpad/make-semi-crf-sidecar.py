"""Emit `semi-crf-transitions.json` for a span-head checkpoint (#1143).

The JS span decode CANNOT run without this: `decodeSegmentationsKBest` needs the segment-transition
table and the `segment_types` axis, and the axis ships IN the file precisely so the decoder never
hardcodes it (the PLACETYPE_ORDER dual-maintenance class — a retrained head that reordered types
would otherwise silently mislabel every downstream decode).

Nothing in the Modal pipeline produces it: `export_onnx` auto-detects the span head for the GRAPH
(`has_spans = getattr(model, "use_span_scorer", False)`), but the transition table is DECODE-TIME
data, not graph, and `export_semi_crf_transitions` is called only by tests. v301's sidecar was made
ad-hoc during Phase 2. This script is that step, written down.

Run from repo root with the corpus-python venv (torch 2.12.0, matching the Modal pin):
    corpus-python/.venv/bin/python scratchpad/make-semi-crf-sidecar.py \
        --checkpoint /tmp/v320-ckpt --out <pkg>/semi-crf-transitions.json
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, "corpus-python/src")

import torch  # noqa: E402

from mailwoman_train.model import MailwomanCoarseEncoder  # noqa: E402
from mailwoman_train.package_weights import export_semi_crf_transitions  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True, help="a from_pretrained dir (config.json + weights)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    # The #727 Phase-1 map_location bug: from_pretrained's torch.load defaults to the saved device,
    # and a CUDA-saved checkpoint then fails or silently mis-loads on a CPU box. That bug cost a gate
    # read (token@1 0.348 vs a known 0.573). Same guard the Modal export uses.
    original = torch.load
    torch.load = lambda *a, **kw: original(*a, **{**kw, "map_location": "cpu"})
    model = MailwomanCoarseEncoder.from_pretrained(Path(args.checkpoint))
    torch.load = original

    sidecar = export_semi_crf_transitions(model)
    if sidecar is None:
        raise SystemExit(
            "export_semi_crf_transitions returned None — this checkpoint has NO span head "
            "(use_span_scorer false). Exporting a span-less model as if it had one is how a decode "
            "silently returns nothing."
        )

    Path(args.out).write_text(json.dumps(sidecar) + "\n")
    types = sidecar.get("segment_types", [])
    print(f"wrote {args.out}")
    print(f"  segment_types : {len(types)}  {types[:6]}{'…' if len(types) > 6 else ''}")
    print(f"  max_span      : {sidecar.get('max_span')}")
    print(f"  transitions   : {len(sidecar.get('transitions', []))}x{len(sidecar.get('transitions', [[]])[0])}")


if __name__ == "__main__":
    main()
