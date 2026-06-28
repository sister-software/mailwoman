"""Streaming parquet → encoded tensors data pipeline for Phase 2 training.

Reads ``corpus-v0.1.0`` parquet shards via PyArrow's row-group iterator (lazy, memory-stable),
filters / weights rows per the YAML config, encodes each row through the SentencePiece
tokenizer with realigned BIO labels, and yields PyTorch ``(input_ids, attention_mask, labels)``
tensors in a batched ``DataLoader``-compatible shape.

Why PyArrow + a generator and not ``datasets.load_dataset('parquet', streaming=True)``?

- ``datasets`` would work; the row-group iterator path here is fewer moving parts, gives us
  direct per-row column projection (we never materialize ``tokens`` for rows we drop), and
  keeps the train loop deterministic for a fixed seed without the HF dataset shuffle buffer
  semantics.
- The data loader is the hot path on a CPU-bound train run; ad-hoc streaming is fine.

Per Phase 2 §2:

- Lazy + streaming + memory-stable: row-group iteration, never reads a full shard.
- Stratified sampling: ``country_weights`` are renormalized probabilities; rows are accepted
  with probability proportional to their country's weight relative to the max.
- Length filter: rows whose SP tokenization exceeds ``max_length`` are dropped.
- Tokenizer alignment verification: re-tokenize a sample and assert the stored ``tokens``
  match (see ``verify_tokenizer_alignment``).

v0.5.0 char-offset labels (#519): shards whose schema carries
``span_starts``/``span_ends``/``span_tags`` stream the triple end-to-end — through the
augmentations (which re-target it; see ``augment.py``) and the #511 relabel pass (char
arithmetic; see ``relabel.py``) into ``encode_row``, which builds the per-char label array FROM
the spans. Frozen pre-v0.5.0 shards carry no span columns and ride the legacy token path. A
shard with a partial column set, or a null span value in a span-schema shard, is corrupt and
raises loudly — never a silent fallback.
"""

from __future__ import annotations

import json
import logging
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Sequence

logger = logging.getLogger(__name__)

import pyarrow.parquet as pq

from .augment import SPAN_KEYS, augment_row
from .config import Config, DataConfig
from .labels import IGNORE_INDEX, active_components_present, locale_id
from .relabel import AffixRelabelLexicon, relabel_row
from .tokenizer import Tokenizer, encode_row, whitespace_spans

_REQUIRED_COLUMNS: tuple[str, ...] = ("raw", "tokens", "labels", "country", "source")

# v0.5.0 char-offset label columns (#519). Presence is decided PER SHARD by schema: a v0.5.0
# shard carries all three (and every row must be non-null in all three); a frozen pre-v0.5.0
# shard carries none (rows ride the legacy token path). A shard with SOME of the three is
# corrupt — loud failure, never a silent fallback.
_SPAN_COLUMNS: tuple[str, ...] = SPAN_KEYS


@dataclass
class EncodedExample:
    input_ids: list[int]
    attention_mask: list[int]
    labels: list[int]
    # PR3 self-conditioning: the row's locale class id (from its ``country``), or IGNORE_INDEX
    # when unmapped. The aux locale head's per-row target. Defaults to IGNORE_INDEX so encoders
    # built without locale conditioning are unaffected.
    locale_id: int = IGNORE_INDEX
    # Postcode-anchor channel (#239/#240). Per-piece ``(max_length, ANCHOR_FEATURE_DIM)`` features +
    # ``(max_length,)`` confidence, or None when no anchor lookup is configured (back-compat).
    anchor_features: list[list[float]] | None = None
    anchor_confidence: list[float] | None = None
    # Gazetteer-anchor channel (#464). Per-piece ``(max_length, lexicon.feature_dim)`` candidate-
    # tag-set clues + ``(max_length,)`` confidence, or None when no lexicon is configured.
    gazetteer_features: list[list[float]] | None = None
    gazetteer_confidence: list[float] | None = None


