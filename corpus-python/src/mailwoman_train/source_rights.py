"""Refuse corpus sources whose register rows lack an elected decision permitting transform and train.

This module is the Python reader of the source-rights check that `corpus-inputs.ts` in
`@mailwoman/corpus/source-register` defines. Both read two committed files. `packages/corpus/data/corpus-source-inputs.json`
maps each corpus source id to the register sources its rows are built from. `packages/corpus/data/address-source-register.json`
records each register source's license decision. A source passes only when every register source it reads holds an
elected decision whose `operations` permit both `transform` and `train`. An unmapped source fails.

A local experiment may pass an `unshippable_reason`. The check then logs every gap and returns it instead of raising,
and the caller records the output as not shippable. The override admits a source only into an output marked not shippable.

The two files live in the repository checkout rather than in this package. The check therefore runs where a checkout is
present: the corpus builders, the `train` command and the Modal launcher's local entry point. A Modal container's
volume holds `corpus-python/src` without `packages/`, so the check runs before the container starts.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from .paths import repo_root_path

TRAINING_OPERATIONS: tuple[str, ...] = ("transform", "train")

UNSHIPPABLE_FLAG = "--unshippable-reason"


@dataclass(frozen=True)
class SourceRightsGap:
    """Why one corpus source lacks a permission. ``register_source`` is None when the source is unmapped."""

    source: str
    register_source: str | None
    license_id: str | None
    state: str | None
    missing: tuple[str, ...]
    because: str

    def describe(self) -> str:
        missing = " and ".join(self.missing)
        if self.register_source is None:
            return f"corpus source {self.source} is unmapped and so lacks a permission for {missing}: {self.because}"
        return (
            f"corpus source {self.source} reads register source {self.register_source} "
            f"(license {self.license_id or 'none'}, {self.state or 'no decision'}), which does not permit "
            f"{missing}: {self.because}"
        )


class SourceRightsError(RuntimeError):
    """Raised when an output would admit a source lacking the permission and no override was given."""

    def __init__(self, context: str, gaps: list[SourceRightsGap]) -> None:
        self.gaps = gaps
        sources = len({gap.source for gap in gaps})
        lines = "\n  ".join(gap.describe() for gap in gaps)
        super().__init__(
            f"{context} refuses {sources} corpus source(s) whose register rows lack an elected decision permitting "
            f"{' and '.join(TRAINING_OPERATIONS)}:\n  {lines}\nRecord the decision in "
            "packages/corpus/data/license-decisions.json, map the source in "
            f"packages/corpus/data/corpus-source-inputs.json, or pass {UNSHIPPABLE_FLAG} <why> (a config's "
            "data.unshippable_reason for a training run) for a local experiment, which marks the output as not shippable."
        )

    @classmethod
    def unenumerable(cls, context: str) -> SourceRightsError:
        """A refusal for a config that admits every corpus source by setting no `source_weights`."""
        return cls(
            context,
            [
                SourceRightsGap(
                    source="*",
                    register_source=None,
                    license_id=None,
                    state=None,
                    missing=TRAINING_OPERATIONS,
                    because="the config sets no source_weights, so it admits every source its corpus holds and names none to check",
                )
            ],
        )


@dataclass
class SourceRights:
    """The register's decisions and the corpus-source table, indexed for lookup."""

    decisions: dict[str, dict[str, Any]]
    register_sources: dict[str, dict[str, Any]]
    mappings: dict[str, dict[str, Any]]
    spellings: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_files(cls, register_path: Path, inputs_path: Path) -> SourceRights:
        register = json.loads(register_path.read_text(encoding="utf-8"))
        table = json.loads(inputs_path.read_text(encoding="utf-8"))
        return cls.from_documents(register, table)

    @classmethod
    def from_documents(cls, register: dict[str, Any], table: dict[str, Any]) -> SourceRights:
        mappings: dict[str, dict[str, Any]] = table["sources"]
        spellings: dict[str, str] = {}
        for source_id, mapping in mappings.items():
            for spelling in (source_id, *mapping.get("aliases", [])):
                claimed = spellings.get(spelling)
                if claimed is not None and claimed != source_id:
                    raise ValueError(
                        f"corpus source spelling {spelling!r} is claimed by both {claimed} and {source_id}"
                    )
                spellings[spelling] = source_id
        return cls(
            decisions={decision["licenseID"]: decision for decision in register["licenses"]},
            register_sources={row["sourceID"]: row for row in register["sources"]},
            mappings=mappings,
            spellings=spellings,
        )

    def gaps(self, source: str) -> list[SourceRightsGap]:
        """Every reason ``source`` may not be built into a corpus or trained on. Empty means permitted."""
        source_id = self.spellings.get(source)
        if source_id is None:
            return [
                SourceRightsGap(
                    source=source,
                    register_source=None,
                    license_id=None,
                    state=None,
                    missing=TRAINING_OPERATIONS,
                    because=(
                        "no entry in packages/corpus/data/corpus-source-inputs.json says which register sources "
                        "its rows are built from"
                    ),
                )
            ]
        gaps: list[SourceRightsGap] = []
        for entry in self.mappings[source_id]["inputs"]:
            row = self.register_sources.get(entry["registerSource"])
            decision = self.decisions.get(row["license"]) if row else None
            if row is None or decision is None:
                gaps.append(
                    SourceRightsGap(
                        source=source,
                        register_source=entry["registerSource"],
                        license_id=row["license"] if row else None,
                        state=None,
                        missing=TRAINING_OPERATIONS,
                        because="the register has no such row" if row is None else "the register declares no decision",
                    )
                )
                continue
            missing, because = _missing_permissions(decision)
            if missing:
                gaps.append(
                    SourceRightsGap(
                        source=source,
                        register_source=row["sourceID"],
                        license_id=decision["licenseID"],
                        state=decision["state"],
                        missing=missing,
                        because=because,
                    )
                )
        return gaps


