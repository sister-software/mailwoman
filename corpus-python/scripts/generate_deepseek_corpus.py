"""
DeepSeek-driven adversarial corpus generation for corpus-v0.4.0 (Thread B of the v0.5.0
fresh-slate plan, PHASE_8 §B).

Two modes:

- ``--mode transliteration``: reads seed JSONL lines of US/FR canonical addresses with
  ``components`` ground truth and asks DeepSeek to render each address in a target
  non-Latin script (Russian Cyrillic, Japanese Kana+Kanji, Simplified Chinese, Korean
  Hangul, Armenian). Each output row carries the transliterated raw + transliterated
  component surface forms (substring-match invariant enforced by the model and
  re-validated locally before write).

- ``--mode kryptonite``: prompt-engineers DeepSeek to produce incongruent-component
  examples (Buffalo Buffalo, NY-NY Steakhouse Houston TX, Saint Petersburg FL, Paris
  Texas, mid-position postcodes, etc.) with annotated correct parses. Seeds come from
  a hand-curated category list embedded in this script.

Outputs canonical JSONL rows compatible with ``corpus/src/types.ts:CanonicalRow``:

    {
      "raw": "...",
      "components": {tag: surface_form, ...},
      "country": "US"|"FR"|...,
      "locale": "en-US"|"fr-FR"|...,
      "source": "deepseek-translit-cyrl"|"deepseek-kryptonite"|...,
      "source_id": "<deterministic id>",
      "license": "Synthetic (DeepSeek-v4-flash output, AGPL-compatible)",
      "synth": {"method": "deepseek-translit:<script>", "base_source_id": "<seed source_id>"}
    }

Raw DeepSeek responses (HTTP payload bodies) are also persisted to a sidecar JSONL for
reproducibility — one line per API call with prompt + completion + usage metadata.

Checkpointing: progress is tracked at the request granularity. If interrupted, restart
with the same arguments and previously-completed batches are skipped (matched by their
deterministic batch_id).
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

API_URL = "https://api.deepseek.com/v1/chat/completions"
DEFAULT_MODEL = "deepseek-v4-flash"
LICENSE_LABEL = "Synthetic (DeepSeek-v4-flash, AGPL-compatible)"

# Five target scripts. Each entry: (script_label_for_prompt, locale_tag, country_tag, slug).
TRANSLIT_SCRIPTS = [
    ("Russian Cyrillic", "ru-RU", "RU", "cyrl"),
    ("Japanese (Katakana + Kanji)", "ja-JP", "JP", "jpan"),
    ("Simplified Chinese (Mandarin)", "zh-CN", "CN", "hans"),
    ("Korean Hangul", "ko-KR", "KR", "hang"),
    ("Armenian", "hy-AM", "AM", "armn"),
]


TRANSLIT_SYSTEM = (
    "TASK: Transliterate US or French postal addresses from English/French Latin script into the "
    "target script. Keep digits, commas, periods, and hyphens verbatim. Transliterate place names "
    "and street-type words (Ave/Avenue/Rue/Boulevard/Bld/Blvd/Rd/St/Place, etc.) using natural "
    "conventions for the target script. The transliteration should look like how a native speaker "
    "of the target language would render the same address (do NOT translate semantically — these "
    "are foreign place names being phonetically rendered into the target script).\n\n"
    "Output JSONL ONLY — one line per input, in order, no markdown fences, no commentary, no "
    "leading or trailing prose. Each line is exactly one JSON object.\n\n"
    "Schema (every field required): "
    '{"i":<batch_index>,"raw":"<full transliterated address>",'
    '"components":{"<tag>":"<transliterated surface form>",...}}'
    "\n\n"
    "Component tags MUST mirror the input components — if the input lists "
    "{house_number, street, locality, region, postcode} you output the same five tags. "
    "Surface-form INVARIANT: every value in components MUST appear as an exact substring of raw. "
    "The model that ingests these rows checks substring equality and discards anything that "
    "doesn't satisfy it."
)


KRYPTONITE_SYSTEM = (
    "TASK: Generate adversarial postal-address parsing test cases. Each case is a real-looking "
    "address string that's deliberately confusing for a naive parser — venues that contain region "
    "or city tokens, places whose names duplicate or shadow famous locations, mid-position "
    "postcodes, repeated-token brand names, etc. The address must still resolve to a real US "
    "place (city/state/postcode must be geographically consistent). For each case provide the "
    "correct component-tag annotation that a human parser would assign.\n\n"
    "Output JSONL ONLY — one line per item, in order, no markdown fences, no commentary, no "
    "leading or trailing prose. Each line is exactly one JSON object.\n\n"
    "Schema: "
    '{"i":<index>,"raw":"<address>","components":{"<tag>":"<surface form>",...},'
    '"kind":"<short adversarial category>"}'
    "\n\n"
    "Allowed component tags: house_number, street, venue, locality, dependent_locality, region, "
    "postcode, country, po_box, unit. Use only the ones that appear in the address.\n\n"
    "Surface-form INVARIANT: every value in components MUST appear as a substring of raw "
    "(exact case-sensitive substring). The downstream consumer rejects rows that violate this.\n\n"
    "Kind labels — short slug identifying the trap: e.g. "
    '"venue-shadow-region" (venue contains region-like tokens), '
    '"locality-shadow-region" (locality is also a region name elsewhere), '
    '"locality-shadow-country" (locality is also a country/famous city), '
    '"repeated-token" (Buffalo Buffalo / Walla Walla / Bora Bora style), '
    '"mid-position-postcode" (postcode appears between locality and country), '
    '"region-shadow-venue" (region token appears in venue brand), '
    '"compass-prefix" (North/South/East/West-prefixed locality colliding with another place), '
    '"saint-shadow" (Saint X / St. X colliding with St. Petersburg etc.), '
    '"abbrev-collision" (state abbrev collides with a venue/street token), '
    '"french-saint" (FR equivalent: Saint-X colliding with another commune).'
)


KRYPTONITE_USER_TEMPLATE = """\
Generate {n} adversarial US postal-address cases in category: {category}.

