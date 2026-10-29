"""Sampled rows to encoded examples, through the Rust row encoder or the char path.

The SentencePiece path encodes through `mailwoman_mtf.RowEncoder`, built from `packages/mtf/crates/mtf-py`. It holds
the tokenizer, the label table and every channel lexicon, loaded once by `build_row_encoder`, and encodes a batch of
rows into arrays (`docs/engineering/reference/training-row-encoder.mdx`). The sampler stays here: `iter_sampled_rows`
draws rows through `iter_rows`, skips the astral rows and calls the observer, and both paths read it.

The two paths are exclusive. The char path skips SentencePiece and requires span-schema parquet files. It refuses
configured channels because they project per SentencePiece piece without per-unit alignment.
"""

from __future__ import annotations

import logging
import random
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mailwoman_mtf

from ...address_systems import address_system_id
from ...config import DataConfig
from ...labels import ACTIVE_TAGS, IGNORE_INDEX, LABEL_TO_ID, LOCALE_COUNTRIES, locale_id, resolve_label_set
from ...paths import package_path
from ...tokenizer import Tokenizer, char_label_array_from_spans, whitespace_spans
from ...tokenizer.char import encode_row_units, load_char_vocab
from ..relabel import AffixRelabelLexicon
from .example import EncodedExample
from .stream import iter_rows

logger = logging.getLogger(__name__)

#: The channel paths `char_mode` refuses. Each projects per SentencePiece piece.
#: The char path has no per-unit alignment for them yet, so a config naming one alongside `char_mode` is asking
#: for a clue the encoder cannot place.
CHANNEL_PATHS = (
    "anchor_lookup_path",
    "gazetteer_lexicon_path",
    "country_lexicon_path",
    "street_type_lexicon_path",
    "locality_surface_lexicon_path",
)

#: The records the Rust finders read: the postcode shapes the shaped anchor paints and each country's postcode
#: syntax, which counts the countries accepting a code unit.
POSTCODE_SHAPES = package_path("features", "postcode-shapes.json")
POSTCODE_SYNTAX = package_path("data", "postcode-syntax.json")


@dataclass(frozen=True)
class CharMode:
    """The CharCNN path's settings, or `None` in place of this when the SentencePiece path runs."""

    mode: str
    vocab: dict[str, int]
    max_units: int
    max_unit_width: int
    char_ctx: int


def resolve_char_mode(cfg_data: DataConfig) -> CharMode | None:
    """The char path's settings, or None for the SentencePiece path.

    CharCNN input path (#825 / v8 CJK). When char_mode != "off" the row loop skips SentencePiece
    entirely and encodes per-unit char windows (encode_row_units). The mode is channel-free by
    interface — the channels project per SP-piece and get a per-unit re-alignment post-probe — so a
    configured channel path alongside char_mode is a config mistake, raised loudly here.
    """
    mode = getattr(cfg_data, "char_mode", "off")
    if mode not in ("off", "word", "char"):
        raise ValueError(f"unknown data.char_mode {mode!r} (expected off | word | char)")
    if mode == "off":
        return None

    char_vocab_path = getattr(cfg_data, "char_vocab_path", None)
    if not char_vocab_path:
        raise ValueError("data.char_mode requires data.char_vocab_path (build_char_vocab's sealed JSON)")
    configured = [name for name in CHANNEL_PATHS if getattr(cfg_data, name, None)]
    if configured:
        raise ValueError(
            f"data.char_mode is channel-free (channels re-align per-unit post-probe, v8 CJK plan): unset {configured}"
        )
    char_ctx = int(getattr(cfg_data, "char_ctx", 0))
    max_unit_width = int(getattr(cfg_data, "max_unit_width", 16))
    if mode == "char" and max_unit_width < 2 * char_ctx + 1:
        raise ValueError(
            f"data.max_unit_width={max_unit_width} truncates the char window: char_mode=char with "
            f"char_ctx={char_ctx} needs W >= {2 * char_ctx + 1}"
        )
    max_units = int(getattr(cfg_data, "max_units", None) or cfg_data.max_length)
    return CharMode(mode, load_char_vocab(char_vocab_path), max_units, max_unit_width, char_ctx)


def require_label_set_supported(cfg_data: DataConfig, char: CharMode | None) -> Any:
    """The config's label set, raising when the SentencePiece path is asked for a set other than `stage3`.

    Non-default sets are threaded through the char path only. The row encoder encodes against the `stage3` maps,
    so a non-default set there would mislabel every row without an error (#1349).
    """
    label_set = resolve_label_set(getattr(cfg_data, "label_set", "stage3"))
    if label_set.name != "stage3" and char is None:
        raise ValueError(f"data.label_set={label_set.name!r} is only supported with data.char_mode != 'off'")
    return label_set


