"""SentencePiece tokenizer training harness (v0.5.0 Thread A).

A reproducible trainer that produces a versioned tokenizer + model card from a corpus
slice tree. Used to train ``tokenizer-v0.5.0-a0`` on ``corpus-v0.3.0`` and (once Thread B
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
import subprocess  # nosec B404 — spawns external toolchain binaries by design (git for provenance stamps)
import tempfile
import time
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq
import sentencepiece as spm

from .byte_fallback import detect_script, load_fixture_lines, measure_byte_fallback
from .uds import (
    DEFAULT_USER_DEFINED_SYMBOLS,
    _dedupe_keep_order,
    _normalize_uds_for_sp,
    parse_user_defined_symbols_file,
)

logger = logging.getLogger(__name__)


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
    extra_sp_kwargs: dict[str, Any] = field(default_factory=dict)


def iter_train_slices(corpus_dir: Path) -> list[Path]:
    """Resolve the train-split slice paths for ``corpus_dir``.

    Source of truth is ``MANIFEST.json``'s ``slices[]`` (each entry carries an absolute
    ``path``), which supports adapter-addition corpora composed across versions — e.g.
    ``corpus-v0.4.0`` is logically ``corpus-v0.3.0`` base slices + new kryptonite +
    transliteration slices, with the v0.3.0 slices left on disk under their original
    versioned dir rather than re-emitted. Globbing ``<corpus>/train/`` would silently
    miss those cross-version base slices.

    Falls back to a glob over ``<corpus>/train/`` for backward-compat with corpora that
    don't carry a manifest (e.g. ad-hoc test fixtures). Raises ``FileNotFoundError`` if
    neither source yields slices.
    """
    manifest = corpus_dir / "MANIFEST.json"
    if manifest.exists():
        data = json.loads(manifest.read_text())
        slices = [Path(s["path"]) for s in data.get("slices", []) if s.get("split") == "train"]
        if slices:
            return sorted(slices)
    train_dir = corpus_dir / "train"
    slices = sorted(train_dir.glob("*.parquet"))
    if not slices:
        raise FileNotFoundError(f"no parquet slices via MANIFEST.json or {train_dir}")
    return slices


def iter_raws_by_country(corpus_dir: Path, country: str) -> Iterable[str]:
    """Yield ``raw`` strings from every train slice whose row matches ``country``."""
    for slice in iter_train_slices(corpus_dir):
        # Column-projected read keeps RSS low.
        t = pq.read_table(slice, columns=["raw", "country"])
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
    max_slices: int | None = None,
) -> list[str]:
    """Return the top-``top_k`` postcode literals in the train split by frequency.

    Reads each slice's ``labels`` column and pulls out tokens whose BIO label endswith
    ``-postcode``. The unigram trainer will not always keep these whole on its own; adding
    them as UDS guarantees one piece per common postcode literal.

    ``countries``: when given, only count postcodes from rows whose ``country`` matches.
    ``max_slices``: for unit tests; in production leave ``None`` to scan everything.
    """
    counter: Counter[str] = Counter()
    slices = iter_train_slices(corpus_dir)
    if max_slices is not None:
        slices = slices[:max_slices]
    for slice in slices:
        cols = ["tokens", "labels"]
        if countries is not None:
            cols.append("country")
        t = pq.read_table(slice, columns=cols)
        tokens_col = t["tokens"]
        labels_col = t["labels"]
        countries_col = t["country"] if countries is not None else None
        country_filter = set(countries) if countries is not None else None
        for i in range(t.num_rows):
            if (
                countries_col is not None
                and country_filter is not None
                and countries_col[i].as_py() not in country_filter
            ):
                continue
            toks = tokens_col[i].as_py()
            labs = labels_col[i].as_py()
            for tok, lab in zip(toks, labs, strict=True):
                if lab.endswith("-postcode"):
                    # Strip trailing punctuation like ``75008,`` so the literal we add to
                    # the vocab is the bare postcode form. Anything else is unsafe to mine.
                    cleaned = tok.strip(" ,;:.()[]\"'")
                    if cleaned:
                        counter[cleaned] += 1
    return [w for w, _ in counter.most_common(top_k)]


def git_commit(workdir: Path | None = None) -> str | None:
    """Best-effort: return the current HEAD SHA, or None outside a git checkout."""
    try:
        out = subprocess.check_output(  # nosec B603, B607 — fixed argv list, no shell, trusted PATH binary
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


def resolve_user_defined_symbols(cfg: TrainerConfig) -> tuple[list[str], list[str]]:
    """The UDS list this run will train with, and the SentencePiece-normalized copy of it.

    Two lists because two consumers: the model card records what a human asked for, and the
    trainer needs ASCII spaces rewritten to ``▁`` or the literal never matches.
    """
    uds = list(cfg.user_defined_symbols)
    if cfg.mine_postcode_literals > 0:
        uds.extend(
            mine_postcode_literals(
                cfg.corpus_dir,
                top_k=cfg.mine_postcode_literals,
                countries=cfg.countries,
            )
        )
    uds = _dedupe_keep_order(uds)
    # SentencePiece's vocab budget MUST be > UDS count + reserved special-tokens — otherwise
    # the trainer aborts. Cap UDS at min(uds, vocab_size // 4) defensively so a misconfigured
    # caller (e.g. asking for 30K UDS with vocab=48K) doesn't poison the training pass.
    uds_cap = max(0, cfg.vocab_size // 4)
    if len(uds) > uds_cap:
        logger.warning(
            "user_defined_symbols (%d) exceeds vocab_size/4 cap (%d); truncating",
            len(uds),
            uds_cap,
        )
        uds = uds[:uds_cap]
    return uds, [_normalize_uds_for_sp(s) for s in uds]


def build_model_card(
    cfg: TrainerConfig,
    *,
    sp: spm.SentencePieceProcessor,
    sp_flags: dict[str, Any],
    uds: list[str],
    line_count: int,
    elapsed: float,
    model_path: Path,
    vocab_path: Path,
    byte_fb: dict[str, Any] | None,
) -> dict[str, Any]:
    """The card that travels with the model, carrying what would otherwise be unrecoverable."""
    # Drop the absolute ``input`` path from sp_flags before writing so the card stays portable
    # across machines; keep everything else.
    portable_flags = {k: v for k, v in sp_flags.items() if k not in ("input",)}
    portable_flags["user_defined_symbols_count"] = len(uds)
    # Keep a preview of the UDS list; the full list is mostly mined postcodes, redundant in
    # the card. The full list is recoverable from ``tokenizer.vocab`` (UDS shows up as
    # `<surface>\t0` entries adjacent to the special tokens).
    portable_flags["user_defined_symbols_preview"] = uds[:64]
    portable_flags.pop("user_defined_symbols", None)

    return {
        "tokenizer_version": cfg.output_dir.name,
        "corpus_version": cfg.corpus_version,
        "vocab_size": int(sp.get_piece_size()),
        "training_lines": line_count,
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


def train_tokenizer(cfg: TrainerConfig) -> dict[str, Any]:
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
        raise RuntimeError(f"sampled zero lines from corpus_dir={cfg.corpus_dir} countries={cfg.countries}")

    # 2. Resolve UDS: caller's list, deduped + intersected with sane limits.
    uds, uds_for_sp = resolve_user_defined_symbols(cfg)

    # 3. Materialize sampled raws to a temp file (SP wants a path on disk).
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tmp:
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
    byte_fb: dict[str, Any] | None = None
    if cfg.eval_fixture is not None:
        fixture_lines = load_fixture_lines(cfg.eval_fixture)
        byte_fb = measure_byte_fallback(sp, fixture_lines)

    # 5. Persist model card.
    card = build_model_card(
        cfg,
        sp=sp,
        sp_flags=sp_flags,
        uds=uds,
        line_count=len(raws),
        elapsed=elapsed,
        model_path=model_path,
        vocab_path=vocab_path,
        byte_fb=byte_fb,
    )
    card_path = cfg.output_dir / "model_card.json"
    card_path.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")
    # Keep a META.json compatibility shim — older Phase 1 scripts looked for this name.
    (cfg.output_dir / "META.json").write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")

    logger.info(
        "wrote %s (vocab=%d, byte_fb_overall=%s)",
        model_path,
        card["vocab_size"],
        f"{byte_fb['overall']['rate']:.4f}" if byte_fb else "n/a",
    )
    return card


#: The harness's surface. `detect_script`, `measure_byte_fallback`, `load_fixture_lines`,
#: `DEFAULT_USER_DEFINED_SYMBOLS` and `parse_user_defined_symbols_file` are re-exported from
#: `byte_fallback.py` and `uds.py`, because the CLI and the tests reach all of it through here.
__all__ = [
    "DEFAULT_USER_DEFINED_SYMBOLS",
    "TrainerConfig",
    "build_model_card",
    "detect_script",
    "iter_raws_by_country",
    "iter_train_slices",
    "load_fixture_lines",
    "measure_byte_fallback",
    "mine_postcode_literals",
    "parse_user_defined_symbols_file",
    "reservoir_sample",
    "resolve_user_defined_symbols",
    "sample_balanced_raws",
    "train_tokenizer",
]