Category description: {description}

Examples (use these as inspiration; do NOT copy verbatim — vary cities, brands, and street numbers):
{examples}

Constraints:
- Each address must be a plausible mailing address (real US city + matching state + a valid postcode).
- Vary cities, states, brand names, and street numbers across the {n} items.
- Output exactly {n} JSONL lines in order, index 0..{n_minus_1}, schema as in the system prompt.
"""


KRYPTONITE_CATEGORIES = [
    {
        "category": "venue-shadow-region",
        "description": "Address with a venue/brand name whose tokens overlap with region abbreviations or names — the venue contains 'NY', 'TX', 'LA', 'CA', etc., but the actual region in the address is elsewhere.",
        "examples": [
            'NY-NY Steakhouse, 1500 Westheimer Rd, Houston, TX 77006 | venue="NY-NY Steakhouse" street="Westheimer Rd" locality="Houston" region="TX" postcode="77006"',
            'Texas Roadhouse, 4321 Belair Rd, Augusta, GA 30909 | venue="Texas Roadhouse" street="Belair Rd" locality="Augusta" region="GA" postcode="30909"',
            'LA Fitness, 2200 Wisconsin Ave NW, Washington, DC 20007 | venue="LA Fitness" street="Wisconsin Ave NW" locality="Washington" region="DC" postcode="20007"',
        ],
        "weight": 1.0,
    },
    {
        "category": "locality-shadow-country",
        "description": "US locality named after a famous non-US city or country — Paris TX, Athens GA, Moscow ID, Lebanon TN, etc. The full address is unambiguously US, but the locality token shadows a foreign place.",
        "examples": [
            "1010 Lamar Ave, Paris, TX 75460 | house_number=1010 street=Lamar Ave locality=Paris region=TX postcode=75460",
            "275 College Ave, Athens, GA 30601 | house_number=275 street=College Ave locality=Athens region=GA postcode=30601",
            "201 N Main St, Moscow, ID 83843 | house_number=201 street=N Main St locality=Moscow region=ID postcode=83843",
            "405 N Cumberland St, Lebanon, TN 37087 | house_number=405 street=N Cumberland St locality=Lebanon region=TN postcode=37087",
        ],
        "weight": 1.0,
    },
    {
        "category": "saint-shadow",
        "description": "US locality with Saint/St. prefix that shadows a famous European saint-name city (Saint Petersburg FL vs Russia, Saint Louis MO vs France, etc.).",
        "examples": [
            "250 Central Ave, Saint Petersburg, FL 33701 | house_number=250 street=Central Ave locality=Saint Petersburg region=FL postcode=33701",
            "1 Memorial Dr, St. Louis, MO 63102 | house_number=1 street=Memorial Dr locality=St. Louis region=MO postcode=63102",
            "85 Augusta St, St. Augustine, FL 32084 | house_number=85 street=Augusta St locality=St. Augustine region=FL postcode=32084",
        ],
        "weight": 0.8,
    },
    {
        "category": "repeated-token",
        "description": "Addresses where the same word appears as both venue/street component and locality (Buffalo Buffalo, Walla Walla WA, Bora Bora, etc.). Tests whether the parser can disambiguate by position rather than token identity.",
        "examples": [
            "First National Bank of Buffalo, 100 Court St, Buffalo, NY 14202 | venue=First National Bank of Buffalo street=Court St locality=Buffalo region=NY postcode=14202",
            "Walla Walla Community College, 500 Tausick Way, Walla Walla, WA 99362 | venue=Walla Walla Community College street=Tausick Way locality=Walla Walla region=WA postcode=99362",
            "Bismarck State College, 1500 Edwards Ave, Bismarck, ND 58506 | venue=Bismarck State College street=Edwards Ave locality=Bismarck region=ND postcode=58506",
        ],
        "weight": 0.9,
    },
    {
        "category": "mid-position-postcode",
        "description": "Postcode appears between locality and region (or between street and locality), instead of at the end. Mirrors how some European-formatted addresses look when imported into US-style strings.",
        "examples": [
            "5 Avenue Foch 75008 Paris, France | street=Avenue Foch postcode=75008 locality=Paris country=France",
            "12 Rue de Rivoli 75001 Paris | street=Rue de Rivoli postcode=75001 locality=Paris",
            "Hauptstr 5, 10115 Berlin, Germany | street=Hauptstr postcode=10115 locality=Berlin country=Germany",
        ],
        "weight": 1.0,
    },
    {
        "category": "compass-prefix",
        "description": "Locality with a compass prefix (North/South/East/West) where dropping the prefix yields a famous other place. North Hollywood vs Hollywood, West Palm Beach vs Palm Beach, etc.",
        "examples": [
            "12000 Riverside Dr, North Hollywood, CA 91607 | house_number=12000 street=Riverside Dr locality=North Hollywood region=CA postcode=91607",
            "1100 S Flagler Dr, West Palm Beach, FL 33401 | house_number=1100 street=S Flagler Dr locality=West Palm Beach region=FL postcode=33401",
            "10 Park Pl, South Plainfield, NJ 07080 | house_number=10 street=Park Pl locality=South Plainfield region=NJ postcode=07080",
        ],
        "weight": 0.7,
    },
    {
        "category": "abbrev-collision",
        "description": "State abbreviation collides with a regular English token elsewhere in the address (e.g., 'IN' as state and 'IN' as preposition in venue name, 'OR' as state vs conjunction). Test whether the parser uses positional cues rather than just token identity.",
        "examples": [
            "Indianapolis Motor Speedway, 4790 W 16th St, Indianapolis, IN 46222 | venue=Indianapolis Motor Speedway street=W 16th St locality=Indianapolis region=IN postcode=46222",
            "OR-It Hardware, 425 SW 4th Ave, Portland, OR 97204 | venue=OR-It Hardware street=SW 4th Ave locality=Portland region=OR postcode=97204",
            "DC Comics Store, 1700 Broadway, New York, NY 10019 | venue=DC Comics Store street=Broadway locality=New York region=NY postcode=10019",
        ],
        "weight": 0.8,
    },
    {
        "category": "french-saint",
        "description": "French commune with Saint-X prefix shadowing another commune. e.g. Saint-Denis (93) vs Saint-Denis-en-Val (45), Saint-Étienne (42) vs Saint-Étienne-de-Tinée (06).",
        "examples": [
            "5 Avenue Aristide Briand, Saint-Denis, 93200 | house_number=5 street=Avenue Aristide Briand locality=Saint-Denis postcode=93200",
            "12 Rue du 11 Novembre, Saint-Étienne, 42000 | house_number=12 street=Rue du 11 Novembre locality=Saint-Étienne postcode=42000",
            "1 Place Carnot, Saint-Quentin, 02100 | house_number=1 street=Place Carnot locality=Saint-Quentin postcode=02100",
        ],
        "weight": 0.7,
    },
    {
        "category": "region-shadow-venue",
        "description": "Venue name embeds a US state name as a brand token (Hotel California, Carolina Brewery, Georgia Aquarium). The actual region in the address is something else.",
        "examples": [
            "Hotel California, 555 Sutter St, San Francisco, CA 94102 | venue=Hotel California street=Sutter St locality=San Francisco region=CA postcode=94102",
            "Georgia Aquarium, 225 Baker St NW, Atlanta, GA 30313 | venue=Georgia Aquarium street=Baker St NW locality=Atlanta region=GA postcode=30313",
            "Carolina Brewery, 460 W Franklin St, Chapel Hill, NC 27516 | venue=Carolina Brewery street=W Franklin St locality=Chapel Hill region=NC postcode=27516",
        ],
        "weight": 0.7,
    },
    {
        "category": "po-box",
        "description": "PO Box that appears intermixed with street-style tokens — e.g. 'PO Box 123, c/o ACME Corp, 500 Main St, Houston, TX 77001'. Tests whether the parser disambiguates physical street from PO box correctly.",
        "examples": [
            "PO Box 451, Springfield, IL 62701 | po_box=PO Box 451 locality=Springfield region=IL postcode=62701",
            "ACME Corp, PO Box 9000, 500 Main St, Houston, TX 77001 | venue=ACME Corp po_box=PO Box 9000 street=Main St locality=Houston region=TX postcode=77001",
        ],
        "weight": 0.5,
    },
]


def deepseek_call(body: dict[str, Any], api_key: str, max_retries: int = 5) -> dict[str, Any]:
    """POST one chat-completion. Retries 429/5xx with exponential backoff."""
    backoff = 2.0
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                last_exc = e
                time.sleep(backoff)
                backoff *= 1.5
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_exc = e
            time.sleep(backoff)
            backoff *= 1.5
    raise RuntimeError(f"DeepSeek call failed after {max_retries} retries: {last_exc}")


def parse_jsonl_response(content: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ln in (content or "").splitlines():
        ln = ln.strip()
        if not ln:
            continue
        if ln.startswith("```"):
            continue
        if not ln.startswith("{"):
            continue
        try:
            out.append(json.loads(ln))
        except json.JSONDecodeError:
            continue
    return out


def validate_components(raw: str, comps: dict[str, str]) -> tuple[bool, str | None]:
    """Substring-match validation. Returns (ok, reason_if_not_ok)."""
    if not isinstance(comps, dict) or not comps:
        return False, "no-components"
    for tag, val in comps.items():
        if not isinstance(val, str) or not val:
            return False, f"empty-component:{tag}"
        if val not in raw:
            return False, f"not-in-raw:{tag}"
    if not raw or len(raw) > 250:
        return False, "raw-length"
    return True, None


def deterministic_id(prefix: str, payload: str) -> str:
    h = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{h}"


@dataclass
class TranslitBatch:
    batch_id: str
    script_label: str
    script_slug: str
    locale_tag: str
    country_tag: str
    seeds: list[dict[str, Any]]  # seed canonical rows


def build_translit_user_prompt(script_label: str, seeds: list[dict[str, Any]]) -> str:
    lines = [f"Script: {script_label}", "Batch:"]
    for i, s in enumerate(seeds):
        comp_str = ", ".join(f'{k}="{v}"' for k, v in s["components"].items())
        lines.append(f'{i}: raw="{s["raw"]}"; components={{{comp_str}}}')
    return "\n".join(lines)


def emit_transliteration(args: argparse.Namespace) -> None:
    api_key = os.environ["DEEPSEEK_API_KEY"]
    # Load seeds
    seeds: list[dict[str, Any]] = []
    for path in args.seed_paths:
        with open(path, encoding="utf-8") as f:
            for ln in f:
                seeds.append(json.loads(ln))
    if args.limit:
        seeds = seeds[: args.limit]
    print(f"loaded {len(seeds)} seed addresses", flush=True)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    canonical_path = out_dir / "canonical-transliteration.jsonl"
    rawlog_path = out_dir / "raw-deepseek-transliteration.jsonl"
    checkpoint_path = out_dir / ".translit-checkpoint.json"

    # Build batch list across all scripts.
    batches: list[TranslitBatch] = []
    for script_label, locale_tag, country_tag, slug in TRANSLIT_SCRIPTS:
        if args.scripts and slug not in args.scripts:
            continue
        for i in range(0, len(seeds), args.batch_size):
            chunk = seeds[i : i + args.batch_size]
            batch_payload = json.dumps([(s["source_id"]) for s in chunk]) + f"|{slug}"
            bid = deterministic_id(f"translit-{slug}", batch_payload)
            batches.append(
                TranslitBatch(
                    batch_id=bid,
                    script_label=script_label,
                    script_slug=slug,
                    locale_tag=locale_tag,
                    country_tag=country_tag,
                    seeds=chunk,
                )
            )

    print(f"planned {len(batches)} batches across {len(set(b.script_slug for b in batches))} scripts", flush=True)

    # Load checkpoint.
    done: set[str] = set()
    if checkpoint_path.exists():
        done = set(json.loads(checkpoint_path.read_text()).get("done", []))
        print(f"resuming: {len(done)} batches already complete", flush=True)

    pending = [b for b in batches if b.batch_id not in done]
    print(f"pending batches: {len(pending)}", flush=True)

    canon_lock = __import__("threading").Lock()
    raw_lock = __import__("threading").Lock()
    ck_lock = __import__("threading").Lock()
    canonical_f = open(canonical_path, "a", encoding="utf-8")
    rawlog_f = open(rawlog_path, "a", encoding="utf-8")

    stats = Counter()
    t0 = time.time()
    processed = 0

    def worker(batch: TranslitBatch) -> tuple[str, dict[str, int]]:
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
        except Exception as e:
            return batch.batch_id, {"api_error": 1, "expected": len(batch.seeds)}
        content = resp["choices"][0]["message"].get("content") or ""
        finish = resp["choices"][0].get("finish_reason")
        rows = parse_jsonl_response(content)
        bstats = Counter()
        out_rows = []
        # Map response row by index, fall back to position.
        for rec_idx, rec in enumerate(rows):
            try:
                i = int(rec.get("i", rec_idx))
            except (TypeError, ValueError):
                i = rec_idx
            if not (0 <= i < len(batch.seeds)):
                bstats["index-out-of-range"] += 1
                continue
            seed = batch.seeds[i]
            raw = rec.get("raw")
            comps = rec.get("components")
            if not isinstance(raw, str) or not isinstance(comps, dict):
                bstats["bad-shape"] += 1
                continue
            ok, reason = validate_components(raw, comps)
            if not ok:
                bstats[f"reject:{reason}"] += 1
                continue
            canon = {
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
            out_rows.append(canon)
            bstats["ok"] += 1
        bstats["expected"] = len(batch.seeds)
        bstats["finish:" + str(finish)] += 1
        # Persist canonical rows.
        with canon_lock:
            for c in out_rows:
                canonical_f.write(json.dumps(c, ensure_ascii=False) + "\n")
            canonical_f.flush()
        # Persist raw response (without _seed_ stuff) for reproducibility.
        with raw_lock:
            rawlog_f.write(json.dumps({
                "batch_id": batch.batch_id,
                "script_slug": batch.script_slug,
                "seed_source_ids": [s["source_id"] for s in batch.seeds],
                "model": args.model,
                "finish_reason": finish,
                "usage": resp.get("usage"),
                "response_content": content,
            }, ensure_ascii=False) + "\n")
            rawlog_f.flush()
        return batch.batch_id, bstats

    def commit_done(bid: str) -> None:
        with ck_lock:
            done.add(bid)
            if len(done) % 25 == 0:
                checkpoint_path.write_text(json.dumps({"done": sorted(done)}))

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futs = {ex.submit(worker, b): b for b in pending}
        for fut in concurrent.futures.as_completed(futs):
            bid, bstats = fut.result()
            for k, v in bstats.items():
                stats[k] += v
            commit_done(bid)
            processed += 1
            if processed % 5 == 0 or processed == len(pending):
                elapsed = time.time() - t0
                rps = stats["ok"] / max(elapsed, 1)
                print(
                    f"  [{processed}/{len(pending)}] ok={stats['ok']} "
                    f"reject={sum(v for k, v in stats.items() if k.startswith('reject') or k in ('api_error','bad-shape','index-out-of-range'))} "
                    f"  elapsed={elapsed:.0f}s  rps={rps:.1f}",
                    flush=True,
                )

    # Final checkpoint flush.
    checkpoint_path.write_text(json.dumps({"done": sorted(done)}))
    canonical_f.close()
    rawlog_f.close()
    print(f"\nTransliteration generation complete.")
    print(f"  ok rows: {stats['ok']}")
    print(f"  rejects: {dict((k, v) for k, v in stats.items() if k.startswith('reject') or k in ('api_error','bad-shape','index-out-of-range'))}")
    print(f"  output: {canonical_path}")


def build_kryptonite_user_prompt(category: dict[str, Any], n: int) -> str:
    examples = "\n".join(f"- {ex}" for ex in category["examples"])
    return KRYPTONITE_USER_TEMPLATE.format(
        category=category["category"],
        description=category["description"],
        examples=examples,
        n=n,
        n_minus_1=n - 1,
    )


def emit_kryptonite(args: argparse.Namespace) -> None:
    api_key = os.environ["DEEPSEEK_API_KEY"]
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    canonical_path = out_dir / "canonical-kryptonite.jsonl"
    rawlog_path = out_dir / "raw-deepseek-kryptonite.jsonl"
    checkpoint_path = out_dir / ".kryptonite-checkpoint.json"

    # Total to generate.
    total = args.target_count
    # Allocate per category by weight.
    weights = [c["weight"] for c in KRYPTONITE_CATEGORIES]
    wsum = sum(weights)
    per_cat = {c["category"]: max(50, round(total * w / wsum)) for c, w in zip(KRYPTONITE_CATEGORIES, weights)}
    print(f"per-category target row counts: {per_cat}", flush=True)

    # Compose batches.
    batches = []
    for cat in KRYPTONITE_CATEGORIES:
        need = per_cat[cat["category"]]
        nb = (need + args.batch_size - 1) // args.batch_size
        for bi in range(nb):
            this_n = min(args.batch_size, need - bi * args.batch_size)
            bid = deterministic_id(f"krypt-{cat['category']}", f"{bi}|{this_n}")
            batches.append({"batch_id": bid, "category": cat, "n": this_n, "bi": bi})

    print(f"planned {len(batches)} kryptonite batches", flush=True)
    done = set()
    if checkpoint_path.exists():
        done = set(json.loads(checkpoint_path.read_text()).get("done", []))
        print(f"resuming: {len(done)} batches already complete", flush=True)
    pending = [b for b in batches if b["batch_id"] not in done]
    print(f"pending batches: {len(pending)}", flush=True)

    canon_lock = __import__("threading").Lock()
    raw_lock = __import__("threading").Lock()
    ck_lock = __import__("threading").Lock()
    canonical_f = open(canonical_path, "a", encoding="utf-8")
    rawlog_f = open(rawlog_path, "a", encoding="utf-8")
    stats = Counter()
    t0 = time.time()
    processed = 0

    def worker(batch: dict[str, Any]) -> tuple[str, dict[str, int]]:
        cat = batch["category"]
        body = {
            "model": args.model,
            "reasoning_effort": "low",
            "messages": [
                {"role": "system", "content": KRYPTONITE_SYSTEM},
                {"role": "user", "content": build_kryptonite_user_prompt(cat, batch["n"])},
            ],
            "max_tokens": args.max_tokens,
        }
        try:
            resp = deepseek_call(body, api_key)
        except Exception as e:
            return batch["batch_id"], {"api_error": 1, "expected": batch["n"]}
        content = resp["choices"][0]["message"].get("content") or ""
        finish = resp["choices"][0].get("finish_reason")
        rows = parse_jsonl_response(content)
        bstats = Counter()
        out_rows = []
        for rec_idx, rec in enumerate(rows):
            raw = rec.get("raw")
            comps = rec.get("components")
            kind = rec.get("kind") or cat["category"]
            if not isinstance(raw, str) or not isinstance(comps, dict):
                bstats["bad-shape"] += 1
                continue
            ok, reason = validate_components(raw, comps)
            if not ok:
                bstats[f"reject:{reason}"] += 1
                continue
            # Skip Buffalo-Buffalo / "ACME Corp, PO Box 9000, 500 Main St" — keep generic
            # provenance.
            country, locale = "US", "en-US"
            if cat["category"] in ("french-saint",):
                country, locale = "FR", "fr-FR"
            canon = {
                "raw": raw,
                "components": comps,
                "country": country,
                "locale": locale,
                "source": "deepseek-kryptonite",
                "source_id": deterministic_id("deepseek-kryptonite", f"{cat['category']}|{rec_idx}|{raw}"),
                "license": LICENSE_LABEL,
                "synth": {
                    "method": f"deepseek-kryptonite:{cat['category']}",
                    "base_source_id": f"kryptonite-seed:{cat['category']}",
                },
                "_kryptonite_kind": kind,
            }
            out_rows.append(canon)
            bstats["ok"] += 1
        bstats["expected"] = batch["n"]
        bstats["finish:" + str(finish)] += 1
        with canon_lock:
            for c in out_rows:
                canonical_f.write(json.dumps(c, ensure_ascii=False) + "\n")
            canonical_f.flush()
        with raw_lock:
            rawlog_f.write(json.dumps({
                "batch_id": batch["batch_id"],
                "category": cat["category"],
                "n_requested": batch["n"],
                "model": args.model,
                "finish_reason": finish,
                "usage": resp.get("usage"),
                "response_content": content,
            }, ensure_ascii=False) + "\n")
            rawlog_f.flush()
        return batch["batch_id"], bstats

    def commit_done(bid: str) -> None:
        with ck_lock:
            done.add(bid)
            if len(done) % 25 == 0:
                checkpoint_path.write_text(json.dumps({"done": sorted(done)}))

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futs = {ex.submit(worker, b): b for b in pending}
        for fut in concurrent.futures.as_completed(futs):
            bid, bstats = fut.result()
            for k, v in bstats.items():
                stats[k] += v
            commit_done(bid)
            processed += 1
            if processed % 5 == 0 or processed == len(pending):
                elapsed = time.time() - t0
                rps = stats["ok"] / max(elapsed, 1)
                print(
                    f"  [{processed}/{len(pending)}] ok={stats['ok']} "
                    f"reject={sum(v for k, v in stats.items() if k.startswith('reject') or k in ('api_error','bad-shape'))} "
                    f"elapsed={elapsed:.0f}s rps={rps:.1f}",
                    flush=True,
                )

    checkpoint_path.write_text(json.dumps({"done": sorted(done)}))
    canonical_f.close()
    rawlog_f.close()
    print(f"\nKryptonite generation complete.")
    print(f"  ok rows: {stats['ok']}")
    print(f"  rejects: {dict((k, v) for k, v in stats.items() if k.startswith('reject') or k in ('api_error','bad-shape'))}")
    print(f"  output: {canonical_path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["transliteration", "kryptonite"], required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--batch-size", type=int, default=50)
    ap.add_argument("--concurrency", type=int, default=15)
    ap.add_argument("--max-tokens", type=int, default=20000)
    ap.add_argument("--seed-paths", nargs="*", default=[])
    ap.add_argument("--scripts", nargs="*", default=None, help="subset of script slugs (cyrl jpan hans hang armn)")
    ap.add_argument("--target-count", type=int, default=8000, help="kryptonite total target")
    ap.add_argument("--limit", type=int, default=0, help="cap seeds (transliteration)")
    args = ap.parse_args()

    if args.mode == "transliteration":
        if not args.seed_paths:
            print("--seed-paths required for transliteration mode", file=sys.stderr)
            sys.exit(2)
        emit_transliteration(args)
    elif args.mode == "kryptonite":
        emit_kryptonite(args)


if __name__ == "__main__":
    main()
