"""Assemble the batches the trainer feeds the model.

The SentencePiece path hands each batch of sampled rows to the row encoder, which returns `[B, L]` and
`[B, L, D]` arrays, and adds each row's locale and address-system ids in row order. The char path stacks one
`EncodedExample` per row with `collate`. A channel is present in a batch only when its lexicon is configured. An
absent channel is omitted rather than zero-filled, so the trainer's tensor conversion skips it and the model runs
without it.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Iterator
from typing import Any

import mailwoman_mtf

from ...address_systems import address_system_id
from ...config import Config
from ...labels import locale_id
from .encode import iter_encoded, iter_sampled_rows, require_label_set_supported, resolve_char_mode
from .example import EncodedExample


def collate(batch: list[EncodedExample]) -> dict[str, Any]:
    """Stack a list of ``EncodedExample`` into batched lists. Caller wraps in torch tensors."""
    out = {
        "input_ids": [ex.input_ids for ex in batch],
        "attention_mask": [ex.attention_mask for ex in batch],
        "labels": [ex.labels for ex in batch],
        "locale_ids": [ex.locale_id for ex in batch],
        "address_system_ids": [ex.address_system_id for ex in batch],
    }
    for channel in mailwoman_mtf.CHANNEL_NAMES:
        if batch and getattr(batch[0], f"{channel}_features") is not None:
            out[f"{channel}_features"] = [getattr(ex, f"{channel}_features") for ex in batch]
            out[f"{channel}_confidence"] = [getattr(ex, f"{channel}_confidence") for ex in batch]
    # CharCNN input path (#825 / v8 CJK): same presence interface — set iff char_mode != "off".
    if batch and batch[0].char_ids is not None:
        out["char_ids"] = [ex.char_ids for ex in batch]
    return out


def encode_rows(encoder: mailwoman_mtf.RowEncoder, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """One batch from the row encoder, with each row's locale and address-system ids in row order."""
    out: dict[str, Any] = dict(encoder.encode_batch(rows))
    out["locale_ids"] = [locale_id(row.get("country")) for row in rows]
    out["address_system_ids"] = [address_system_id(row.get("country"), row["raw"]) for row in rows]
    return out


def iter_batches(
    cfg: Config,
    encoder: mailwoman_mtf.RowEncoder | None,
    *,
    split: str,
    batch_size: int,
    seed: int = 0,
    row_limit: int | None = None,
    observer: Callable[[dict[str, Any]], None] | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield batches until the sampled rows run out.

    ``encoder`` is the row encoder the process built with `build_row_encoder`, or None on the char path.
    ``observer`` receives each source row of a batch once the consumer asks for the batch after it, so a batch
    fetched and then abandoned (the loop breaking at ``max_steps``) is never observed.
    """
    rng = random.Random(seed)
    char = resolve_char_mode(cfg.data)
    rows: list[dict[str, Any]] = []
    if char is not None:
        buf: list[EncodedExample] = []
        for ex in iter_encoded(
            cfg.data, None, split=split, rng=rng, row_limit=row_limit, observer=rows.append if observer else None
        ):
            buf.append(ex)
            if len(buf) == batch_size:
                batch_rows = rows[:]
                rows.clear()
                yield collate(buf)
                buf = []
                if observer:
                    for row in batch_rows:
                        observer(row)
        if buf:
            yield collate(buf)
            if observer:
                for row in rows:
                    observer(row)
        return

    require_label_set_supported(cfg.data, char)
    if encoder is None:
        raise ValueError("the SentencePiece path requires a row encoder (build_row_encoder)")
    for row in iter_sampled_rows(cfg.data, split, rng=rng, row_limit=row_limit):
        rows.append(row)
        if len(rows) == batch_size:
            batch_rows, rows = rows, []
            yield encode_rows(encoder, batch_rows)
            if observer:
                for observed in batch_rows:
                    observer(observed)
    if rows:
        yield encode_rows(encoder, rows)
        if observer:
            for observed in rows:
                observer(observed)
