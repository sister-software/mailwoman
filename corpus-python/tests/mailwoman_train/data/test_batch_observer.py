"""The batch observer sees a batch's rows only after the consumer has asked for the next batch."""

from __future__ import annotations

from typing import Any
from unittest import mock

from mailwoman_train.data.loader import batch as batch_module


def test_an_abandoned_batch_is_never_observed() -> None:
    rows = [{"raw": str(i), "country": "RU"} for i in range(5)]

    def fake_iter_encoded(*_args: Any, observer: Any = None, **_kwargs: Any) -> Any:
        for row in rows:
            if observer is not None:
                observer(row)
            yield {"id": row["raw"]}

    seen: list[str] = []
    with (
        mock.patch.object(batch_module, "iter_encoded", fake_iter_encoded),
        mock.patch.object(batch_module, "collate", lambda buf: [ex["id"] for ex in buf]),
    ):
        stream = batch_module.iter_batches(
            mock.Mock(), None, split="train", batch_size=2, observer=lambda row: seen.append(row["raw"])
        )
        assert next(stream) == ["0", "1"]
        assert seen == []
        assert next(stream) == ["2", "3"]
        assert seen == ["0", "1"]
        stream.close()  # The loop breaks at max_steps with ["2", "3"] fetched and untrained.
    assert seen == ["0", "1"]
