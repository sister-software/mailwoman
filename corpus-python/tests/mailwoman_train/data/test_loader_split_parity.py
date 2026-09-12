"""The loader split must not move a single row, in value or in order.

Every stage of this pipeline draws from one `random.Random`: the slice order, the row-group order,
the row order inside a group, the country-acceptance test, the source multinomial, the shuffle
buffer, and each augmentation. They share a stream, so a split that reorders two calls — or adds a
draw, or skips one — reshuffles the corpus a run trains on while every existing test still passes:
the suite asserts that rows are well-formed and that mixtures are stationary, not that a seeded run
yields these rows in this order.

So this pins the sequence. `iter_rows` carries the sampling; the char path carries `iter_encoded`
end to end without a SentencePiece artifact; `source_row_counts` carries the metadata reader that
the dose audit reads.
"""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.config import DataConfig
from mailwoman_train.data.loader import collate, iter_encoded, iter_rows, source_row_counts
from mailwoman_train.tokenizer.char import build_char_vocab, save_char_vocab

#: Committed beside this file, captured from the code as it stood BEFORE a split. Regenerating it
#: after a change makes the test compare the new code against itself, so regenerate only when the
#: current code is already verified against the existing reference.
#:
#: Regenerate with: uv run python tests/mailwoman_train/data/test_loader_split_parity.py
REFERENCE = Path(__file__).parent / "loader-split-reference.json"

#: Written into the artifact so a reader meets it there rather than here.
REFERENCE_README = [
    "Pins the streaming loader's sampled output across a refactor.",
    "Regenerate: uv run python tests/mailwoman_train/data/test_loader_split_parity.py",
    "Fixture: build_reference_corpus() in the test beside this file — two sources, three",
    "  countries, unequal country and source weights, multiple row groups per slice, and every",
    "  augmentation on, so every consumer of the shared RNG stream is live.",
    "",
    "rows: one seeded pass of iter_rows over the train split, each row as source|country|raw.",
    "  The ORDER is the assertion. A reordered or added draw reshuffles this and nothing else.",
    "val_rows: the same over the val split, which takes the other branch of _raw_row_stream —",
    "  no source bucketing, and train-only policy neutralized.",
    "encoded: one seeded pass of iter_encoded on the char path, as labels + attention per row.",
    "source_row_counts: rows per source read from parquet footers, what the dose audit reads.",
    "collate_keys: the batch keys collate emits for those examples.",
]

SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("tokens", pa.list_(pa.string())),
        ("labels", pa.list_(pa.string())),
        ("country", pa.string()),
        ("source", pa.string()),
        ("span_starts", pa.list_(pa.int32())),
        ("span_ends", pa.list_(pa.int32())),
        ("span_tags", pa.list_(pa.string())),
    ]
)

#: Each entry is (raw, [(token, tag)]) — spans and BIO labels are derived from the pairs, so the
#: fixture cannot carry an offset that disagrees with its own text.
TEMPLATES: list[tuple[str, list[tuple[str, str]]]] = [
    (
        "{n} N Main St, Springfield IL 62704",
        [
            ("{n}", "house_number"),
            ("N", "street_prefix"),
            ("Main", "street"),
            ("St,", "street_suffix"),
            ("Springfield", "locality"),
            ("IL", "region"),
            ("62704", "postcode"),
        ],
    ),
    (
        "{n} Rue de la Paix, 75002 Paris",
        [
            ("{n}", "house_number"),
            ("Rue", "street"),
            ("de", "street"),
            ("la", "street"),
            ("Paix,", "street"),
            ("75002", "postcode"),
            ("Paris", "locality"),
        ],
    ),
    (
        "Flat {n}, 12 High Street, London SW1A 2AA",
        [
            ("Flat", "unit"),
            ("{n},", "unit"),
            ("12", "house_number"),
            ("High", "street"),
            ("Street,", "street"),
            ("London", "locality"),
            ("SW1A", "postcode"),
            ("2AA", "postcode"),
        ],
    ),
]


