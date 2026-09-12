"""Generating deliberately confusing addresses, one adversarial category at a time.

The generation budget is split across the categories by their weight, with a floor of 50 rows each
so a low-weighted category still produces enough rows to read. Every row is re-validated against
the surface-form invariant before it is written.
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path
from typing import Any

from .client import LICENSE_LABEL, deepseek_call, deterministic_id, parse_jsonl_response, validate_components
from .prompts import KRYPTONITE_CATEGORIES, KRYPTONITE_SYSTEM, build_kryptonite_user_prompt
from .run import Sink, load_checkpoint, run_batches

#: The categories whose addresses are French rather than US; everything else carries the US tags.
FRENCH_CATEGORIES = ("french-saint",)

#: A category's share of the budget never falls below this, however small its weight.
MINIMUM_PER_CATEGORY = 50


def plan_batches(target_count: int, batch_size: int) -> list[dict[str, Any]]:
    """Split the budget across the categories by weight, then cut each share into request batches."""
    weights = [float(c["weight"]) for c in KRYPTONITE_CATEGORIES]
    total_weight = sum(weights)
    per_category = {
        str(c["category"]): max(MINIMUM_PER_CATEGORY, round(target_count * w / total_weight))
        for c, w in zip(KRYPTONITE_CATEGORIES, weights, strict=True)
    }
    print(f"per-category target row counts: {per_category}", flush=True)

    batches: list[dict[str, Any]] = []
    for category in KRYPTONITE_CATEGORIES:
        need = per_category[str(category["category"])]
        count = (need + batch_size - 1) // batch_size
        for index in range(count):
            this_n = min(batch_size, need - index * batch_size)
            batches.append(
                {
                    "batch_id": deterministic_id(f"krypt-{category['category']}", f"{index}|{this_n}"),
                    "category": category,
                    "n": this_n,
                    "bi": index,
                }
            )
    print(f"planned {len(batches)} kryptonite batches", flush=True)
    return batches


def _canonical_row(category: dict[str, Any], index: int, raw: str, comps: dict[str, str], kind: str) -> dict[str, Any]:
    country, locale = ("FR", "fr-FR") if category["category"] in FRENCH_CATEGORIES else ("US", "en-US")
    return {
        "raw": raw,
        "components": comps,
        "country": country,
        "locale": locale,
        "source": "deepseek-kryptonite",
        "source_id": deterministic_id("deepseek-kryptonite", f"{category['category']}|{index}|{raw}"),
        "license": LICENSE_LABEL,
        "synth": {
            "method": f"deepseek-kryptonite:{category['category']}",
            "base_source_id": f"kryptonite-seed:{category['category']}",
        },
        "_kryptonite_kind": kind,
    }


def emit_kryptonite(args: argparse.Namespace, api_key: str, sink: Sink, checkpoint_path: Path) -> None:
    """Generate every planned batch that the checkpoint does not already hold."""
    batches = plan_batches(args.target_count, args.batch_size)
    done = load_checkpoint(checkpoint_path)
    pending = [b for b in batches if b["batch_id"] not in done]
    print(f"pending batches: {len(pending)}", flush=True)

    def worker(batch: dict[str, Any]) -> tuple[str, Counter[str]]:
        category = batch["category"]
        body = {
            "model": args.model,
            "reasoning_effort": "low",
            "messages": [
                {"role": "system", "content": KRYPTONITE_SYSTEM},
                {"role": "user", "content": build_kryptonite_user_prompt(category, batch["n"])},
            ],
            "max_tokens": args.max_tokens,
        }
        try:
            resp = deepseek_call(body, api_key)
        except Exception:
            return batch["batch_id"], Counter({"api_error": 1, "expected": batch["n"]})
        content = resp["choices"][0]["message"].get("content") or ""
        finish = resp["choices"][0].get("finish_reason")
        stats: Counter[str] = Counter()
        rows: list[dict[str, Any]] = []
        for rec_idx, rec in enumerate(parse_jsonl_response(content)):
            raw = rec.get("raw")
            comps = rec.get("components")
            kind = rec.get("kind") or category["category"]
            if not isinstance(raw, str) or not isinstance(comps, dict):
                stats["bad-shape"] += 1
                continue
            ok, reason = validate_components(raw, comps)
            if not ok:
                stats[f"reject:{reason}"] += 1
                continue
            rows.append(_canonical_row(category, rec_idx, raw, comps, kind))
            stats["ok"] += 1
        stats["expected"] = batch["n"]
        stats["finish:" + str(finish)] += 1
        sink.write_rows(rows)
        sink.write_response(
            {
                "batch_id": batch["batch_id"],
                "category": category["category"],
                "n_requested": batch["n"],
                "model": args.model,
                "finish_reason": finish,
                "usage": resp.get("usage"),
                "response_content": content,
            }
        )
        return batch["batch_id"], stats

    run_batches(
        pending,
        worker,
        done=done,
        checkpoint_path=checkpoint_path,
        concurrency=args.concurrency,
        label="Kryptonite",
        sink=sink,
    )
