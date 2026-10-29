"""Sampled rows to encoded examples, through the Rust sampler, the Rust row encoder or the Rust char encoder.

The rows come from `mailwoman_mtf.Sampler`, built from `packages/mtf/crates/mtf-sampler`
(`docs/engineering/reference/training-row-encoder.mdx`). It lists the corpus split, streams the source mixture through
the shuffle buffer, augments and relabels train rows, and skips the rows whose UTF-16 span offsets run past their text.
`sampler_config` turns a `DataConfig` into the JSON configuration the sampler reads.

The SentencePiece path encodes through `mailwoman_mtf.RowEncoder`, which holds the tokenizer, the label table and every
channel lexicon, loaded once by `build_row_encoder`. The char path encodes through `mailwoman_mtf.CharEncoder`, built by
`build_char_encoder`; it skips SentencePiece, requires span-schema parquet files, and refuses configured channels
because they project per SentencePiece piece without per-unit alignment.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterator
from typing import Any

import mailwoman_mtf

from ...address_systems import address_system_id
from ...config import DataConfig
from ...env import sha256_cache_path, volume_mount
from ...labels import ACTIVE_TAGS, IGNORE_INDEX, LABEL_TO_ID, LOCALE_COUNTRIES, locale_id, resolve_label_set
from ...paths import package_path
from ...tokenizer import Tokenizer
from .example import EncodedExample

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

#: Each country's postcode side relative to its locality-and-region block, which the postcode move reads.
POSTCODE_LAYOUTS = package_path("data", "augment", "postcode-layouts.json")


def _data_root() -> str | None:
    """`MAILWOMAN_DATA_ROOT`, the host mirror of the volume mount, or None when unset or blank."""
    return os.environ.get("MAILWOMAN_DATA_ROOT") or None


def sampler_config(cfg_data: DataConfig, *, drop_spans: bool = False) -> str:
    """The sampler's JSON configuration for a `DataConfig`.

    `source_weights` must already hold any `source_reps` targets. `resolve_config_reps` folds them in, and the
    sampler then reads the weights the launch log reports. `drop_spans` removes each row's span triple before the astral
    check, the encoder-parity token-label arm.
    """
    return _sampler_document(
        corpus_dir=cfg_data.corpus_dir,
        country_weights=cfg_data.country_weights,
        source_weights=cfg_data.source_weights,
        coarse_filter=cfg_data.coarse_filter,
        augment={name: getattr(cfg_data, f"augment_{name}_prob", 0.0) for name in AUGMENTATIONS},
        augment_exclude_sources=getattr(cfg_data, "augment_exclude_sources", ()),
        affix_relabel_lexicon_path=getattr(cfg_data, "affix_relabel_lexicon_path", None),
        drop_spans=drop_spans,
    )


#: The augmentations, by the name `DataConfig` gives each `augment_<name>_prob` and the sampler's `augment` key.
AUGMENTATIONS = (
    "directional",
    "region",
    "glue",
    "case",
    "punct_drop",
    "upper_case",
    "ordinal",
    "postcode_move",
    "grouping",
)


def _sampler_document(
    *,
    corpus_dir: Any,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None,
    coarse_filter: bool,
    augment: dict[str, float],
    augment_exclude_sources: Any = (),
    affix_relabel_lexicon_path: str | None = None,
    drop_spans: bool = False,
    shuffle_buffer: int | None = None,
) -> str:
    cache = sha256_cache_path()
    document: dict[str, Any] = {
        "corpus_dir": str(corpus_dir),
        "country_weights": dict(country_weights),
        "source_weights": dict(source_weights) if source_weights is not None else None,
        "coarse_filter": bool(coarse_filter),
        "active_tags": list(ACTIVE_TAGS),
        "augment": augment,
        "augment_exclude_sources": list(augment_exclude_sources or ()),
        "affix_relabel_lexicon_path": affix_relabel_lexicon_path or None,
        "postcode_layouts_path": str(POSTCODE_LAYOUTS),
        "drop_spans": drop_spans,
        "data_root": _data_root(),
        "volume_mount": str(volume_mount()),
        "sha256_cache_path": str(cache) if cache is not None else None,
    }
    if shuffle_buffer is not None:
        document["shuffle_buffer"] = shuffle_buffer
    return json.dumps(document)


def iter_rows(
    corpus_dir: Any,
    split: str,
    *,
    seed: int,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None = None,
    coarse_filter: bool,
    row_limit: int | None = None,
    augment: dict[str, float] | None = None,
    augment_exclude_sources: Any = (),
    affix_relabel_lexicon_path: str | None = None,
    shuffle_buffer: int | None = None,
) -> Iterator[dict[str, Any]]:
    """The sampler's rows for settings given one by one, for a tool without a `DataConfig`.

    `augment` maps an `AUGMENTATIONS` name to its probability. The rows are the ones `iter_sampled_rows` yields for
    the same settings, with the astral-offset rows skipped.
    """
    unknown = sorted(set(augment or {}) - set(AUGMENTATIONS))
    if unknown:
        raise ValueError(f"unknown augmentations {unknown}; expected names from {AUGMENTATIONS}")
    document = _sampler_document(
        corpus_dir=corpus_dir,
        country_weights=country_weights,
        source_weights=source_weights,
        coarse_filter=coarse_filter,
        augment=dict(augment or {}),
        augment_exclude_sources=augment_exclude_sources,
        affix_relabel_lexicon_path=affix_relabel_lexicon_path,
        shuffle_buffer=shuffle_buffer,
    )
    yield from mailwoman_mtf.Sampler(document, split, seed, row_limit)


def check_char_mode(cfg_data: DataConfig) -> bool:
    """Whether the config encodes on the char path, refusing a char config that configures a channel or lacks a vocabulary."""
    mode = getattr(cfg_data, "char_mode", "off")
    if mode not in ("off", "word", "char"):
        raise ValueError(f"unknown data.char_mode {mode!r} (expected off | word | char)")
    if mode == "off":
        return False
    if not getattr(cfg_data, "char_vocab_path", None):
        raise ValueError("data.char_mode requires data.char_vocab_path (build_char_vocab's sealed JSON)")
    configured = [name for name in CHANNEL_PATHS if getattr(cfg_data, name, None)]
    if configured:
        raise ValueError(
            f"data.char_mode is channel-free (channels re-align per-unit post-probe, v8 CJK plan): unset {configured}"
        )
    return True


def require_label_set_supported(cfg_data: DataConfig, char: bool) -> Any:
    """The config's label set, raising when the SentencePiece path is asked for a set other than `stage3`.

    Non-default sets are threaded through the char path only. The row encoder encodes against the `stage3` maps,
    so a non-default set there would mislabel every row without an error (#1349).
    """
    label_set = resolve_label_set(getattr(cfg_data, "label_set", "stage3"))
    if label_set.name != "stage3" and not char:
        raise ValueError(f"data.label_set={label_set.name!r} is only supported with data.char_mode != 'off'")
    return label_set


def build_char_encoder(cfg_data: DataConfig) -> mailwoman_mtf.CharEncoder | None:
    """The char path's encoder (#825 / v8 CJK), or None for the SentencePiece path."""
    if not check_char_mode(cfg_data):
        return None
    label_set = require_label_set_supported(cfg_data, True)
    return mailwoman_mtf.CharEncoder(
        mode=cfg_data.char_mode,
        vocab_path=str(cfg_data.char_vocab_path),
        max_units=int(getattr(cfg_data, "max_units", None) or cfg_data.max_length),
        max_unit_width=int(getattr(cfg_data, "max_unit_width", 16)),
        char_ctx=int(getattr(cfg_data, "char_ctx", 0)),
        label_set=label_set.name,
        tags=list(label_set.tags),
        bio_labels=list(label_set.bio_labels),
        ignore_index=IGNORE_INDEX,
    )


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
    require_label_set_supported(cfg_data, False)
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


def iter_sampled_rows(
    cfg_data: DataConfig,
    split: str,
    *,
    seed: int,
    row_limit: int | None = None,
    observer: Callable[[dict[str, Any]], None] | None = None,
    drop_spans: bool = False,
) -> Iterator[dict[str, Any]]:
    """The rows the loader encodes, in sampler order, with the astral-offset rows skipped.

    The sampler draws from a generator seeded as `random.Random(seed)`, so the rows equal the Python sampler's for the
    same seed. `row_limit` counts the rows before the astral skip. `observer` sees each yielded row as it is yielded,
    so it sees exactly the rows encoded.
    """
    sampler = mailwoman_mtf.Sampler(sampler_config(cfg_data, drop_spans=drop_spans), split, seed, row_limit)
    for row in sampler:
        if observer is not None:
            observer(row)
        yield row


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
    seed: int = 0,
    row_limit: int | None = None,
    observer: Callable[[dict[str, Any]], None] | None = None,
) -> Iterator[EncodedExample]:
    """Yield one encoded example per sampled row, for a tool that reads rows one at a time.

    The SentencePiece path builds its row encoder once for the stream. The training loop reads `iter_batches`
    instead, which encodes whole batches with the encoder the process built. ``tokenizer`` may be None only when
    ``cfg_data.char_mode != "off"``, because the char path never touches SentencePiece.
    """
    char = build_char_encoder(cfg_data)
    require_label_set_supported(cfg_data, char is not None)
    encoder: mailwoman_mtf.RowEncoder | mailwoman_mtf.CharEncoder
    if char is not None:
        encoder = char
    elif tokenizer is None:
        raise ValueError("the SentencePiece path requires a tokenizer")
    else:
        encoder = build_row_encoder(cfg_data, tokenizer)
    for row in iter_sampled_rows(cfg_data, split, seed=seed, row_limit=row_limit, observer=observer):
        yield example_from_batch(encoder.encode_batch([row]), row)