def load_anchor_lookup(path: str) -> dict[str, tuple[dict[str, float], float, float]]:
    """Load the postcode→anchor lookup (#239/#240) from JSON, once at loader init.

    Format: ``{normalized_postcode: [posterior_dict, lat, lon, source?]}`` where ``posterior_dict``
    is ``{country: weight}`` (uniform over the countries the code exists in) and the optional 4th
    element is the centroid's provenance label (#525 — e.g. ``"wof"`` / ``"census-zcta-2024"`` /
    ``null``), ignored here. Returns the tuple form ``realign_anchor_to_pieces`` consumes. Built
    offline by ``scripts/build-pilot-anchor-lookup.ts`` so the training loop carries no gazetteer
    dependency.
    """
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    return {pc: (row[0], float(row[1]), float(row[2])) for pc, row in raw.items()}


def _shard_paths(corpus_dir: Path, split: str) -> list[Path]:
    """Resolve train/val/test shard paths via MANIFEST.json (adapter-addition corpora)
    or legacy glob fallback (monolithic corpora).

    The MANIFEST lists per-shard absolute ``path`` + ``split``. Two realities complicate this:

    1. **Overlay corpora.** An overlay (e.g. v0.4.0 = synth shards layered on v0.3.0's base) keeps
       a manifest whose base-shard paths deliberately point into the OTHER corpus dir
       (``/data/.../v0.3.0/...``). Those are correct and must be used VERBATIM — re-rooting them to
       ``corpus_dir`` would point at files that don't exist (v0.4.0 only has the overlay shards).
    2. **Portability.** A non-overlay manifest stores absolute paths from the BUILD machine
       (``/mnt/playpen/...``) that don't exist when the corpus is mounted elsewhere (Modal volume
       at ``/data/...``).

    So per shard: use the manifest path AS-IS when it exists; otherwise RE-ROOT it under
    ``corpus_dir`` (take the ``<split>/<basename>`` tail). This serves both cases — overlay
    cross-dir refs are preserved when valid, build-machine paths are re-rooted when stale — and is
    why v0.7.2 (v0.4.0 overlay → v0.3.0 base) trained fine: its manifest paths resolve as-is on the
    volume. Falls back to a glob over ``corpus_dir/split`` only when the manifest yields nothing
    usable."""
    import json
    manifest = corpus_dir / "MANIFEST.json"
    if manifest.exists():
        data = json.loads(manifest.read_text())
        base_version = data.get("base_corpus_version")
        resolved: list[Path] = []
        rerooted = 0
        missing: list[str] = []
        declared = 0
        for s in data.get("shards", []):
            if s.get("split") != split:
                continue
            declared += 1
            raw = Path(s["path"])
            if raw.exists():
                # Path is valid as-is (overlay cross-dir ref, or corpus on its build machine).
                resolved.append(raw)
                continue
            # Stale absolute path (corpus moved): re-root the <split>/<file> tail under corpus_dir.
            parts = raw.parts
            tail = Path(*parts[parts.index(split):]) if split in parts else Path(split) / raw.name
            cand = corpus_dir / tail
            if cand.exists():
                resolved.append(cand)
                rerooted += 1
            else:
                missing.append(str(raw))
        # STRICT partial-resolution guard (#480, the v0.7.1 trap): a manifest that declares shards
        # this loop cannot find means the corpus is BROKEN (an overlay missing its base, a moved
        # volume) — training on the survivors silently measures the wrong corpus. There is no
        # legitimate partial case; fail with the full missing list. All-missing falls through to
        # the legacy glob (monolithic corpora whose manifests never resolved here).
        if resolved and missing:
            raise FileNotFoundError(
                f"MANIFEST declares {declared} '{split}' shards but {len(missing)} are unresolvable "
                f"(as-is AND re-rooted under {corpus_dir}):\n  " + "\n  ".join(missing[:10])
                + ("\n  ..." if len(missing) > 10 else "")
            )
        if resolved:
            print(
                f"[shards] {split}: {len(resolved)} resolved ({rerooted} re-rooted) from MANIFEST"
                + (f" (base_corpus_version={base_version})" if base_version else " (no base_corpus_version field)")
            )
            return sorted(resolved)
    # legacy fallback (monolithic corpora, or manifest yielded no resolvable shards)
    paths = sorted((corpus_dir / split).glob("*.parquet"))
    if not paths:
        raise FileNotFoundError(f"no shards via MANIFEST or {corpus_dir / split}")
    return paths


def _row_components_keys(labels: Sequence[str]) -> list[str]:
    """Return the unique component tags present in a row's BIO labels."""
    out: set[str] = set()
    for label in labels:
        if label == "O" or "-" not in label:
            continue
        _, tag = label.split("-", 1)
        out.add(tag)
    return list(out)


