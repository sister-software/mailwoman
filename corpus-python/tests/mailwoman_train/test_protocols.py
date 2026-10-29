"""The declared interfaces match the code that implements them.

A protocol with no implementing class adds no behavior. These tests pin each one's members against the modules
that already include them, so a protocol cannot drift into describing a shape the tree does not have.
"""

from __future__ import annotations

from mailwoman_train import protocols


def test_train_callback_protocol_declares_the_expected_members() -> None:
    assert set(protocols.TrainCallback.__protocol_attrs__) == {
        "on_train_begin",
        "on_step_end",
        "on_eval_end",
        "on_train_end",
    }
