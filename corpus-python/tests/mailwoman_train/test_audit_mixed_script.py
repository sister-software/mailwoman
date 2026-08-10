from mailwoman_train.audit_mixed_script import audit_rows, gold_components, script_runs


def _row(raw: str, spans: list[tuple[int, int, str]], *, country: str = "GB") -> dict:
    return {
        "raw": raw,
        "tokens": raw.split(),
        "labels": ["O"] * len(raw.split()),
        "span_starts": [start for start, _, _ in spans],
        "span_ends": [end for _, end, _ in spans],
        "span_tags": [tag for _, _, tag in spans],
        "country": country,
        "source": "test",
    }


def test_script_runs_detect_transition_inside_venue() -> None:
    assert script_runs("Four Seasons Inn四季酒家") == ["Latin", "Han"]
    assert script_runs("L'oscar") == ["Latin"]
    assert script_runs("Champs-Élysées") == ["Latin"]
    assert script_runs("Formación 1º de Mayo") == ["Latin"]


def test_audit_separates_cross_component_from_within_component_mix() -> None:
    rows = [
        _row("Rinrin 高山市", [(0, 6, "venue"), (7, 10, "locality")], country="JP"),
        _row("Four Seasons Inn四季酒家", [(0, 20, "venue")]),
    ]
    report = audit_rows(rows)
    assert report["totals"]["rows_with_multiple_scripts"] == 2
    assert report["totals"]["rows_with_mixed_component"] == 1
    assert report["totals"]["rows_cross_component_only"] == 1
    assert report["by_tag"]["venue"]["mixed_components"] == 1
    assert report["by_tag"]["venue"]["transition:Latin->Han"] == 1


def test_gold_components_honors_utf16_offsets_around_astral_characters() -> None:
    row = _row("🍜四季酒家", [(0, 6, "venue")], country="JP")
    assert list(gold_components(row)) == [("venue", "🍜四季酒家")]


def test_legacy_bio_rows_are_auditable() -> None:
    row = {
        "raw": "JJAN 짠 Paris",
        "tokens": ["JJAN", "짠", "Paris"],
        "labels": ["B-venue", "I-venue", "B-locality"],
        "country": "FR",
        "source": "test",
    }
    report = audit_rows([row])
    assert report["totals"]["legacy_bio_rows"] == 1
    assert report["by_tag"]["venue"]["transition:Latin->Hangul"] == 1