def row_encoder(
    tokenizer: Tokenizer | None,
    *,
    max_length: int,
    pad_id: int | None = None,
    anchor_lookup_path: str | None = None,
    anchor_paint_mode: str = "gold",
    gazetteer_lexicon_path: str | None = None,
    gazetteer_choreography: bool = False,
    country_lexicon_path: str | None = None,
    street_type_lexicon_path: str | None = None,
    locality_surface_lexicon_path: str | None = None,
    code_units: bool = False,
) -> mailwoman_mtf.RowEncoder:
    """A row encoder over the `stage3` label table, the locale table and the given lexicons.

    An empty path leaves its channel off. `tokenizer` may be None when every call passes its own pieces.
    """
    return mailwoman_mtf.RowEncoder(
        tokenizer.mtf if tokenizer is not None else None,
        max_length=max_length,
        pad_id=pad_id,
        label_to_id=dict(LABEL_TO_ID),
        active_tags=list(ACTIVE_TAGS),
        ignore_index=IGNORE_INDEX,
        locale_countries=list(LOCALE_COUNTRIES),
        postcode_shapes_path=str(POSTCODE_SHAPES),
        postcode_syntax_path=str(POSTCODE_SYNTAX),
        anchor_lookup_path=anchor_lookup_path or None,
        anchor_paint_mode=anchor_paint_mode,
        gazetteer_lexicon_path=gazetteer_lexicon_path or None,
        gazetteer_choreography=gazetteer_choreography,
        country_lexicon_path=country_lexicon_path or None,
        street_type_lexicon_path=street_type_lexicon_path or None,
        locality_surface_lexicon_path=locality_surface_lexicon_path or None,
        code_units=code_units,
    )


def build_row_encoder(cfg_data: DataConfig, tokenizer: Tokenizer) -> mailwoman_mtf.RowEncoder:
    """The row encoder a config's SentencePiece path encodes with, every lexicon read once."""
    require_label_set_supported(cfg_data, None)
    return row_encoder(
        tokenizer,
        max_length=cfg_data.max_length,
        anchor_lookup_path=cfg_data.anchor_lookup_path,
        anchor_paint_mode=getattr(cfg_data, "anchor_paint_mode", "gold"),
        gazetteer_lexicon_path=getattr(cfg_data, "gazetteer_lexicon_path", None),
        gazetteer_choreography=bool(getattr(cfg_data, "gazetteer_choreography", False)),
        country_lexicon_path=getattr(cfg_data, "country_lexicon_path", None),
        street_type_lexicon_path=getattr(cfg_data, "street_type_lexicon_path", None),
        locality_surface_lexicon_path=getattr(cfg_data, "locality_surface_lexicon_path", None),
        code_units=bool(getattr(cfg_data, "code_unit_features", False)),
    )


def encode_one(encoder: mailwoman_mtf.RowEncoder, row: dict[str, Any]) -> dict[str, list[Any]]:
    """One row's tensors as lists, for a tool that scores rows one at a time."""
    return {name: array[0].tolist() for name, array in encoder.encode_batch([row]).items()}


def sampler_inputs(cfg_data: DataConfig) -> dict[str, Any]:
    """The keyword arguments the loader passes `iter_rows`, with the affix-relabel lexicon loaded."""
    affix_path = getattr(cfg_data, "affix_relabel_lexicon_path", None)
    return {
        "country_weights": cfg_data.country_weights,
        "source_weights": cfg_data.source_weights,
        "coarse_filter": cfg_data.coarse_filter,
        "augment_directional_prob": cfg_data.augment_directional_prob,
        "augment_region_prob": cfg_data.augment_region_prob,
        "augment_glue_prob": getattr(cfg_data, "augment_glue_prob", 0.0),
        "augment_case_prob": getattr(cfg_data, "augment_case_prob", 0.0),
        "augment_punct_drop_prob": getattr(cfg_data, "augment_punct_drop_prob", 0.0),
        "augment_upper_case_prob": getattr(cfg_data, "augment_upper_case_prob", 0.0),
        "augment_ordinal_prob": getattr(cfg_data, "augment_ordinal_prob", 0.0),
        "augment_postcode_move_prob": getattr(cfg_data, "augment_postcode_move_prob", 0.0),
        "augment_grouping_prob": getattr(cfg_data, "augment_grouping_prob", 0.0),
        "augment_exclude_sources": getattr(cfg_data, "augment_exclude_sources", ()),
        "affix_relabel_lexicon": AffixRelabelLexicon.load(affix_path) if affix_path else None,
    }


