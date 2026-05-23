"""Post-eval regression diagnostic — bucket FP / FN cases by error pattern.

Given a trained checkpoint + a golden eval set, runs inference and classifies
every false-positive / false-negative case (per chosen tag) into one of:

- ``non_latin``    : raw input contains non-ASCII chars (transliteration adversarials)
- ``case_only``    : pred.lower() == gold.lower() (cosmetic mismatch)
- ``bio_slip``     : pred and gold are substrings of each other (boundary slip)
                     or pred trims-down to gold (leading/trailing punct attached)
- ``empty_pred``   : pred is empty, gold is not (model is silent — FN-only)
- ``num_confused`` : both pred and gold are numeric but different (postcode-specific
                     — typical when model picks house_number where postcode was)
- ``other``        : doesn't fit any of the above

Order-sensitive: first-match wins, so ``non_latin`` over-attributes to its bucket
when raw has any non-ASCII char even if the actual error is a bio_slip etc. Read
the bucket counts as upper-bound for ``non_latin``, lower-bound for the others.

Output: per-tag per-bucket counts (FP and FN), with ``--examples-per-bucket``
random samples per bucket.

# Usage

    python -m mailwoman_train  # no — this isn't a CLI subcommand. Run directly:

    PATH="$HOME/training-venv/bin:$PATH" \\
      ~/training-venv/bin/python corpus-python/scripts/diagnose_regression.py \\
      --config corpus-python/src/mailwoman_train/configs/<config>.yaml \\
      --checkpoint /data/models/checkpoints/<run>/step-XXXXX \\
      --golden-dir data/eval/golden/v0.1.2 \\
      --tags country,postcode \\
      --examples-per-bucket 3

The ``--tags`` arg accepts any comma-separated subset of ACTIVE_TAGS (default:
all of them). The ``--checkpoint`` arg expects a directory containing the
``pytorch_model.bin`` + ``config.json`` written by ``train.py``.

# v0.4.0 reference distributions (source-only step-2200 vs golden v0.1.2)

For calibration when reading future runs' outputs:

| tag      | bucket          | FP %   | FN %   |
| -------- | --------------- | ------ | ------ |
| country  | non_latin       | 74%    | 92%    |
| country  | other           | 24%    | -      |
| country  | empty_pred      | -      | 7%     |
| country  | bio_slip        | 1%     | 1%     |
| country  | case_only       | 0.5%   | 0.5%   |
| postcode | empty_pred      | -      | 65%    |
| postcode | num_confused    | 38%    | 11%    |
| postcode | non_latin       | 32%    | 18%    |
| postcode | bio_slip        | 21%    | 6%     |
| postcode | other           | 9%     | 0.5%   |

The v0.4.0 ship's postcode regression was dominated by FN ``empty_pred`` (789
of 1217 FNs = 65%) — the model is silent on mid-position postcodes (e.g.
``"Paris 75008"``, ``"64 Industrial Park Rd, Alburgh, VT 05440, Alburg Health
Center"``). v0.4.1's source-weight tweak proposal needs to address this, not
just the smaller ``num_confused`` slice.

The country regression decomposes very differently: ``non_latin`` 92% of FN
means most of the headline ``-0.07`` F1 delta is the adversarial transliteration
share, already a v0.3.0 documented failure mode.
"""

from __future__ import annotations

import argparse
import random
import re
import sys
from pathlib import Path

import torch

# Repo layout: this script lives in corpus-python/scripts/. Add corpus-python/src
# to path so the mailwoman_train package imports without an editable-install.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "src"))

from mailwoman_train.config import load_config  # noqa: E402
from mailwoman_train.eval import (  # noqa: E402
    decode_components,
    golden_to_bio_labels,
    load_golden_dir,
)
from mailwoman_train.labels import ACTIVE_TAGS  # noqa: E402
from mailwoman_train.model import MailwomanCoarseEncoder  # noqa: E402
from mailwoman_train.tokenizer import Tokenizer  # noqa: E402