def _row(index: int, country: str, source: str) -> dict[str, Any]:
    """One corpus row, with its span triple derived from the text rather than typed beside it."""
    template, pairs = TEMPLATES[index % len(TEMPLATES)]
    number = str(100 + index)
    raw = template.format(n=number)
    tokens = [token.format(n=number) for token, _ in pairs]
    tags = [tag for _, tag in pairs]

    labels: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    span_tags: list[str] = []
    cursor = 0
    previous: str | None = None
    for token, tag in zip(tokens, tags, strict=True):
        start = raw.index(token, cursor)
        cursor = start + len(token)
        labels.append(f"{'I' if tag == previous else 'B'}-{tag}")
        starts.append(start)
        ends.append(cursor)
        span_tags.append(tag)
        previous = tag

    return {
        "raw": raw,
        "tokens": tokens,
        "labels": labels,
        "country": country,
        "source": source,
        "span_starts": starts,
        "span_ends": ends,
        "span_tags": span_tags,
    }


def build_reference_corpus(root: Path) -> Path:
    """A corpus with enough variety that every filter and every RNG consumer is live.

    Two sources so the multinomial runs; three countries with unequal weights so the acceptance
    test both passes and fails; several row groups per slice so the row-group shuffle has
    something to permute; a mixed-source val slice because the held-out branch bypasses the
    source bucketing entirely and a single-source one would not tell the branches apart.
    """
    corpus = root / "corpus"
    (corpus / "train").mkdir(parents=True)
    (corpus / "val").mkdir(parents=True)

    countries = ("US", "FR", "GB")
    alpha = [_row(i, countries[i % 3], "alpha") for i in range(48)]
    beta = [_row(i, countries[(i + 1) % 3], "beta") for i in range(24)]
    held_out = [_row(i, countries[i % 3], "alpha" if i % 2 else "beta") for i in range(12)]

    for name, rows in (
        ("train/part-alpha-0.parquet", alpha[:24]),
        ("train/part-alpha-1.parquet", alpha[24:]),
        ("train/part-beta-0.parquet", beta),
        ("val/part-val-0.parquet", held_out),
    ):
        pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA), corpus / name, row_group_size=8)
    return corpus


COUNTRY_WEIGHTS = {"US": 1.0, "FR": 0.6, "GB": 0.25}
SOURCE_WEIGHTS = {"alpha": 3.0, "beta": 1.0}

AUGMENTATION = {
    "augment_directional_prob": 0.5,
    "augment_region_prob": 0.5,
    "augment_glue_prob": 0.3,
    "augment_case_prob": 0.3,
    "augment_punct_drop_prob": 0.3,
    "augment_upper_case_prob": 0.2,
    "augment_ordinal_prob": 0.2,
}


def reference_rows(corpus: Path, split: str = "train") -> list[str]:
    """One seeded pass of `iter_rows`, as `source|country|raw` in emission order."""
    stream = iter_rows(
        corpus,
        split,
        rng=random.Random(11),
        country_weights=COUNTRY_WEIGHTS,
        source_weights=SOURCE_WEIGHTS,
        coarse_filter=False,
        shuffle_buffer=6,
        **AUGMENTATION,
    )
    return [f"{row['source']}|{row['country']}|{row['raw']}" for row in stream]


def reference_config(corpus: Path, vocab_path: Path) -> DataConfig:
    """The char path: `iter_encoded` end to end with no SentencePiece artifact to ship."""
    return DataConfig(
        corpus_dir=str(corpus),
        max_length=64,
        country_weights=COUNTRY_WEIGHTS,
        source_weights=SOURCE_WEIGHTS,
        coarse_filter=False,
        char_mode="word",
        char_vocab_path=str(vocab_path),
        max_units=24,
        max_unit_width=12,
        **AUGMENTATION,
    )


def reference_encoded(corpus: Path, vocab_path: Path) -> list[dict[str, Any]]:
    """One seeded pass of `iter_encoded`, as the fields a training step reads."""
    examples = iter_encoded(
        reference_config(corpus, vocab_path),
        tokenizer=None,
        split="train",
        rng=random.Random(11),
    )
    return [
        {
            "labels": ex.labels,
            "attention_mask": ex.attention_mask,
            "locale_id": ex.locale_id,
            "char_ids": ex.char_ids[:3] if ex.char_ids else None,
        }
        for ex in examples
    ]


