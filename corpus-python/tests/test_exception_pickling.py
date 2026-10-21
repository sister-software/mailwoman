"""Exceptions a Modal function raises reach the local entrypoint by pickle, so each must round-trip."""

from __future__ import annotations

import importlib
import inspect
import pickle
import pkgutil

import mailwoman_train
from mailwoman_train.audits.epoch_mixture.receipts import CorpusReceiptError
from mailwoman_train.audits.label_support import LabelSupportError
from mailwoman_train.audits.validation_coverage import ValidationCoverageError
from mailwoman_train.source_rights import RowLicenseError, SourceRightsError


def _round_trip(error: BaseException) -> BaseException:
    return pickle.loads(pickle.dumps(error))


def test_corpus_receipt_error_keeps_message_and_report() -> None:
    report = {"receipts": [{"name": "gb-flat", "matched": 0, "min_per_epoch": 4}]}
    restored = _round_trip(CorpusReceiptError("required corpus receipts failed: gb-flat", report))
    assert isinstance(restored, CorpusReceiptError)
    assert str(restored) == "required corpus receipts failed: gb-flat"
    assert restored.report == report


def test_report_errors_round_trip() -> None:
    for cls in (ValidationCoverageError, LabelSupportError):
        restored = _round_trip(cls("floor not met", {"labels": {"unit": 3}}))
        assert isinstance(restored, cls)
        assert str(restored) == "floor not met"
        assert restored.report == {"labels": {"unit": 3}}


def test_source_rights_errors_round_trip() -> None:
    original = SourceRightsError.unenumerable("train")
    restored = _round_trip(original)
    assert isinstance(restored, SourceRightsError)
    assert str(restored) == str(original)
    assert restored.gaps == original.gaps

    row = _round_trip(RowLicenseError("writer", "oa-gb"))
    assert isinstance(row, RowLicenseError)
    assert row.source == "oa-gb"
    assert str(row) == str(RowLicenseError("writer", "oa-gb"))


def test_every_exception_with_a_custom_init_defines_reduce() -> None:
    """A new exception whose `__init__` differs from its `args` would fail to deserialize locally."""
    unpicklable: list[str] = []
    for module_info in pkgutil.walk_packages(mailwoman_train.__path__, f"{mailwoman_train.__name__}."):
        try:
            module = importlib.import_module(module_info.name)
        except ImportError:
            continue  # optional GPU-only dependencies
        for _, cls in inspect.getmembers(module, inspect.isclass):
            if cls.__module__ != module.__name__ or not issubclass(cls, BaseException):
                continue
            if "__init__" in cls.__dict__ and "__reduce__" not in cls.__dict__:
                unpicklable.append(f"{cls.__module__}.{cls.__qualname__}")
    assert unpicklable == []