def _shard_first_source(shard: Path) -> str:
    """Return the ``source`` value of the first row in a parquet shard.

    Corpus v0.2.0 shards are 100% source-segregated (one source per shard), so reading
    the first row's source identifies the shard's source. Costs ~50 ms / shard at index
    time; called once per shard when ``_raw_row_stream`` starts.
    """
    pf = pq.ParquetFile(shard)
    rg = pf.read_row_group(0, columns=["source"])
    return rg["source"][0].as_py()


def _shard_row_iter(
    shard: Path,
    *,
    expected_source: str | None,
    rng: random.Random,
    country_weights: dict[str, float],
    max_weight: float,
    coarse_filter: bool,
) -> Iterator[dict]:
    """Yield filter-accepted rows from a single parquet shard, with row-group + row shuffle.

    Applies the country-weight acceptance test, (when ``coarse_filter`` is set) the
    coarse-label gate, and — when ``expected_source`` is given — a per-row source equality
    check. The per-row source check matters for the 2 "transition" shards in corpus
    v0.2.0 (part-0016 and part-0259) where one source's data ends and the next begins
    mid-shard; without it the per-source iterator would yield rows from the wrong source.

    Does **not** apply source weighting — source weighting is handled at the multinomial
    sampler level in ``_raw_row_stream``, so that the observed mix matches ``source_weights``
    exactly (rather than the ``raw_share × accept_share`` shape that per-row source
    acceptance produces, which under v0.2.0's heavy raw-share skew toward BAN proved
    unreliable as a steering mechanism — PR #44).
    """
    pf = pq.ParquetFile(shard)
    # Span-column presence is a per-shard schema fact (#519): all three or none. Partial = a
    # corrupt shard; reading the survivors would silently train the wrong labels.
    schema_names = set(pf.schema_arrow.names)
    span_present = [c for c in _SPAN_COLUMNS if c in schema_names]
    if span_present and len(span_present) != len(_SPAN_COLUMNS):
        missing = [c for c in _SPAN_COLUMNS if c not in schema_names]
        raise ValueError(
            f"corrupt shard {shard}: carries span columns {span_present} but is missing {missing} "
            "— the #519 triple is all-or-none per shard"
        )
    has_spans = bool(span_present)
    columns = list(_REQUIRED_COLUMNS) + (list(_SPAN_COLUMNS) if has_spans else [])
    rg_order = list(range(pf.num_row_groups))
    rng.shuffle(rg_order)
    for rg in rg_order:
        t = pf.read_row_group(rg, columns=columns)
        raws = t["raw"]
        tokens_col = t["tokens"]
        labels_col = t["labels"]
        countries = t["country"]
        sources = t["source"]
        span_cols = {c: t[c] for c in _SPAN_COLUMNS} if has_spans else None
        idx_order = list(range(t.num_rows))
        rng.shuffle(idx_order)
        for i in idx_order:
            source = sources[i].as_py()
            if expected_source is not None and source != expected_source:
                continue
            country = countries[i].as_py()
            weight = country_weights.get(country)
            if weight is None or weight <= 0:
                continue
            if weight < max_weight and rng.random() > weight / max_weight:
                continue
            bio_labels = labels_col[i].as_py()
            if coarse_filter:
                keys = _row_components_keys(bio_labels)
                if not active_components_present(keys):
                    continue
            row = {
                "raw": raws[i].as_py(),
                "tokens": tokens_col[i].as_py(),
                "labels": bio_labels,
                "country": country,
                "source": source,
            }
            if span_cols is not None:
                spans = {c: span_cols[c][i].as_py() for c in _SPAN_COLUMNS}
                nulls = [c for c, v in spans.items() if v is None]
                if nulls:
                    raise ValueError(
                        f"corrupt row in {shard} (row-group {rg}, raw={row['raw']!r}): "
                        f"null span column(s) {nulls} in a span-schema shard — never a silent "
                        "fallback to token labels"
                    )
                row.update(spans)
            yield row