def _missing_permissions(decision: dict[str, Any]) -> tuple[tuple[str, ...], str]:
    """The training operations a decision does not permit, with the first reason. Mirrors `permissionFor`."""
    state = decision["state"]
    if state == "refused":
        return TRAINING_OPERATIONS, f"the decision is refused: {decision.get('refusedBecause', '')}"
    if state != "elected":
        return TRAINING_OPERATIONS, f"the decision reads {state}, so no operation has been read against terms"
    operations = decision.get("operations") or {}
    missing: list[str] = []
    because = ""
    for operation in TRAINING_OPERATIONS:
        reading = operations.get(operation)
        if reading is not None and reading.get("permission") == "permitted":
            continue
        missing.append(operation)
        if not because:
            because = (
                reading["because"]
                if reading is not None
                else f"the elected terms do not state whether {operation} is permitted"
            )
    return tuple(missing), because


@lru_cache(maxsize=1)
def committed_source_rights() -> SourceRights:
    """The committed register and table, read from the repository checkout."""
    data = repo_root_path("packages", "corpus", "data")
    return SourceRights.from_files(data / "address-source-register.json", data / "corpus-source-inputs.json")


@dataclass
class SourceRightsRecord:
    """What a checked output records about the sources it admitted.

    The top-level fields match `SourceRightsRecord` in TypeScript. Each gap is written in this module's snake_case.
    """

    shippable: bool
    unshippable_reason: str | None
    sources_checked: list[str]
    gaps: list[dict[str, Any]]
    unverified: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def admit_sources(
    sources: Iterable[str],
    *,
    context: str,
    unshippable_reason: str | None = None,
    rights: SourceRights | None = None,
) -> SourceRightsRecord:
    """Admit ``sources`` or raise :class:`SourceRightsError` naming each gap.

    With ``unshippable_reason`` set, log each gap to stderr and return a record marked not shippable.
    """
    if unshippable_reason is not None and not unshippable_reason.strip():
        raise ValueError(f"{context}: {UNSHIPPABLE_FLAG} must say why the output is not shippable")
    checked = sorted(set(sources))
    table = rights or committed_source_rights()
    gaps = [gap for source in checked for gap in table.gaps(source)]
    if gaps and unshippable_reason is None:
        raise SourceRightsError(context, gaps)
    for gap in gaps:
        print(f"UNSHIPPABLE {context}: {gap.describe()} (override: {unshippable_reason})", file=sys.stderr)
    return SourceRightsRecord(
        shippable=not gaps,
        unshippable_reason=unshippable_reason if gaps else None,
        sources_checked=checked,
        gaps=[asdict(gap) for gap in gaps],
    )


def add_unshippable_flag(parser: Any) -> None:
    """Declare the override on an argparse parser, so every builder spells it the same way."""
    parser.add_argument(
        UNSHIPPABLE_FLAG,
        dest="unshippable_reason",
        default=None,
        help=(
            "Admit corpus sources whose register rows lack an elected decision permitting transform and train, "
            "for a local experiment. States why; the output is recorded as not shippable."
        ),
    )


def write_rights_record(record: SourceRightsRecord, out_dir: Path | str) -> Path:
    """Write the record beside an output as `SOURCE_RIGHTS.json`."""
    path = Path(out_dir) / "SOURCE_RIGHTS.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record.to_json(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path
