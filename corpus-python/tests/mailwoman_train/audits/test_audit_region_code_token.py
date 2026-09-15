from mailwoman_train.audits.region_code_token import audit_rows, code_shaped, contested


def _row(tokens: list[str], labels: list[str]) -> dict:
    return {"raw": " ".join(tokens), "tokens": tokens, "labels": labels, "country": "CA", "source": "test"}


def test_code_shaped_admits_only_a_two_letter_uppercase_token() -> None:
    assert code_shaped("NL")
    assert not code_shaped("nl")
    assert not code_shaped("NLD")
    assert not code_shaped("N1")
    assert not code_shaped("ÉÉ")


def test_a_code_is_counted_under_the_tag_it_opens() -> None:
    rows = [
        _row(
            ["Gander,", "NL", "A1V", "0A9,", "Canada"],
            ["B-locality", "B-region", "B-postcode", "I-postcode", "B-country"],
        ),
        _row(["Amsterdam,", "NL"], ["B-locality", "B-country"]),
    ]

    counts = audit_rows(rows)

    assert counts["NL"] == {"region": 1, "country": 1}


def test_a_code_inside_a_longer_span_is_not_an_attestation() -> None:
    # `NL` continuing a venue name says nothing about what the token means alone, and counting it would
    # credit the same evidence to two readings.
    rows = [_row(["Cafe", "NL"], ["B-venue", "I-venue"])]

    assert audit_rows(rows) == {}


def test_contested_lists_only_codes_carrying_both_readings_worst_first() -> None:
    rows = [
        *[_row(["Amsterdam,", "NL"], ["B-locality", "B-country"]) for _ in range(10)],
        _row(["Gander,", "NL"], ["B-locality", "B-region"]),
        *[_row(["Lima,", "PE"], ["B-locality", "B-country"]) for _ in range(2)],
        _row(["Charlottetown,", "PE"], ["B-locality", "B-region"]),
        _row(["Vancouver,", "BC"], ["B-locality", "B-region"]),
    ]

    assert contested(audit_rows(rows)) == [("NL", 10, 1), ("PE", 2, 1)]
