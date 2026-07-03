"""#900 — the splice codepoint-overlap safety gate.

The v5.1.0 finding: "byte-identical by construction" was ASCII-only; FR/DE/ES shared codepoints
with the spliced pieces and 52/15k EU rows re-tokenized, measured only after the fact. The gate
must (a) report per-locale overlap, (b) fail loud on unaccepted overlap, (c) pass when overlap
is either absent or explicitly accepted (= a pre-registered ni leg per CONTRIBUTING).
"""

import json
from pathlib import Path

import pytest

from mailwoman_train.tokenizer_splice import collect_sample_codepoints, gate_codepoint_overlap


@pytest.fixture()
def samples(tmp_path: Path) -> dict[str, Path]:
    fr = tmp_path / "fr.jsonl"
    fr.write_text('{"raw": "12 Rue de la Lozère, Paris"}\n', encoding="utf-8")
    us = tmp_path / "us.jsonl"
    us.write_text('{"raw": "350 Fifth Avenue, New York, NY 10118"}\n', encoding="utf-8")
    return {"fr": fr, "us": us}


def test_collect_sample_codepoints_nonascii_only(samples: dict[str, Path]) -> None:
    assert collect_sample_codepoints(samples["us"]) == set()
    assert "è" in collect_sample_codepoints(samples["fr"])


def test_gate_passes_and_reports_when_disjoint(tmp_path: Path, samples: dict[str, Path]) -> None:
    report_path = tmp_path / "report.json"
    # ą/ż do not appear in either sample → disjoint → PASS, empty overlaps in the report.
    report = gate_codepoint_overlap(["▁Grudzi", "ądz", "ż"], samples, report_path)
    assert report == {"fr": [], "us": []}
    on_disk = json.loads(report_path.read_text(encoding="utf-8"))
    assert on_disk["per_locale_overlap"] == {"fr": [], "us": []}


def test_gate_fails_loud_on_unaccepted_overlap(tmp_path: Path, samples: dict[str, Path]) -> None:
    report_path = tmp_path / "report.json"
    with pytest.raises(AssertionError, match=r"\bfr\b"):
        gate_codepoint_overlap(["▁Lozère", "è"], samples, report_path)
    # The report is still written before the raise — the artifact is the point.
    assert json.loads(report_path.read_text(encoding="utf-8"))["per_locale_overlap"]["fr"] == ["è"]


def test_gate_passes_when_overlap_accepted(tmp_path: Path, samples: dict[str, Path]) -> None:
    report_path = tmp_path / "report.json"
    report = gate_codepoint_overlap(["▁Lozère", "è"], samples, report_path, accepted_overlap={"fr"})
    assert report["fr"] == ["è"]
    assert json.loads(report_path.read_text(encoding="utf-8"))["accepted_overlap"] == ["fr"]
