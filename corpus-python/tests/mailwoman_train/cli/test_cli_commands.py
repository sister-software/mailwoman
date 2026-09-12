"""Every subcommand is a module in the registry, and declares its own flags.

`cli.py` held eight command bodies, their private helpers, and a 145-line `build_parser` that
declared all eight commands' flags in one run — so adding a command meant editing a function that
every other command shared, and reading one command meant finding its flags a hundred lines from
its body.

A command is now a module exporting `NAME`, `add_parser` and `run`, and `COMMANDS` is the list.
`build_parser` loops it. These tests read the registry, not argparse's private attributes, so they
say what a command owes rather than how argparse happens to store it.
"""

from __future__ import annotations

import argparse

import pytest

from mailwoman_train import protocols
from mailwoman_train.cli import COMMANDS, build_parser

EXPECTED = {
    "train",
    "eval",
    "export",
    "quantize",
    "package",
    "smoke",
    "tokenizer",
    "verify-tokenizer",
}


def _subcommand_choices(parser: argparse.ArgumentParser) -> set[str]:
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            return set(action.choices)
    raise AssertionError("the parser declares no subcommands")


def test_the_registry_holds_every_expected_subcommand() -> None:
    assert {command.NAME for command in COMMANDS} == EXPECTED


def test_every_registered_command_satisfies_the_protocol() -> None:
    for command in COMMANDS:
        assert isinstance(command, protocols.CLICommand), command.NAME


def test_a_name_is_claimed_once() -> None:
    """Two commands claiming one name means argparse silently keeps the last registered."""
    names = [command.NAME for command in COMMANDS]
    assert sorted(names) == sorted(set(names))


def test_the_parser_registers_exactly_the_registry() -> None:
    assert _subcommand_choices(build_parser()) == EXPECTED


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_each_subcommand_accepts_help(name: str) -> None:
    """Builds that command's parser and every flag on it — a duplicate or malformed flag raises."""
    parser = build_parser()
    with pytest.raises(SystemExit) as caught:
        parser.parse_args([name, "--help"])
    assert caught.value.code == 0


def test_the_module_entry_point_dispatches_to_the_named_command() -> None:
    """`python -m mailwoman_train <name>` must reach that command's `run`, not another's."""
    parser = build_parser()
    args = parser.parse_args(["quantize", "--input", "a.onnx", "--output", "b.onnx"])
    assert args.func.__module__.endswith("commands.quantize")
