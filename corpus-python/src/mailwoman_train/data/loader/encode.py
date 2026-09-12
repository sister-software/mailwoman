"""One corpus row to one `EncodedExample`, through SentencePiece or the char path.

Everything a channel needs is loaded ONCE here, before the row loop, and passed to every
`encode_row` call. The two paths are exclusive: the char path skips SentencePiece entirely,
requires span-schema slices, and refuses a configured channel, because the channels project per
SentencePiece piece and have no per-unit alignment yet.
"""

from __future__ import annotations

import logging
import random
from collections.abc import Iterator
from pathlib import Path

from ...config import DataConfig
from ...labels import locale_id, resolve_label_set
from ...tokenizer import Tokenizer, char_label_array_from_spans, encode_row, whitespace_spans
from ...tokenizer.char import encode_row_units, load_char_vocab
from ..relabel import AffixRelabelLexicon
from .anchors import load_anchor_lookup
from .example import EncodedExample
from .stream import iter_rows

logger = logging.getLogger(__name__)


def iter_encoded(
    cfg_data: DataConfig,
    tokenizer: Tokenizer | None,
    *,
    split: str = "train",
    rng: random.Random | None = None,
    row_limit: int | None = None,
) -> Iterator[EncodedExample]:
    """Yield encoded examples, dropping rows whose SP token count exceeds ``max_length``.

    Length-filter rationale: address text is short by nature; long rows are usually adapter
    bugs (per Phase 2 §2.3). Cap at the model's ``max_position_embeddings``.

    ``tokenizer`` may be None ONLY when ``cfg_data.char_mode != "off"`` — the char path never
    touches SentencePiece.
    """
    rng = rng or random.Random(0)
    # CharCNN input path (#825 / v8 CJK). When char_mode != "off" the loop below skips SentencePiece
    # entirely and encodes per-unit char windows (encode_row_units). The mode is channel-free by
    # contract — the channels project per SP-piece and get a per-unit re-alignment post-probe — so a
    # configured channel path alongside char_mode is a config mistake, raised loudly here.
    char_mode = getattr(cfg_data, "char_mode", "off")
    if char_mode not in ("off", "word", "char"):
        raise ValueError(f"unknown data.char_mode {char_mode!r} (expected off | word | char)")
    char_vocab = None
    if char_mode != "off":
        char_vocab_path = getattr(cfg_data, "char_vocab_path", None)
        if not char_vocab_path:
            raise ValueError("data.char_mode requires data.char_vocab_path (build_char_vocab's sealed JSON)")
        channel_paths = [
            name
            for name in (
                "anchor_lookup_path",
                "gazetteer_lexicon_path",
                "country_lexicon_path",
                "street_type_lexicon_path",
                "locality_surface_lexicon_path",
            )
            if getattr(cfg_data, name, None)
        ]
        if channel_paths:
            raise ValueError(
                f"data.char_mode is channel-free (channels re-align per-unit post-probe, v8 CJK plan): "
                f"unset {channel_paths}"
            )
        char_ctx = int(getattr(cfg_data, "char_ctx", 0))
        max_unit_width = int(getattr(cfg_data, "max_unit_width", 16))
        if char_mode == "char" and max_unit_width < 2 * char_ctx + 1:
            raise ValueError(
                f"data.max_unit_width={max_unit_width} truncates the char window: char_mode=char with "
                f"char_ctx={char_ctx} needs W >= {2 * char_ctx + 1}"
            )
        max_units = int(getattr(cfg_data, "max_units", None) or cfg_data.max_length)
        char_vocab = load_char_vocab(char_vocab_path)
    # Label vocabulary (v8 CJK Phase 2): non-default sets are threaded through the CHAR path only.
    # The SP path still encodes against the module-global STAGE3 maps, so a non-default set there
    # would silently mislabel — raise instead (the #1349 lesson: silent label-space mismatches).
    label_set = resolve_label_set(getattr(cfg_data, "label_set", "stage3"))
    if label_set.name != "stage3" and char_mode == "off":
        raise ValueError(f"data.label_set={label_set.name!r} is only supported with data.char_mode != 'off'")
    # Postcode-anchor lookup (#239/#240): loaded once, passed to every encode_row. None → no anchor
    # features produced (back-compat). See load_anchor_lookup.
    anchor_lookup = load_anchor_lookup(cfg_data.anchor_lookup_path) if cfg_data.anchor_lookup_path else None
    # Gazetteer-anchor lexicon (#464): loaded once. None → no gazetteer features (back-compat).
    gazetteer_lexicon = None
    gazetteer_path = getattr(cfg_data, "gazetteer_lexicon_path", None)
    if gazetteer_path:
        from ...features.gazetteer_anchor import load_gazetteer_lexicon

        gazetteer_lexicon = load_gazetteer_lexicon(gazetteer_path)
    # Country-lexicon (#1104): loaded once. None → no country features (back-compat).
    country_lexicon = None
    country_path = getattr(cfg_data, "country_lexicon_path", None)
    if country_path:
        from ...features.country_lexicon import load_country_lexicon

        country_lexicon = load_country_lexicon(country_path)
    # Street-type lexicon (P-A / Option A): same JSON schema as the gazetteer lexicon, so it reuses
    # load_gazetteer_lexicon. None → no street-type features (back-compat).
    street_type_lexicon = None
    street_type_path = getattr(cfg_data, "street_type_lexicon_path", None)
    if street_type_path:
        from ...features.gazetteer_anchor import load_gazetteer_lexicon

        street_type_lexicon = load_gazetteer_lexicon(street_type_path)
    # Locality-surface lexicon (v3.16.0): same JSON schema → same loader.
    locality_surface_lexicon = None
    locality_path = getattr(cfg_data, "locality_surface_lexicon_path", None)
    if locality_path:
        from ...features.gazetteer_anchor import load_gazetteer_lexicon

        locality_surface_lexicon = load_gazetteer_lexicon(locality_path)
    affix_relabel_lexicon = None
    affix_path = getattr(cfg_data, "affix_relabel_lexicon_path", None)
    if affix_path:
        affix_relabel_lexicon = AffixRelabelLexicon.load(affix_path)
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
        augment_case_prob=getattr(cfg_data, "augment_case_prob", 0.0),
        augment_punct_drop_prob=getattr(cfg_data, "augment_punct_drop_prob", 0.0),
        augment_upper_case_prob=getattr(cfg_data, "augment_upper_case_prob", 0.0),
        augment_ordinal_prob=getattr(cfg_data, "augment_ordinal_prob", 0.0),
        augment_exclude_sources=getattr(cfg_data, "augment_exclude_sources", ()),
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
        if char_vocab is not None:
            # CharCNN path: span-schema is REQUIRED — the per-char label array comes straight from
            # the span triple (no whitespace-token quantization), and a token-only frozen slice has
            # no honest char-level labels to offer. Loud failure, never a silent fallback (#519).
            starts, ends, tags = row.get("span_starts"), row.get("span_ends"), row.get("span_tags")
            if starts is None or ends is None or tags is None:
                raise ValueError(
                    f"data.char_mode={char_mode} requires span-schema slices (v0.5.0 #519); "
                    f"got a token-only row: {row['raw'][:60]!r}"
                )
            raw = row["raw"]
            char_labels = char_label_array_from_spans(raw, starts, ends, tags)
            if char_mode == "char":
                # One unit per character (D3): unit index == char offset, whitespace units carry O.
                unit_spans = [(i, i + 1) for i in range(len(raw))]
            else:
                unit_spans = whitespace_spans(raw, row["tokens"])
            enc = encode_row_units(
                raw,
                unit_spans,
                char_labels,
                char_vocab,
                max_units=max_units,
                max_unit_width=max_unit_width,
                ctx_chars=char_ctx,
                label_to_id=label_set.label_to_id,
                collapse=label_set.collapse_label,
            )
            yield EncodedExample(
                # Dummy pad row — the model's use_char_embed branch derives (B, S) from char_ids
                # and never reads input_ids; the constant row keeps collate/_to_tensor_batch uniform.
                input_ids=[0] * len(enc["attention_mask"]),
                attention_mask=enc["attention_mask"],
                labels=enc["labels"],
                locale_id=locale_id(row.get("country")),
                char_ids=enc["char_ids"],
            )
            continue
        if tokenizer is None:
            raise ValueError("the SentencePiece path requires a tokenizer")
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
            country_lexicon=country_lexicon,
            street_type_lexicon=street_type_lexicon,
            locality_surface_lexicon=locality_surface_lexicon,
            # v0.5.0 char-offset labels (#519): rows from a span-schema slice train FROM the
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
            country_features=enc.get("country_features"),
            country_confidence=enc.get("country_confidence"),
            street_type_features=enc.get("street_type_features"),
            street_type_confidence=enc.get("street_type_confidence"),
            locality_surface_features=enc.get("locality_surface_features"),
            locality_surface_confidence=enc.get("locality_surface_confidence"),
        )