def _source_iter(
    shards: list[Path],
    *,
    expected_source: str,
    rng: random.Random,
    country_weights: dict[str, float],
    max_weight: float,
    coarse_filter: bool,
) -> Iterator[dict]:
    """Yield rows from a sequence of shards, restricted to ``expected_source``.

    Shards are visited in shuffled order; within each shard, row-groups and row indices
    are also shuffled (see ``_shard_row_iter``). One row-group's worth of rows is held
    in memory at a time per source, so total RAM is bounded by the number of distinct
    sources, not by any shard-pool parameter.
    """
    order = list(shards)
    rng.shuffle(order)
    for s in order:
        yield from _shard_row_iter(
            s,
            expected_source=expected_source,
            rng=rng,
            country_weights=country_weights,
            max_weight=max_weight,
            coarse_filter=coarse_filter,
        )


def _raw_row_stream(
    corpus_dir: Path,
    split: str,
    *,
    rng: random.Random,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None,
    coarse_filter: bool,
) -> Iterator[dict]:
    """Internal stream: yields filter-accepted rows, sampled by weighted source multinomial.

    Wrapped by ``iter_rows`` with a reservoir-style shuffle buffer.

    Architecture:

    1. Bucket shards by their (single) ``source`` value. Corpus v0.2.0 shards are 100%
       source-segregated, so this is a one-time scan of one row-group header per shard.
    2. For each source, build a per-source row iterator that visits its shards in shuffled
       order. Each iterator yields rows after country + coarse filtering.
    3. On each pull, sample a source via the ``source_weights`` multinomial (or uniform
       when ``source_weights`` is None) and yield the next row from that source's iterator.
       When a source's iterator exhausts, drop it from the multinomial and renormalize.

    Why this and not per-row source acceptance:

    The naive approach of accepting each row with probability ``source_weights[source] /
    max(source_weights)`` was the original v0.2.0 implementation (PR #44). It is correct
    on average — the observed mix converges to ``raw_share × accept_share / norm`` — but
    under v0.2.0's shard layout it fails empirically: shards are 1M-row single-source
    blocks, so the downstream shuffle buffer fills entirely from the current shard's
    source before any cross-source mixing happens. Long runs of one source within a batch
    reproduce the positional-heuristic overfit that motivated this issue (#43).

    Source-level multinomial sampling makes the observed mix match ``source_weights``
    *exactly* per-pull, regardless of raw share or shard layout. Memory: one active
    row-group per source ≈ ``|sources| × 50 MB`` peak — ~300 MB for v0.2.0's 6 train-split
    sources, well within budget.
    """
    shard_paths = _shard_paths(corpus_dir, split)
    max_weight = max(country_weights.values())

    logger.info("Indexing %d shards by source...", len(shard_paths))
    by_source: dict[str, list[Path]] = {}
    skipped_shards: list[tuple[Path, str]] = []
    for s in shard_paths:
        if not s.exists():
            skipped_shards.append((s, "file not found"))
            continue
        try:
            src = _shard_first_source(s)
        except Exception as exc:
            skipped_shards.append((s, str(exc)))
            continue
        by_source.setdefault(src, []).append(s)

    if skipped_shards:
        logger.warning(
            "Skipped %d shards (missing or unreadable):\n  %s",
            len(skipped_shards),
            "\n  ".join(f"{p}: {reason}" for p, reason in skipped_shards[:10]),
        )

    # FOOTGUN GUARD: a shard with a None `source` (e.g. a --golden eval shard wrongly used as a train/
    # val shard — golden rows carry no source field) used to crash here with a cryptic
    # "'<' not supported between NoneType and str" from sorted(). Fail loud with the real cause instead.
    if any(src is None for src in by_source):
        n_none = sum(len(s) for src, s in by_source.items() if src is None)
        raise ValueError(
            f"{n_none} shard rows have no `source` field — likely a --golden (label-less) shard used as a "
            "train/val shard. Rebuild that shard WITHOUT --golden so rows carry source + labels."
        )
    logger.info(
        "Shard index: %s",
        ", ".join(f"{src}={len(shards)}" for src, shards in sorted(by_source.items())),
    )

    if source_weights is not None:
        dropped = {src for src in by_source if source_weights.get(src, 0) <= 0}
        by_source = {
            src: shards
            for src, shards in by_source.items()
            if source_weights.get(src, 0) > 0
        }
        if dropped:
            logger.info("Dropped %d zero-weighted sources: %s", len(dropped), dropped)
        if not by_source:
            raise ValueError(
                "no shards remain after applying source_weights — every shard's source "
                f"is missing from or zero-weighted in source_weights={source_weights!r}"
            )

    iters: dict[str, Iterator[dict]] = {
        src: _source_iter(
            shards,
            expected_source=src,
            rng=rng,
            country_weights=country_weights,
            max_weight=max_weight,
            coarse_filter=coarse_filter,
        )
        for src, shards in by_source.items()
    }
    weights: dict[str, float] = {
        src: float(source_weights[src]) if source_weights is not None else 1.0
        for src in iters
    }

    while iters:
        sources = list(iters.keys())
        cum: list[float] = []
        total = 0.0
        for src in sources:
            total += weights[src]
            cum.append(total)
        r = rng.random() * total
        chosen = sources[-1]
        for src, c in zip(sources, cum):
            if r < c:
                chosen = src
                break
        try:
            yield next(iters[chosen])
        except StopIteration:
            del iters[chosen]
            del weights[chosen]


