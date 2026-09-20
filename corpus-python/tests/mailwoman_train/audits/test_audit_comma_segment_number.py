from mailwoman_train.audits.comma_segment_number import audit_rows, isolated_positions


def _row(tokens: list[str], labels: list[str]) -> dict:
    return {"raw": " ".join(tokens), "tokens": tokens, "labels": labels, "country": "US", "source": "test"}


def test_a_number_alone_between_commas_is_isolated() -> None:
    assert isolated_positions(["301", "College", "Ave,", "101,", "Athens,", "GA", "30601"]) == [3]


def test_a_number_opening_the_row_is_isolated_only_when_its_segment_ends_there() -> None:
    assert isolated_positions(["15,", "07691", "Portopetro,", "Spain"]) == [0]
    # `301 College` — the number shares its segment with a word, so no comma closes it.
    assert isolated_positions(["301", "College", "Ave,", "Athens"]) == []


def test_a_number_closing_the_row_needs_no_trailing_comma() -> None:
    assert isolated_positions(["Athens,", "GA,", "30601"]) == [2]


def test_leading_and_later_are_counted_apart() -> None:
    rows = [
        _row(["15,", "07691", "Portopetro,", "Spain"], ["B-house_number", "B-postcode", "B-locality", "B-country"]),
        _row(
            ["301", "College", "Ave,", "101,", "Athens,", "GA", "30601"],
            ["B-house_number", "B-street", "I-street", "B-unit", "B-locality", "B-region", "B-postcode"],
        ),
        _row(["Athens,", "GA,", "30601"], ["B-locality", "B-region", "B-postcode"]),
    ]

    assert audit_rows(rows) == {"leading": {"house_number": 1}, "later": {"unit": 1, "postcode": 1}}
