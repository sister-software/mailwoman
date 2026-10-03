"""grade_heldout ties each prediction to its row and groups exact matches by phenomenon."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest import mock

import torch

from mailwoman_train.data import loader
from mailwoman_train.exposure.grade import grade_heldout

STREETLESS = {
    "raw": "12, Ивановка, Тула",
    "span_starts": [0, 4, 14],
    "span_ends": [2, 12, 18],
    "span_tags": ["house_number", "dependent_locality", "locality"],
}
STREET = {
    "raw": "улица Ленина, 12, Тула",
    "span_starts": [0, 14, 18],
    "span_ends": [12, 16, 22],
    "span_tags": ["street", "house_number", "locality"],
}


def test_groups_exact_matches_by_phenomenon_and_restores_country_weights() -> None:
    rows = [STREETLESS, STREET, STREETLESS]
    labels = [[1, 2, -100], [1, 3, -100], [1, 2, -100]]

    def fake_iter_encoded(*_args: Any, observer: Any = None, **_kwargs: Any) -> Any:
        for row, gold in zip(rows, labels, strict=True):
            observer(row)
            yield SimpleNamespace(labels=gold)

    # Predict [1, 2, 0] for every row: rows 1 and 3 match their gold, row 2 does not.
    def forward(batch: list[Any]) -> torch.Tensor:
        logits = torch.zeros(len(batch), 3, 4)
        logits[:, 0, 1] = logits[:, 1, 2] = 1.0
        return logits

    cfg = SimpleNamespace(data=SimpleNamespace(country_weights={"US": 1.0}))
    with (
        mock.patch.object(loader, "iter_encoded", fake_iter_encoded),
        mock.patch.object(loader, "collate", lambda examples: list(examples)),
    ):
        report = grade_heldout(cfg, forward, None, country="RU", batch_size=2)

    assert cfg.data.country_weights == {"US": 1.0}
    groups = report["groups"]
    assert groups["*"] == {"rows": 3, "correct": 2, "exact_match": 0.6667}
    assert groups["streetless-premise-identity=streetless"]["correct"] == 2
    assert groups["house-number-precedes-street=after"] == {"rows": 1, "correct": 0, "exact_match": 0.0}