def write_char_vocab(corpus: Path, root: Path) -> Path:
    """A vocab over every character the fixture can produce, so no row encodes as unknown."""
    texts = [template for template, _ in TEMPLATES]
    vocab_path = root / "char-vocab.json"
    save_char_vocab(
        build_char_vocab([*texts, "0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz,."]), vocab_path
    )
    return vocab_path


@pytest.fixture
def corpus(tmp_path: Path) -> Path:
    return build_reference_corpus(tmp_path)


def test_the_stream_is_deterministic_under_a_fixed_seed(corpus: Path) -> None:
    """Sanity: the fixture is reproducible, so a later mismatch means the code moved."""
    assert reference_rows(corpus) == reference_rows(corpus)


def test_rows_match_the_committed_reference(corpus: Path) -> None:
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text())["rows"]
    actual = reference_rows(corpus)

    assert len(actual) == len(expected), "the row count changed — a filter or an epoch bound moved"
    drifted = [i for i, (got, want) in enumerate(zip(actual, expected, strict=True)) if got != want]
    assert drifted == [], f"{len(drifted)} rows moved, starting at index {drifted[0]}: {actual[drifted[0]]!r}"


def test_held_out_rows_match_the_committed_reference(corpus: Path) -> None:
    """The val branch bypasses source bucketing and neutralizes every train-only policy."""
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text())["val_rows"]
    assert reference_rows(corpus, "val") == expected


def test_encoded_examples_match_the_committed_reference(corpus: Path, tmp_path: Path) -> None:
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text())["encoded"]
    actual = reference_encoded(corpus, write_char_vocab(corpus, tmp_path))

    assert len(actual) == len(expected), "the encoded count changed"
    drifted = [i for i, (got, want) in enumerate(zip(actual, expected, strict=True)) if got != want]
    assert drifted == [], f"{len(drifted)} encoded examples moved, starting at index {drifted[0]}"


def test_source_row_counts_match_the_committed_reference(corpus: Path) -> None:
    """Metadata-only, so it shares no RNG — but it shares the path resolution and the source read."""
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text())["source_row_counts"]
    assert source_row_counts(corpus, "train") == expected


def test_collate_keys_match_the_committed_reference(corpus: Path, tmp_path: Path) -> None:
    """A channel dropped from `collate` reaches the model as an absent tensor, not an error."""
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text())["collate_keys"]
    examples = list(
        iter_encoded(
            reference_config(corpus, write_char_vocab(corpus, tmp_path)),
            tokenizer=None,
            split="train",
            rng=random.Random(11),
        )
    )
    assert sorted(collate(examples[:4])) == expected


def write_reference() -> None:
    """Capture the current loader as the reference the tests above compare against.

    Run this only when the current code already passes against the existing reference — otherwise
    the artifact records whatever the code does now, and the tests assert nothing.
    """
    import tempfile

    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        corpus = build_reference_corpus(root)
        vocab_path = write_char_vocab(corpus, root)
        examples = list(
            iter_encoded(
                reference_config(corpus, vocab_path),
                tokenizer=None,
                split="train",
                rng=random.Random(11),
            )
        )
        payload = {
            "README": REFERENCE_README,
            "rows": reference_rows(corpus),
            "val_rows": reference_rows(corpus, "val"),
            "encoded": reference_encoded(corpus, vocab_path),
            "source_row_counts": source_row_counts(corpus, "train"),
            "collate_keys": sorted(collate(examples[:4])),
        }
    REFERENCE.write_text(json.dumps(payload, indent="\t", sort_keys=False) + "\n")
    print(f"wrote {REFERENCE}")
    print(f"  {len(payload['rows'])} train rows, {len(payload['val_rows'])} val rows")
    print(f"  {len(payload['encoded'])} encoded examples, counts={payload['source_row_counts']}")


if __name__ == "__main__":
    write_reference()
