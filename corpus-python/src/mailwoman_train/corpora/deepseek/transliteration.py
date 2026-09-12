"""Rendering US and French addresses into five non-Latin scripts.

Each batch carries the seed rows and the script it is being rendered into. The model answers one
JSONL line per seed, keyed by the seed's index in the batch, and every returned row is re-validated
against the surface-form invariant before it is written — the prompt asks for it, this checks it.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .client import LICENSE_LABEL, deepseek_call, deterministic_id, parse_jsonl_response, validate_components
from .prompts import TRANSLIT_SCRIPTS, TRANSLIT_SYSTEM, build_translit_user_prompt
from .run import RETRY_PREFIX, Sink, load_checkpoint, run_batches


@dataclass
class TranslitBatch:
    batch_id: str
    script_label: str
    script_slug: str
    locale_tag: str
    country_tag: str
    seeds: list[dict[str, Any]]  # seed canonical rows


def load_seeds(paths: list[str], limit: int) -> list[dict[str, Any]]:
    seeds: list[dict[str, Any]] = []
    for path in paths:
        with open(path, encoding="utf-8") as f:
            for ln in f:
                seeds.append(json.loads(ln))
    if limit:
        seeds = seeds[:limit]
    print(f"loaded {len(seeds)} seed addresses", flush=True)
    return seeds


def plan_batches(seeds: list[dict[str, Any]], batch_size: int, scripts: list[str] | None) -> list[TranslitBatch]:
    """Every (script, seed chunk) pair, each with the id the checkpoint stores.

    The id is derived from the chunk's seed ids and the script slug, so the same arguments plan the
    same batches and a restart skips what it already paid for.
    """
    batches: list[TranslitBatch] = []
    for script_label, locale_tag, country_tag, slug in TRANSLIT_SCRIPTS:
        if scripts and slug not in scripts:
            continue
        for i in range(0, len(seeds), batch_size):
            chunk = seeds[i : i + batch_size]
            batch_payload = json.dumps([(s["source_id"]) for s in chunk]) + f"|{slug}"
            batches.append(
                TranslitBatch(
                    batch_id=deterministic_id(f"translit-{slug}", batch_payload),
                    script_label=script_label,
                    script_slug=slug,
                    locale_tag=locale_tag,
                    country_tag=country_tag,
                    seeds=chunk,
                )
            )
    print(f"planned {len(batches)} batches across {len(set(b.script_slug for b in batches))} scripts", flush=True)
    return batches


def _canonical_row(batch: TranslitBatch, seed: dict[str, Any], raw: str, comps: dict[str, str]) -> dict[str, Any]:
    return {
        "raw": raw,
        "components": comps,
        "country": batch.country_tag,
        "locale": batch.locale_tag,
        "source": f"deepseek-translit-{batch.script_slug}",
        "source_id": deterministic_id(
            f"deepseek-translit-{batch.script_slug}",
            f"{seed['source_id']}|{raw}",
        ),
        "license": LICENSE_LABEL,
        "synth": {
            "method": f"deepseek-translit:{batch.script_slug}",
            "base_source_id": seed["source_id"],
        },
        "_seed_raw": seed["raw"],
        "_seed_locale": seed["locale"],
    }


def emit_transliteration(args: argparse.Namespace, api_key: str, sink: Sink, checkpoint_path: Path) -> None:
    """Generate every planned batch that the checkpoint does not already hold."""
    seeds = load_seeds(args.seed_paths, args.limit)
    batches = plan_batches(seeds, args.batch_size, args.scripts)
    done = load_checkpoint(checkpoint_path)
    pending = [b for b in batches if b.batch_id not in done]
    print(f"pending batches: {len(pending)}", flush=True)

    def worker(batch: TranslitBatch) -> tuple[str, Counter[str]]:
        body = {
            "model": args.model,
            "reasoning_effort": "low",
            "messages": [
                {"role": "system", "content": TRANSLIT_SYSTEM},
                {"role": "user", "content": build_translit_user_prompt(batch.script_label, batch.seeds)},
            ],
            "max_tokens": args.max_tokens,
        }
        try:
            resp = deepseek_call(body, api_key)
        except Exception:
            return f"{RETRY_PREFIX}{batch.batch_id}", Counter({"api_error": 1, "expected": len(batch.seeds)})
        content = resp["choices"][0]["message"].get("content") or ""
        finish = resp["choices"][0].get("finish_reason")
        stats: Counter[str] = Counter()
        rows: list[dict[str, Any]] = []
        # Map response row by its declared index, falling back to position.
        for rec_idx, rec in enumerate(parse_jsonl_response(content)):
            try:
                i = int(rec.get("i", rec_idx))
            except (TypeError, ValueError):
                i = rec_idx
            if not (0 <= i < len(batch.seeds)):
                stats["index-out-of-range"] += 1
                continue
            raw = rec.get("raw")
            comps = rec.get("components")
            if not isinstance(raw, str) or not isinstance(comps, dict):
                stats["bad-shape"] += 1
                continue
            ok, reason = validate_components(raw, comps)
            if not ok:
                stats[f"reject:{reason}"] += 1
                continue
            rows.append(_canonical_row(batch, batch.seeds[i], raw, comps))
            stats["ok"] += 1
        stats["expected"] = len(batch.seeds)
        stats["finish:" + str(finish)] += 1
        sink.write_rows(rows)
        sink.write_response(
            {
                "batch_id": batch.batch_id,
                "script_slug": batch.script_slug,
                "seed_source_ids": [s["source_id"] for s in batch.seeds],
                "model": args.model,
                "finish_reason": finish,
                "usage": resp.get("usage"),
                "response_content": content,
            }
        )
        # A truncated completion leaves the batch PENDING so the next run asks for the rest.
        if finish == "length":
            return f"{RETRY_PREFIX}{batch.batch_id}", stats
        return batch.batch_id, stats

    run_batches(
        pending,
        worker,
        done=done,
        checkpoint_path=checkpoint_path,
        concurrency=args.concurrency,
        label="Transliteration",
        sink=sink,
    )