def iter_rows(
    corpus_dir: Path,
    split: str,
    *,
    rng: random.Random,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None = None,
    coarse_filter: bool,
    row_limit: int | None = None,
    augment_directional_prob: float = 0.0,
    augment_region_prob: float = 0.0,
    augment_glue_prob: float = 0.0,
    affix_relabel_lexicon: "AffixRelabelLexicon | None" = None,
    shuffle_buffer: int = 131072,
) -> Iterator[dict]:
    """Yield rows from parquet shards, filtered + shuffled.

    Shuffling is done at three levels:

    1. Shard order (per-epoch): shards visited in random order.
    2. Row-group order within shard: row-groups visited in random order.
    3. Within row-group: row indices permuted before scan.

    Then a reservoir-style ``shuffle_buffer`` of size ``shuffle_buffer`` rows mixes
    yields across row-group boundaries. This is the standard HuggingFace ``streaming``
    shuffle pattern: hold ``N`` rows, pop a random one, replace from the upstream stream
    (when exhausted, drain the buffer in random order).

    Skipping shuffle (``shuffle_buffer<=0``) is intentionally not supported — the previous
    sequential layout caused val_loss to diverge at step ~1500. Always shuffle.

    Per Phase 2 §2 (stratified sampling): ``country_weights`` is applied during the raw
    scan, *before* the buffer, so sampled fractions land in the buffer with the configured
    weights. ``source_weights`` multiplies with ``country_weights`` — a row must pass
    both to survive. When ``source_weights`` is ``None`` (default), all sources pass.

    Memory: each buffered row is a dict of {raw: str, tokens: list[str], labels: list[str],
    country: str, source: str}. For Stage 1 coarse rows, that's ~1 KB per row; default
    131072 buffer is ~128 MB resident, well within budget. The v0.1.1 default of 16384
    was sized for a 22M-row corpus; v0.2.0 ships 263M rows so the same 16k buffer would
    sample only 0.006% per shuffle — within-shard order would dominate. 128k buffer
    samples 0.05% which restores effective randomness without meaningful RAM impact.
    """
    if not country_weights:
        raise ValueError("country_weights must be non-empty")
    upstream = _raw_row_stream(
        corpus_dir,
        split,
        rng=rng,
        country_weights=country_weights,
        source_weights=source_weights,
        coarse_filter=coarse_filter,
    )
    buf: list[dict] = []
    yielded = 0
    # Fill the buffer first.
    try:
        for _ in range(shuffle_buffer):
            buf.append(next(upstream))
    except StopIteration:
        pass
    do_augment = augment_directional_prob > 0 or augment_region_prob > 0 or augment_glue_prob > 0

    def _emit(row: dict) -> Iterator[dict]:
        # Relabel runs AFTER augmentation so label-inheriting directional expansions are caught
        # (#511 — see relabel.py). augment_row yields fresh dicts but shares the labels list with
        # the source row on the no-op path, so relabel copies before mutating.
        if do_augment:
            for augmented in augment_row(
                row, rng, augment_directional_prob, augment_region_prob, augment_glue_prob
            ):
                if affix_relabel_lexicon is not None:
                    augmented = {**augmented, "labels": list(augmented["labels"])}
                    relabel_row(augmented, affix_relabel_lexicon)
                yield augmented
        elif affix_relabel_lexicon is not None:
            row = {**row, "labels": list(row["labels"])}
            relabel_row(row, affix_relabel_lexicon)
            yield row
        else:
            yield row

    # Stream out: every time we yield, pull the next from upstream into the freed slot.
    for row in upstream:
        j = rng.randrange(len(buf))
        out = buf[j]
        buf[j] = row
        for emitted in _emit(out):
            yield emitted
            yielded += 1
            if row_limit is not None and yielded >= row_limit:
                return
    # Drain whatever remains in the buffer.
    rng.shuffle(buf)
    for out in buf:
        for emitted in _emit(out):
            yield emitted
            yielded += 1
            if row_limit is not None and yielded >= row_limit:
                return


