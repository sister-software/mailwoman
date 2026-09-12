"""The declared interfaces match the code that implements them.

A protocol nobody satisfies is decoration. These tests pin each one's members against the modules
that already carry them, so a protocol cannot drift into describing a shape the tree does not have.
"""

from __future__ import annotations

import argparse
import inspect

from mailwoman_train import build_jp_slice, build_kr_slice, build_tw_slice, protocols

COUNTRY_BUILDERS = (build_jp_slice, build_kr_slice, build_tw_slice)


def test_country_module_protocol_declares_the_expected_members() -> None:
    assert set(protocols.CountryModule.__protocol_attrs__) == {
        "COUNTRY_CODE",
        "LABEL_SET_NAME",
        "BOARD_BUCKET_MIN",
        "build_corpus",
    }


def test_train_callback_protocol_declares_the_expected_members() -> None:
    assert set(protocols.TrainCallback.__protocol_attrs__) == {
        "on_train_begin",
        "on_step_end",
        "on_eval_end",
        "on_train_end",
    }


def test_every_country_builder_already_carries_the_constants() -> None:
    """`CountryModule` names constants the builders declare today, not ones a move would invent."""
    for builder in COUNTRY_BUILDERS:
        assert isinstance(builder.LABEL_SET_NAME, str), builder.__name__
        assert isinstance(builder.BOARD_BUCKET_MIN, int), builder.__name__


def test_build_corpus_matches_the_signature_every_builder_already_has() -> None:
    """The protocol takes a parsed `Namespace` because that is what `build` takes.

    Each builder reads more than a dozen settings off it — the JP one reads eighteen — so a
    narrower interface would either drop them or silently substitute defaults.
    """
    # eval_str resolves the annotations, which `from __future__ import annotations` leaves as
    # strings on both sides — comparing the strings would pass on a name that resolves to
    # something else entirely.
    declared = inspect.signature(protocols.CountryModule.build_corpus, eval_str=True)
    parameters = [p for name, p in declared.parameters.items() if name != "self"]
    assert [p.annotation for p in parameters] == [argparse.Namespace]

    for builder in COUNTRY_BUILDERS:
        actual = inspect.signature(builder.build, eval_str=True)
        assert list(actual.parameters) == ["args"], builder.__name__
        assert actual.parameters["args"].annotation is argparse.Namespace, builder.__name__
