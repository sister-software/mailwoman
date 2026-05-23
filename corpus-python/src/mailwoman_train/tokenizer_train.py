"""SentencePiece tokenizer training harness (v0.5.0 Thread A).

A reproducible trainer that produces a versioned tokenizer + model card from a corpus
shard tree. Used to train ``tokenizer-v0.5.0-a0`` on ``corpus-v0.3.0`` and (once Thread B
lands) ``tokenizer-v0.5.0-a1`` on ``corpus-v0.4.0`` via the same code path.

The runtime wrapper lives in ``mailwoman_train.tokenizer`` — that's the SP encoder + label
realigner the Phase 2 train loop consumes. This module is *only* about producing the SP
model file from a corpus version. The two are kept separate so the heavy parquet/sampling
imports don't load when the train loop just wants to encode.

Why a new module (not extending ``scripts/train_tokenizer.py``)?

- The legacy script is stdin-or-file driven; the harness contract is "give me a corpus
  version + vocab budget, do the sampling and training and measurement end-to-end."
- The harness writes a richer ``model_card.json`` (sentencepiece flags, UDS preview,
  byte-fallback rate per script) the legacy ``META.json`` doesn't carry.
- A0 / A1 retrain is a single re-invocation: same harness, new ``--corpus``.

Default sampling strategy: per-country reservoir over the train split, taking ``raw``
strings only (whitespace tokens / BIO labels are irrelevant to SP training). Countries
default to ``US`` + ``FR`` to match corpus-v0.3.0's mass; pass ``--countries`` to widen
once Thread B's adversarial transliteration corpus is in the mix.
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
import re
import shutil
import subprocess
import tempfile
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

import pyarrow.parquet as pq
import sentencepiece as spm  # type: ignore[import-not-found]

logger = logging.getLogger(__name__)

# Byte-fallback pieces in a SentencePiece model are surface-form ``<0xNN>`` (one literal
# token per byte). Matching the surface form is more robust than matching piece id ranges:
# the id range depends on where SP placed the byte block in the unigram vocab.
_BYTE_FALLBACK_RE = re.compile(r"^<0x[0-9A-Fa-f]{2}>$")

# Default user-defined symbols ("must keep whole"). SentencePiece UDS are literal strings
# that bypass unigram inference and are always emitted as a single piece. We use them for
# anchor patterns that should never fragment across sub-pieces:
#
# - **Country abbreviations** the corpus mentions but the unigram model might split.
# - **US state codes** (50 + DC) — short two-letter chunks adjacent to postcodes; without
#   UDS the unigram tokenizer can fragment ``NY 10001`` into ``N`` + ``Y`` + `` 10001``
#   under some merges. Keeping state codes atomic preserves the region→postcode adjacency
#   the classifier relies on.
# - **Common postal markers** (PO Box, Cedex, BP) — fixed surface forms; cheaper to put in
#   the vocab once than to learn them from frequency.
# - **JP postcode hyphen anchor** (``-``) we don't include here because ``-`` already
#   tokenizes as a single piece; the JP 100-0005 *whole-postcode* coverage comes from
#   corpus-mined postcode literals (see ``mine_postcode_literals``).
#
# Callers can extend or replace this set via ``--user-defined-symbols-file`` (one literal
# per line, blank lines + ``#``-comments ignored).
DEFAULT_USER_DEFINED_SYMBOLS: tuple[str, ...] = (
    # US states
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC", "PR", "VI", "GU", "AS", "MP",
    # Country abbreviations / common names
    "USA", "US", "U.S.", "U.S.A.", "FR", "FRA", "France",
    "JP", "JPN", "Japan", "GB", "UK", "U.K.",
    "DE", "DEU", "Germany", "IT", "ITA", "Italy",
    "ES", "ESP", "Spain", "NL", "NLD", "Netherlands",
    "CA", "CAN", "Canada", "AU", "AUS", "Australia",
    "CH", "CHE", "Switzerland", "BE", "BEL", "Belgium",
    "AT", "AUT", "Austria", "SE", "SWE", "Sweden",
    "RU", "RUS",
    # Postal-form anchors
    "PO Box", "P.O. Box", "P.O.Box", "POB",
    "Apt", "Apt.", "Suite", "Ste",
    "Cedex", "CEDEX",
    "BP",
)


@dataclass
class TrainerConfig:
    """Inputs to ``train_tokenizer``. Keep fields flat — they round-trip into the model card."""

    corpus_dir: Path
    output_dir: Path
    corpus_version: str
    vocab_size: int = 48000
    character_coverage: float = 0.9999
    model_type: str = "unigram"
    byte_fallback: bool = True
    split_digits: bool = False
    allow_whitespace_only_pieces: bool = False
    per_country_sample: int = 500_000
    countries: tuple[str, ...] = ("US", "FR")
    mine_postcode_literals: int = 0
    user_defined_symbols: tuple[str, ...] = ()
    eval_fixture: Path | None = None
    seed: int = 42
    extra_sp_kwargs: dict = field(default_factory=dict)


def iter_raws_by_country(corpus_dir: Path, country: str) -> Iterable[str]:
    """Yield ``raw`` strings from every train shard whose row matches ``country``."""
    train_dir = corpus_dir / "train"
    shards = sorted(train_dir.glob("*.parquet"))
    if not shards:
        raise FileNotFoundError(f"no parquet shards under {train_dir}")
    for shard in shards:
        # Column-projected read keeps RSS low.
        t = pq.read_table(shard, columns=["raw", "country"])
        raws = t["raw"]
        countries = t["country"]
        for i in range(t.num_rows):
            if countries[i].as_py() == country:
                yield raws[i].as_py()


def reservoir_sample(it: Iterable[str], k: int, rng: random.Random) -> list[str]:
    """Algorithm-R reservoir sampler. Single pass, memory ≤ ``k``."""
    out: list[str] = []
    for i, x in enumerate(it):
        if i < k:
            out.append(x)
        else:
            j = rng.randint(0, i)
            if j < k:
                out[j] = x
    return out


def sample_balanced_raws(
    corpus_dir: Path,
    *,
    countries: Sequence[str],
    per_country: int,
    seed: int,
) -> list[str]:
    """Per-country reservoir sample, concatenated + shuffled."""
    rng = random.Random(seed)
    out: list[str] = []
    for cc in countries:
        picked = reservoir_sample(iter_raws_by_country(corpus_dir, cc), per_country, rng)
        logger.info("sampled %d lines for country=%s", len(picked), cc)
        out.extend(picked)
    rng.shuffle(out)
    return out


def mine_postcode_literals(
    corpus_dir: Path,
    *,
    top_k: int,
    countries: Sequence[str] | None = None,
    max_shards: int | None = None,
) -> list[str]:
    """Return the top-``top_k`` postcode literals in the train split by frequency.

    Reads each shard's ``labels`` column and pulls out tokens whose BIO label endswith
    ``-postcode``. The unigram trainer will not always keep these whole on its own; adding
    them as UDS guarantees one piece per common postcode literal.

    ``countries``: when given, only count postcodes from rows whose ``country`` matches.
    ``max_shards``: for unit tests; in production leave ``None`` to scan everything.
    """
    counter: Counter[str] = Counter()
    train_dir = corpus_dir / "train"
    shards = sorted(train_dir.glob("*.parquet"))
    if max_shards is not None:
        shards = shards[:max_shards]
    if not shards:
        raise FileNotFoundError(f"no parquet shards under {train_dir}")
    for shard in shards:
        cols = ["tokens", "labels"]
        if countries is not None:
            cols.append("country")
        t = pq.read_table(shard, columns=cols)
        tokens_col = t["tokens"]
        labels_col = t["labels"]
        countries_col = t["country"] if countries is not None else None
        country_filter = set(countries) if countries is not None else None
        for i in range(t.num_rows):
            if country_filter is not None and countries_col[i].as_py() not in country_filter:
                continue
            toks = tokens_col[i].as_py()
            labs = labels_col[i].as_py()
            for tok, lab in zip(toks, labs):
                if lab.endswith("-postcode"):
                    # Strip trailing punctuation like ``75008,`` so the literal we add to
                    # the vocab is the bare postcode form. Anything else is unsafe to mine.
                    cleaned = tok.strip(" ,;:.()[]\"'")
                    if cleaned:
                        counter[cleaned] += 1
    return [w for w, _ in counter.most_common(top_k)]


def detect_script(text: str) -> str:
    """Return a coarse script tag for a string: ``latin``, ``cjk``, ``cyrillic``, ``armenian``,
    ``arabic``, ``greek``, ``hebrew``, ``devanagari``, ``thai``, ``mixed``, or ``other``.

    Used to bucket the byte-fallback eval into per-script rates so the model card surfaces
    *where* the tokenizer hits byte fallback, not just the overall headline number.
    """
    blocks: Counter[str] = Counter()
    for ch in text:
        if ch.isspace() or unicodedata.category(ch).startswith(("N", "P", "Z", "S")):
            continue
        name = unicodedata.name(ch, "")
        if not name:
            blocks["other"] += 1
            continue
        if name.startswith(("LATIN", "FULLWIDTH LATIN")):
            blocks["latin"] += 1
        elif name.startswith(("CJK", "HIRAGANA", "KATAKANA", "HANGUL")):
            blocks["cjk"] += 1
        elif name.startswith("CYRILLIC"):
            blocks["cyrillic"] += 1
        elif name.startswith("ARMENIAN"):
            blocks["armenian"] += 1
        elif name.startswith("ARABIC"):
            blocks["arabic"] += 1
        elif name.startswith("GREEK"):
            blocks["greek"] += 1
        elif name.startswith("HEBREW"):
            blocks["hebrew"] += 1
        elif name.startswith("DEVANAGARI"):
            blocks["devanagari"] += 1
        elif name.startswith("THAI"):
            blocks["thai"] += 1
        else:
            blocks["other"] += 1
    if not blocks:
        return "other"
    if len(blocks) == 1:
        return next(iter(blocks))
    # If 90%+ of letter chars are in one block, call it that block (latin punctuation around
    # a CJK address shouldn't make it ``mixed``). Otherwise call it ``mixed``.
    total = sum(blocks.values())
    top, n = blocks.most_common(1)[0]
    return top if n / total >= 0.9 else "mixed"


def measure_byte_fallback(
    sp: spm.SentencePieceProcessor, lines: Iterable[str]
) -> dict:
    """Encode each line and tally byte-fallback piece rate, overall + per script.

    Returns a dict shaped::

        {
          "overall": {"lines": n, "pieces": p, "byte_fallback_pieces": b, "rate": b/p},
          "per_script": {
              "latin":   {"lines": ..., "pieces": ..., "byte_fallback_pieces": ..., "rate": ...},
              "cjk":     {...},
              ...
          }
        }

    The "rate" denominator is piece count, not line count — a byte-fallback piece is a
    *piece*, not a *line*, so the rate that matters for downstream model wastage is the
    fraction of pieces that landed on the byte block.
    """
    overall = {"lines": 0, "pieces": 0, "byte_fallback_pieces": 0}
    per_script: dict[str, dict[str, int]] = {}

    for line in lines:
        line = line.strip()
        if not line:
            continue
        script = detect_script(line)
        bucket = per_script.setdefault(
            script, {"lines": 0, "pieces": 0, "byte_fallback_pieces": 0}
        )
        pieces = sp.encode_as_pieces(line)
        npieces = len(pieces)
        nfb = sum(1 for p in pieces if _BYTE_FALLBACK_RE.match(p))

        overall["lines"] += 1
        overall["pieces"] += npieces
        overall["byte_fallback_pieces"] += nfb
        bucket["lines"] += 1
        bucket["pieces"] += npieces
        bucket["byte_fallback_pieces"] += nfb

    def _attach_rate(d: dict[str, int]) -> dict[str, float | int]:
        rate = d["byte_fallback_pieces"] / d["pieces"] if d["pieces"] > 0 else 0.0
        return {**d, "rate": rate}

    return {
        "overall": _attach_rate(overall),
        "per_script": {k: _attach_rate(v) for k, v in per_script.items()},
    }


def load_fixture_lines(path: Path) -> list[str]:
    """Load raws from a JSONL eval fixture, falling back to plain-text if not JSON."""
    lines: list[str] = []
    with path.open("r", encoding="utf-8") as fh:
        for raw_line in fh:
            raw_line = raw_line.rstrip("\n")
            if not raw_line:
                continue
            if raw_line.lstrip().startswith("{"):
                obj = json.loads(raw_line)
                v = obj.get("raw") or obj.get("text") or obj.get("input")
                if v:
                    lines.append(str(v))
            else:
                lines.append(raw_line)
    return lines


def git_commit(workdir: Path | None = None) -> str | None:
    """Best-effort: return the current HEAD SHA, or None outside a git checkout."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=workdir or Path(__file__).parent,
            stderr=subprocess.DEVNULL,
        )
        return out.decode("utf-8").strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_user_defined_symbols_file(path: Path) -> list[str]:
    """One literal per line; blank lines + ``#``-comments ignored. Whitespace stripped only
    at line ends (a UDS may itself contain spaces like ``PO Box``)."""
    out: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.rstrip()
        if not s or s.lstrip().startswith("#"):
            continue
        out.append(s)
    return out