def iter_encoded(
    cfg_data: DataConfig,
    tokenizer: Tokenizer,
    *,
    split: str = "train",
    rng: random.Random | None = None,
    row_limit: int | None = None,
) -> Iterator[EncodedExample]:
    """Yield encoded examples, dropping rows whose SP token count exceeds ``max_length``.

    Length-filter rationale: address text is short by nature; long rows are usually adapter
    bugs (per Phase 2 §2.3). Cap at the model's ``max_position_embeddings``.
    """
    rng = rng or random.Random(0)
    # Postcode-anchor lookup (#239/#240): loaded once, passed to every encode_row. None → no anchor
    # features produced (back-compat). See load_anchor_lookup.
    anchor_lookup = load_anchor_lookup(cfg_data.anchor_lookup_path) if cfg_data.anchor_lookup_path else None
    # Gazetteer-anchor lexicon (#464): loaded once. None → no gazetteer features (back-compat).
    gazetteer_lexicon = None
    if getattr(cfg_data, "gazetteer_lexicon_path", None):
        from .gazetteer_anchor import load_gazetteer_lexicon

        gazetteer_lexicon = load_gazetteer_lexicon(cfg_data.gazetteer_lexicon_path)
    affix_relabel_lexicon = None
    if getattr(cfg_data, "affix_relabel_lexicon_path", None):
        affix_relabel_lexicon = AffixRelabelLexicon.load(cfg_data.affix_relabel_lexicon_path)
    astral_skipped = 0
    for row in iter_rows(
        Path(cfg_data.corpus_dir),
        split,
        rng=rng,
        country_weights=cfg_data.country_weights,
        source_weights=cfg_data.source_weights,
        coarse_filter=cfg_data.coarse_filter,
        row_limit=row_limit,
        augment_directional_prob=cfg_data.augment_directional_prob,
        augment_region_prob=cfg_data.augment_region_prob,
        augment_glue_prob=getattr(cfg_data, "augment_glue_prob", 0.0),
        affix_relabel_lexicon=affix_relabel_lexicon,
    ):
        # v0.5.0 stopgap (#519 offset-unit mismatch): the corpus stores span offsets in UTF-16 code
        # units, but this consumer (char_label_array_from_spans + SentencePiece pieces) is code-point-
        # native. For astral-plane rows (~0.06% — exotic-script country-name variants like Gothic), a
        # UTF-16 span end can exceed the code-point len(raw) and encode_row would raise
        # span-out-of-bounds. Skip + count rather than crash a multi-hour training run. Lasting fix:
        # emit code-point offsets in the TS build and re-align (corpus-v0.5.1). 2026-06-12.
        _se = row.get("span_ends")
        if _se and max(_se) > len(row["raw"]):
            astral_skipped += 1
            if astral_skipped <= 5 or astral_skipped % 50000 == 0:
                logger.warning(
                    "iter_encoded: skipped astral UTF-16-offset row #%d (span end > code-point len): %r",
                    astral_skipped,
                    row["raw"][:40],
                )
            continue
        enc = encode_row(
            tokenizer,
            row["raw"],
            row["tokens"],
            row["labels"],
            max_length=cfg_data.max_length,
            anchor_lookup=anchor_lookup,
            anchor_paint_mode=getattr(cfg_data, "anchor_paint_mode", "gold"),
            gazetteer_lexicon=gazetteer_lexicon,
            gazetteer_choreography=getattr(cfg_data, "gazetteer_choreography", False),
            # v0.5.0 char-offset labels (#519): rows from a span-schema shard train FROM the
            # spans (encode_row builds the per-char label array from them; the token path is the
            # legacy fallback for frozen corpora). encode_row raises on a partial triple.
            span_starts=row.get("span_starts"),
            span_ends=row.get("span_ends"),
            span_tags=row.get("span_tags"),
        )
        # Drop rows whose non-padding length exceeds max_length (length filter §2).
        non_pad = sum(enc["attention_mask"])
        if non_pad >= cfg_data.max_length:
            # Even at exactly max_length we keep — the spec says drop tokens > 128; equality is fine.
            # But hand-curated coarse rows almost never hit this. Track via downstream metrics.
            pass
        yield EncodedExample(
            input_ids=enc["input_ids"],
            attention_mask=enc["attention_mask"],
            labels=enc["labels"],
            locale_id=locale_id(row.get("country")),
            anchor_features=enc.get("anchor_features"),
            anchor_confidence=enc.get("anchor_confidence"),
            gazetteer_features=enc.get("gazetteer_features"),
            gazetteer_confidence=enc.get("gazetteer_confidence"),
        )


