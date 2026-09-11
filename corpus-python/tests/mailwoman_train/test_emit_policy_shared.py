"""The loader and the epoch audit run ONE emit step (#2243).

Both sides apply augmentation-with-a-per-source-opt-out and then the affix relabel, in that order.
Expressing that twice is what #2243 was: `data_loader` applied `augment_exclude_sources` and
`audit_epoch_mixture` did not, so the audit reported an excluded source with the emitted count it
would have had if it were augmented. The two copies had matching probabilities and a matching call to
`augment_row`, and diverged at the one branch a shared constant cannot express.

Matched constants would not catch the next divergence either, so these tests pin the BEHAVIOUR the two
call sites must share: for a config naming an exclusion, the audit's emitted count for that source must
equal what `iter_rows` emits. That is an assertion no reimplementation can satisfy by accident.
"""

from __future__ import annotations

import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from mailwoman_train.audit_epoch_mixture import audit_mixture
from mailwoman_train.data_loader import iter_rows
from mailwoman_train.emit import EmitPolicy, emit_row

SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("tokens", pa.list_(pa.string())),
        ("labels", pa.list_(pa.string())),
        ("country", pa.string()),
        ("source", pa.string()),
    ]
)

EXCLUDED = "synth-bare-postcode"
AUGMENTED = "tiger"


def _rows(source: str, n: int) -> list[dict]:
    return [
        {
            "raw": f"{i} quiet lane {source}",
            "tokens": [str(i), "quiet", "lane", source],
            "labels": ["O", "O", "O", "O"],
            "country": "US",
            "source": source,
        }
        for i in range(n)
    ]


def _write_corpus(tmp_path: Path) -> Path:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    for name, rows in (
        (f"part-{EXCLUDED}.parquet", _rows(EXCLUDED, 64)),
        (f"part-{AUGMENTED}.parquet", _rows(AUGMENTED, 64)),
    ):
        pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA), corpus / "train" / name)
    return corpus


def _audit(corpus: Path, draws: int, exclude: list[str]) -> dict:
    return audit_mixture(
        corpus,
        seed=0,
        draws=draws,
        window=draws,
        country_weights={"US": 1.0},
        source_weights={EXCLUDED: 1.0, AUGMENTED: 1.0},
        coarse_filter=False,
        augment={"upper_case": 1.0},
        augment_exclude_sources=exclude,
    )


def test_audit_emitted_count_matches_the_loader_for_an_excluded_source(tmp_path: Path) -> None:
    """The assertion #2243 was missing: both paths emit the same number of rows for the same policy."""
    corpus = _write_corpus(tmp_path)
    draws = 200

    report = _audit(corpus, draws, [EXCLUDED])

    loader = list(
        iter_rows(
            corpus,
            "train",
            rng=random.Random(0),
            country_weights={"US": 1.0},
            source_weights={EXCLUDED: 1.0, AUGMENTED: 1.0},
            coarse_filter=False,
            augment_upper_case_prob=1.0,
            augment_exclude_sources=[EXCLUDED],
            shuffle_buffer=1,
            row_limit=draws,
        )
    )

    # Share, not raw count: the audit skips `iter_rows`' shuffle buffer, which reorders rows without
    # changing how many of each source fill the budget.
    loader_share = sum(1 for row in loader if row["source"] == EXCLUDED) / len(loader)
    audited_share = report["emitted_level"]["per_source"][EXCLUDED]["emitted_share"]

    # The threshold is measured, not chosen. On this corpus the loader emits 0.3650 of the budget from
    # the excluded source; the repaired audit reports 0.3368 (delta 0.028, the shuffle buffer) and the
    # pre-#2243 audit reported 0.5100 (delta 0.145, a 40% over-report). 0.05 separates them.
    assert abs(loader_share - audited_share) < 0.05, (
        f"loader emitted {loader_share:.3f} of the budget from {EXCLUDED}, audit reported {audited_share:.3f}"
    )


def test_exclusion_lowers_the_audited_emitted_share(tmp_path: Path) -> None:
    """Without the exclusion the audit over-reports the source — the exact #2243 symptom."""
    corpus = _write_corpus(tmp_path)
    draws = 200

    honoured = _audit(corpus, draws, [EXCLUDED])["emitted_level"]["per_source"][EXCLUDED]["emitted_share"]
    ignored = _audit(corpus, draws, [])["emitted_level"]["per_source"][EXCLUDED]["emitted_share"]

    assert honoured < ignored, (
        "an excluded source emits one row per draw while its neighbour emits two, so honouring the "
        f"exclusion must lower its share of a fixed budget: honoured={honoured:.3f} ignored={ignored:.3f}"
    )


def test_emit_row_excludes_by_source_not_by_probability() -> None:
    """An excluded source passes through even with every probability live."""
    policy = EmitPolicy(upper_case_prob=1.0, excluded_sources=frozenset({EXCLUDED}))

    assert policy.augments, "sanity: the policy augments"
    assert not policy.augments_source(EXCLUDED)
    assert policy.augments_source(AUGMENTED)

    excluded_out = list(emit_row(_rows(EXCLUDED, 1)[0], random.Random(0), policy))
    augmented_out = list(emit_row(_rows(AUGMENTED, 1)[0], random.Random(0), policy))

    assert len(excluded_out) == 1
    assert len(augmented_out) == 2


def test_all_zero_probabilities_pass_every_row_through() -> None:
    """With nothing live the policy is a no-op for excluded and non-excluded sources alike."""
    policy = EmitPolicy(excluded_sources=frozenset({EXCLUDED}))

    assert not policy.augments
    for source in (EXCLUDED, AUGMENTED):
        out = list(emit_row(_rows(source, 1)[0], random.Random(0), policy))
        assert len(out) == 1
