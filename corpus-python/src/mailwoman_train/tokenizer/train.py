from __future__ import annotations

import hashlib
import json
import logging
import random
import subprocess  # nosec B404
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


def iter_train_files(corpus_dir: Path) -> list[Path]:
    manifest = corpus_dir / "MANIFEST.json"
    if manifest.exists():
        data = json.loads(manifest.read_text())
        files = [Path(s["path"]) for s in data.get("slices", []) if s.get("split") == "train"]
        if files:
            return sorted(files)
    train_dir = corpus_dir / "train"
    files = sorted(train_dir.glob("*.parquet"))
    if not files:
        raise FileNotFoundError(f"no parquet files via MANIFEST.json or {train_dir}")
    return files


def iter_raws_by_country(corpus_dir: Path, country: str) -> Iterable[str]:
    for path in iter_train_files(corpus_dir):
        t = pq.read_table(path, columns=["raw", "country"])
        raws = t["raw"]
        countries = t["country"]
        for i in range(t.num_rows):
            if countries[i].as_py() == country:
                yield raws[i].as_py()


def reservoir_sample(it: Iterable[str], k: int, rng: random.Random) -> list[str]:
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
    max_files: int | None = None,
) -> list[str]:
    counter: Counter[str] = Counter()
    files = iter_train_files(corpus_dir)
    if max_files is not None:
        files = files[:max_files]
    for path in files:
        cols = ["tokens", "labels"]
        if countries is not None:
            cols.append("country")
        t = pq.read_table(path, columns=cols)
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
                    cleaned = tok.strip(" ,;:.()[]\"'")
                    if cleaned:
                        counter[cleaned] += 1
    return [w for w, _ in counter.most_common(top_k)]


def git_commit(workdir: Path | None = None) -> str | None:
    try:
        out = subprocess.check_output(  # nosec B603, B607
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

    portable_flags = {k: v for k, v in sp_flags.items() if k not in ("input",)}
    portable_flags["user_defined_symbols_count"] = len(uds)

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
    started = time.time()

    cfg.output_dir.mkdir(parents=True, exist_ok=True)
    model_prefix = cfg.output_dir / "tokenizer"

    raws = sample_balanced_raws(
        cfg.corpus_dir,
        countries=cfg.countries,
        per_country=cfg.per_country_sample,
        seed=cfg.seed,
    )
    if not raws:
        raise RuntimeError(f"sampled zero lines from corpus_dir={cfg.corpus_dir} countries={cfg.countries}")

    uds, uds_for_sp = resolve_user_defined_symbols(cfg)

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
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass

    elapsed = time.time() - started
    model_path = model_prefix.with_suffix(".model")
    vocab_path = model_prefix.with_suffix(".vocab")
    if not model_path.exists():
        raise RuntimeError(f"sentencepiece training finished without writing {model_path}")

    sp = spm.SentencePieceProcessor(model_file=str(model_path))
    byte_fb: dict[str, Any] | None = None
    if cfg.eval_fixture is not None:
        fixture_lines = load_fixture_lines(cfg.eval_fixture)
        byte_fb = measure_byte_fallback(sp, fixture_lines)

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

    (cfg.output_dir / "META.json").write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")

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
    "build_model_card",
    "detect_script",
    "iter_raws_by_country",
    "iter_train_files",
    "load_fixture_lines",
    "measure_byte_fallback",
    "mine_postcode_literals",
    "parse_user_defined_symbols_file",
    "reservoir_sample",
    "resolve_user_defined_symbols",
    "sample_balanced_raws",
    "train_tokenizer",
]