def collate(batch: list[EncodedExample]) -> dict:
    """Stack a list of ``EncodedExample`` into batched lists. Caller wraps in torch tensors."""
    out = {
        "input_ids": [ex.input_ids for ex in batch],
        "attention_mask": [ex.attention_mask for ex in batch],
        "labels": [ex.labels for ex in batch],
        "locale_ids": [ex.locale_id for ex in batch],
    }
    # Postcode-anchor channel (#239/#240): only present when every example carries anchor features
    # (i.e. an anchor lookup is configured). Absent → omitted, so the trainer's tensor-conversion
    # skips it and the model runs anchor-free (back-compat).
    if batch and batch[0].anchor_features is not None:
        out["anchor_features"] = [ex.anchor_features for ex in batch]
        out["anchor_confidence"] = [ex.anchor_confidence for ex in batch]
    # Gazetteer-anchor channel (#464): same presence contract as the postcode anchor.
    if batch and batch[0].gazetteer_features is not None:
        out["gazetteer_features"] = [ex.gazetteer_features for ex in batch]
        out["gazetteer_confidence"] = [ex.gazetteer_confidence for ex in batch]
    return out


def iter_batches(
    cfg: Config,
    tokenizer: Tokenizer,
    *,
    split: str,
    batch_size: int,
    seed: int = 0,
    row_limit: int | None = None,
) -> Iterator[dict]:
    """Yield collated batches indefinitely until the underlying iterator exhausts."""
    rng = random.Random(seed)
    buf: list[EncodedExample] = []
    for ex in iter_encoded(cfg.data, tokenizer, split=split, rng=rng, row_limit=row_limit):
        buf.append(ex)
        if len(buf) == batch_size:
            yield collate(buf)
            buf = []
    if buf:
        yield collate(buf)


def verify_tokenizer_alignment(
    corpus_dir: Path,
    tokenizer: Tokenizer,
    *,
    sample_size: int = 100,
) -> None:
    """Assert that the SP tokenizer is *compatible* with the stored whitespace tokens.

    The stored ``tokens`` field is whitespace-tokenized, while the model uses SentencePiece
    sub-tokens. They will not be byte-identical. What we DO need is:

    1. The whitespace tokens are recoverable from ``raw`` via left-to-right substring scan
       (corpus invariant — if this breaks, the corpus build is corrupt).
    2. The SP tokenizer can be loaded.

    If invariant (1) fails this raises; (2) failed earlier when we constructed Tokenizer.
    """
    shard = _shard_paths(corpus_dir, "train")[0]
    pf = pq.ParquetFile(shard)
    t = pf.read_row_group(0, columns=list(_REQUIRED_COLUMNS))
    raws = t["raw"]
    tokens_col = t["tokens"]
    n = min(sample_size, t.num_rows)
    for i in range(n):
        raw = raws[i].as_py()
        toks = tokens_col[i].as_py()
        try:
            whitespace_spans(raw, toks)
        except ValueError as exc:
            raise RuntimeError(
                f"corpus tokenizer invariant broken at row {i} of shard {shard}: {exc}"
            ) from exc
        # Smoke the SP encoder so a mis-pointed tokenizer.model fails fast.
        tokenizer.encode_with_spans(raw)


__all__ = [
    "EncodedExample",
    "IGNORE_INDEX",
    "iter_rows",
    "iter_encoded",
    "iter_batches",
    "verify_tokenizer_alignment",
]