def iter_sampled_rows(
    cfg_data: DataConfig,
    split: str,
    *,
    rng: random.Random,
    row_limit: int | None = None,
    observer: Callable[[dict[str, Any]], None] | None = None,
) -> Iterator[dict[str, Any]]:
    """The rows the loader encodes, in sampler order, with the astral-offset rows skipped.

    `observer` sees each yielded row as it is yielded, so it sees exactly the rows encoded.
    """
    astral_skipped = 0
    for row in iter_rows(Path(cfg_data.corpus_dir), split, rng=rng, row_limit=row_limit, **sampler_inputs(cfg_data)):
        # v0.5.0 stopgap (#519 offset-unit mismatch): the corpus stores span offsets in UTF-16 code
        # units, but this consumer (char_label_array_from_spans + SentencePiece pieces) is code-point-
        # native. For astral-plane rows (~0.06% — exotic-script country-name variants like Gothic), a
        # UTF-16 span end can exceed the code-point len(raw) and the encoder would raise
        # span-out-of-bounds. The loader counts and skips the row rather than crashing a multi-hour training run. Durable fix:
        # emit code-point offsets in the TS build and re-align (corpus-v0.5.1). 2026-06-12.
        _se = row.get("span_ends")
        if _se and max(_se) > len(row["raw"]):
            astral_skipped += 1
            if astral_skipped <= 5 or astral_skipped % 50000 == 0:
                logger.warning(
                    "iter_sampled_rows: skipped astral UTF-16-offset row #%d (span end > code-point len): %r",
                    astral_skipped,
                    row["raw"][:40],
                )
            continue
        if observer is not None:
            observer(row)
        yield row


def encode_char_row(row: dict[str, Any], char: CharMode, label_set: Any) -> EncodedExample:
    """One row on the CharCNN path: per-unit char windows, labels straight from the span triple.

    Span-schema is required here. The per-char label array comes from the span triple without
    whitespace-token quantization. A token-only frozen parquet file cannot supply char-level labels,
    because its labels are quantized to whitespace tokens. Fail loudly under #519 rather than falling back silently.
    """
    starts, ends, tags = row.get("span_starts"), row.get("span_ends"), row.get("span_tags")
    if starts is None or ends is None or tags is None:
        raise ValueError(
            f"data.char_mode={char.mode} requires span-schema parquet files (v0.5.0 #519); "
            f"got a token-only row: {row['raw'][:60]!r}"
        )
    raw = row["raw"]
    char_labels = char_label_array_from_spans(raw, starts, ends, tags)
    if char.mode == "char":
        # One unit per character (D3): unit index == char offset, whitespace units receive O.
        unit_spans = [(i, i + 1) for i in range(len(raw))]
    else:
        unit_spans = whitespace_spans(raw, row["tokens"])
    enc = encode_row_units(
        raw,
        unit_spans,
        char_labels,
        char.vocab,
        max_units=char.max_units,
        max_unit_width=char.max_unit_width,
        ctx_chars=char.char_ctx,
        label_to_id=label_set.label_to_id,
        collapse=label_set.collapse_label,
    )
    return EncodedExample(
        # Dummy pad row — the model's use_char_embed branch derives (B, S) from char_ids
        # and never reads input_ids. the constant row keeps collate/_to_tensor_batch uniform.
        input_ids=[0] * len(enc["attention_mask"]),
        attention_mask=enc["attention_mask"],
        labels=enc["labels"],
        locale_id=locale_id(row.get("country")),
        address_system_id=address_system_id(row.get("country"), raw),
        char_ids=enc["char_ids"],
    )


def example_from_batch(batch: dict[str, Any], row: dict[str, Any]) -> EncodedExample:
    """The `EncodedExample` of the one row a batch encoded."""
    values = {name: array[0].tolist() for name, array in batch.items()}
    return EncodedExample(
        input_ids=values.pop("input_ids"),
        attention_mask=values.pop("attention_mask"),
        labels=values.pop("labels"),
        locale_id=locale_id(row.get("country")),
        address_system_id=address_system_id(row.get("country"), row["raw"]),
        **values,
    )


def iter_encoded(
    cfg_data: DataConfig,
    tokenizer: Tokenizer | None,
    *,
    split: str = "train",
    rng: random.Random | None = None,
    row_limit: int | None = None,
    observer: Callable[[dict[str, Any]], None] | None = None,
) -> Iterator[EncodedExample]:
    """Yield one encoded example per sampled row, for a tool that reads rows one at a time.

    The SentencePiece path builds its row encoder once for the stream. The training loop reads `iter_batches`
    instead, which encodes whole batches with the encoder the process built. ``tokenizer`` may be None only when
    ``cfg_data.char_mode != "off"``, because the char path never touches SentencePiece.
    """
    rng = rng or random.Random(0)
    char = resolve_char_mode(cfg_data)
    label_set = require_label_set_supported(cfg_data, char)
    encoder: mailwoman_mtf.RowEncoder | None = None
    if char is None:
        if tokenizer is None:
            raise ValueError("the SentencePiece path requires a tokenizer")
        encoder = build_row_encoder(cfg_data, tokenizer)
    for row in iter_sampled_rows(cfg_data, split, rng=rng, row_limit=row_limit, observer=observer):
        if encoder is None:
            yield encode_char_row(row, char, label_set)  # type: ignore[arg-type]
        else:
            yield example_from_batch(encoder.encode_batch([row]), row)