# U+2581 LOWER ONE EIGHTH BLOCK is SentencePiece's whitespace placeholder. UDS literals
# that contain ASCII spaces must use this codepoint instead — SP normalizes all whitespace
# to ▁ before matching, so a UDS like ``"PO Box"`` would never fire (the encoder sees
# ``"PO▁Box"`` internally but the UDS in the vocab is still ``"PO Box"``). We substitute
# transparently so callers can write natural strings.
_SP_WHITESPACE = "▁"


def _normalize_uds_for_sp(s: str) -> str:
    """Convert ASCII spaces to SentencePiece's ``▁`` whitespace placeholder."""
    return s.replace(" ", _SP_WHITESPACE)


def _dedupe_keep_order(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in items:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def train_tokenizer(cfg: TrainerConfig) -> dict:
    """End-to-end SentencePiece training + byte-fallback measurement.

    Steps:

    1. Sample per-country raws into a temp text file.
    2. (Optional) Mine top-N postcode literals from the corpus and union with the supplied
       UDS list.
    3. Invoke ``spm.SentencePieceTrainer.train`` with the assembled flags.
    4. (Optional) Encode the eval fixture and compute overall + per-script byte-fallback.
    5. Persist ``tokenizer.model``, ``tokenizer.vocab``, ``model_card.json``.

    Returns the model card dict.
    """
    started = time.time()

    cfg.output_dir.mkdir(parents=True, exist_ok=True)
    model_prefix = cfg.output_dir / "tokenizer"

    # 1. Sample.
    raws = sample_balanced_raws(
        cfg.corpus_dir,
        countries=cfg.countries,
        per_country=cfg.per_country_sample,
        seed=cfg.seed,
    )
    if not raws:
        raise RuntimeError(
            f"sampled zero lines from corpus_dir={cfg.corpus_dir} countries={cfg.countries}"
        )

    # 2. Resolve UDS: caller's list, deduped + intersected with sane limits.
    uds = list(cfg.user_defined_symbols)
    if cfg.mine_postcode_literals > 0:
        mined = mine_postcode_literals(
            cfg.corpus_dir,
            top_k=cfg.mine_postcode_literals,
            countries=cfg.countries,
        )
        uds.extend(mined)
    uds = _dedupe_keep_order(uds)
    # SentencePiece's vocab budget MUST be > UDS count + reserved special-tokens — otherwise
    # the trainer aborts. Cap UDS at min(uds, vocab_size // 4) defensively so a misconfigured
    # caller (e.g. asking for 30K UDS with vocab=48K) doesn't poison the training pass.
    uds_cap = max(0, cfg.vocab_size // 4)
    if len(uds) > uds_cap:
        logger.warning(
            "user_defined_symbols (%d) exceeds vocab_size/4 cap (%d); truncating",
            len(uds), uds_cap,
        )
        uds = uds[:uds_cap]
    # SP needs ASCII spaces in UDS literals translated to its ``▁`` placeholder so they
    # actually match user input. See ``_normalize_uds_for_sp`` for the rationale.
    uds_for_sp = [_normalize_uds_for_sp(s) for s in uds]

    # 3. Materialize sampled raws to a temp file (SP wants a path on disk).
    with tempfile.NamedTemporaryFile(
        "w", suffix=".txt", delete=False, encoding="utf-8"
    ) as tmp:
        tmp_path = Path(tmp.name)
        for line in raws:
            tmp.write(line.replace("\n", " "))
            tmp.write("\n")

    try:
        sp_flags = {
            "input": str(tmp_path),
            "model_prefix": str(model_prefix),
            "vocab_size": cfg.vocab_size,
            "character_coverage": cfg.character_coverage,
            "model_type": cfg.model_type,
            "byte_fallback": cfg.byte_fallback,
            "split_digits": cfg.split_digits,
            "allow_whitespace_only_pieces": cfg.allow_whitespace_only_pieces,
            "pad_id": 0,
            "unk_id": 1,
            "bos_id": 2,
            "eos_id": 3,
            "user_defined_symbols": uds_for_sp,
            **cfg.extra_sp_kwargs,
        }
        logger.info(
            "training sentencepiece: vocab=%d, type=%s, char_cov=%.4f, byte_fb=%s, lines=%d, uds=%d",
            cfg.vocab_size,
            cfg.model_type,
            cfg.character_coverage,
            cfg.byte_fallback,
            len(raws),
            len(uds),
        )
        spm.SentencePieceTrainer.train(**sp_flags)
    finally:
        # Clean up the sampling temp file regardless of training success.
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass

    elapsed = time.time() - started
    model_path = model_prefix.with_suffix(".model")
    vocab_path = model_prefix.with_suffix(".vocab")
    if not model_path.exists():
        raise RuntimeError(f"sentencepiece training finished without writing {model_path}")

    # 4. Byte-fallback measurement.
    sp = spm.SentencePieceProcessor(model_file=str(model_path))
    byte_fb: dict | None = None
    if cfg.eval_fixture is not None:
        fixture_lines = load_fixture_lines(cfg.eval_fixture)
        byte_fb = measure_byte_fallback(sp, fixture_lines)

    # 5. Persist model card. Drop the absolute ``input`` path from sp_flags before writing
    # so the card stays portable across machines; keep everything else.
    portable_flags = {k: v for k, v in sp_flags.items() if k not in ("input",)}
    portable_flags["user_defined_symbols_count"] = len(uds)
    # Keep a preview of the UDS list; the full list is mostly mined postcodes, redundant in
    # the card. The full list is recoverable from ``tokenizer.vocab`` (UDS shows up as
    # `<surface>\t0` entries adjacent to the special tokens).
    portable_flags["user_defined_symbols_preview"] = uds[:64]
    portable_flags.pop("user_defined_symbols", None)

    card = {
        "tokenizer_version": cfg.output_dir.name,
        "corpus_version": cfg.corpus_version,
        "vocab_size": int(sp.get_piece_size()),
        "training_lines": len(raws),
        "training_duration_seconds": round(elapsed, 3),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "git_commit": git_commit(),
        "model_sha256": sha256_of_file(model_path),
        "model_path": str(model_path),
        "vocab_path": str(vocab_path),
        "sentencepiece_flags": portable_flags,
        "sampling": {
            "countries": list(cfg.countries),
            "per_country": cfg.per_country_sample,
            "seed": cfg.seed,
        },
        "byte_fallback_eval": byte_fb,
    }
    card_path = cfg.output_dir / "model_card.json"
    card_path.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")
    # Keep a META.json compatibility shim — older Phase 1 scripts looked for this name.
    (cfg.output_dir / "META.json").write_text(
        json.dumps(card, indent=2) + "\n", encoding="utf-8"
    )

    logger.info(
        "wrote %s (vocab=%d, byte_fb_overall=%s)",
        model_path,
        card["vocab_size"],
        f"{byte_fb['overall']['rate']:.4f}" if byte_fb else "n/a",
    )
    return card


__all__ = [
    "DEFAULT_USER_DEFINED_SYMBOLS",
    "TrainerConfig",
    "detect_script",
    "iter_raws_by_country",
    "load_fixture_lines",
    "measure_byte_fallback",
    "mine_postcode_literals",
    "parse_user_defined_symbols_file",
    "reservoir_sample",
    "sample_balanced_raws",
    "train_tokenizer",
]