def classify_error(raw: str, gold: str, pred: str, tag: str) -> str:
    """Bucket a single error case. First-match wins. See module docstring."""
    if any(ord(c) > 127 for c in raw):
        return "non_latin"
    if not pred and gold:
        return "empty_pred"
    if pred and gold and pred.lower() == gold.lower() and pred != gold:
        return "case_only"
    if pred and gold and (pred in gold or gold in pred) and pred != gold:
        return "bio_slip"
    if pred and gold:
        stripped = re.sub(r"^[^\w]+|[^\w]+$", "", pred)
        if stripped == gold:
            return "bio_slip"
    if tag == "postcode" and pred and gold:
        if pred.replace("-", "").isdigit() and gold.replace("-", "").isdigit():
            return "num_confused"
    return "other"


def parse_tags(tags_arg: str | None) -> tuple[str, ...]:
    if not tags_arg:
        return tuple(ACTIVE_TAGS)
    out = []
    for t in tags_arg.split(","):
        t = t.strip()
        if not t:
            continue
        if t not in ACTIVE_TAGS:
            raise SystemExit(f"unknown tag: {t!r} (active tags: {ACTIVE_TAGS})")
        out.append(t)
    if not out:
        raise SystemExit("--tags resolved to an empty list")
    return tuple(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", required=True, help="Path to the YAML config used for the run.")
    ap.add_argument("--checkpoint", required=True, help="Path to the checkpoint directory.")
    ap.add_argument(
        "--golden-dir",
        "--golden",
        required=True,
        dest="golden_dir",
        help="Path to the golden eval directory (e.g. data/eval/golden/v0.1.2/).",
    )
    ap.add_argument(
        "--tags",
        default=None,
        help="Comma-separated tags to diagnose (default: all ACTIVE_TAGS).",
    )
    ap.add_argument("--examples-per-bucket", type=int, default=3)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    random.seed(args.seed)
    target_tags = parse_tags(args.tags)

    cfg = load_config(args.config)
    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    model = MailwomanCoarseEncoder.from_pretrained(Path(args.checkpoint))
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device).eval()

    golden = load_golden_dir(Path(args.golden_dir))
    print(f"loaded {len(golden)} golden entries", file=sys.stderr)

    fps: dict[str, list] = {tag: [] for tag in target_tags}
    fns: dict[str, list] = {tag: [] for tag in target_tags}

    with torch.no_grad():
        for entry in golden:
            pieces = tokenizer.encode_with_spans(entry.raw)
            ids, attn, _gold_ids = golden_to_bio_labels(entry, cfg.data.max_length, tokenizer)
            x = torch.tensor([ids], dtype=torch.long, device=device)
            m = torch.tensor([attn], dtype=torch.long, device=device)
            out = model(input_ids=x, attention_mask=m)
            real_len = min(len(pieces), cfg.data.max_length)
            if hasattr(model, "predict") and getattr(model, "crf", None) is not None:
                decoded = model.predict(input_ids=x, attention_mask=m)
                pred_ids = decoded[0][:real_len] if decoded else []
            else:
                pred_ids = out.logits[0].argmax(dim=-1).tolist()[:real_len]
            pieces_trim = pieces[:real_len]
            predicted = decode_components(pieces_trim, pred_ids, entry.raw)
            gold = entry.components

            for tag in target_tags:
                g = (gold.get(tag) or "").strip()
                p = (predicted.get(tag) or "").strip()
                if p and (not g or p != g):
                    fps[tag].append((entry, g, p, classify_error(entry.raw, g, p, tag)))
                if g and (not p or p != g):
                    fns[tag].append((entry, g, p, classify_error(entry.raw, g, p, tag)))

    for tag in target_tags:
        print(f"\n=== TAG: {tag} ===")
        for kind, bucket in (("FALSE POSITIVES", fps[tag]), ("FALSE NEGATIVES", fns[tag])):
            counts: dict[str, int] = {}
            samples_by: dict[str, list] = {}
            for entry, g, p, cat in bucket:
                counts[cat] = counts.get(cat, 0) + 1
                samples_by.setdefault(cat, []).append((entry, g, p))
            total = sum(counts.values())
            print(f"\n{kind} ({total} total)")
            if total == 0:
                continue
            for cat in sorted(counts, key=lambda c: -counts[c]):
                pct = counts[cat] / total * 100
                print(f"  {cat:14s} {counts[cat]:4d} ({pct:.1f}%)")
                sample = random.sample(samples_by[cat], min(args.examples_per_bucket, counts[cat]))
                for entry, g, p in sample:
                    print(f"    - raw  : {entry.raw[:90]}")
                    print(f"      gold : {g!r}")
                    print(f"      pred : {p!r}")


if __name__ == "__main__":
    main()
