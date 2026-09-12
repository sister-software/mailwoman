"""A deferred intra-package import may not dodge an import cycle.

A deferred import is legitimate when it buys startup weight: `cli.py` defers 32 of them and keeps
torch's 1.46 s off every `--help` (measured — `mailwoman_train.cli` imports in 22,340 us against
`mailwoman_train.train`'s 1,458,740 us). It is a defect when the target module imports this one back,
because then the deferral is hiding a circular graph and an ImportError surfaces at first call rather
than at import. This detector flags the second and leaves the first alone.
"""

from __future__ import annotations

import ast
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[2] / "src" / "mailwoman_train"

#: Cycles this tree still carries, each with the move that closes it. The list only ever shrinks; a
#: new entry means a cycle was introduced, which is what this test exists to refuse.
#:
#: `trainer` routes the MLM objective to `pretrain`, while `pretrain` takes five names back from
#: `trainer`. Three of them belong to the scheduler and the checkpoint writer and one to batch/device
#: preparation; once each sits in its own module, neither file imports the other.
KNOWN_CYCLES = frozenset(
    {
        "train.py:664 defers mailwoman_train.pretrain, which imports back",
    }
)


def _module_name(path: Path) -> str:
    relative = path.relative_to(SOURCE_ROOT).with_suffix("")
    parts = [p for p in relative.parts if p != "__init__"]
    return ".".join(["mailwoman_train", *parts])


def _resolve(module: str | None, level: int, holder: str) -> str:
    """The absolute module a `from ... import` names, given the module holding it."""
    if level == 0:
        return module or ""
    base = holder.split(".")
    anchor = base[: len(base) - level] if len(base) > level else base[:1]
    return ".".join([*anchor, module]) if module else ".".join(anchor)


def _imports(tree: ast.AST, holder: str, *, deferred: bool) -> set[tuple[str, int]]:
    """Intra-package targets imported at module level (deferred=False) or in a body (deferred=True)."""
    found: set[tuple[str, int]] = set()
    bodies = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)]
    inside = {id(n) for body in bodies for n in ast.walk(body)}

    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        if (id(node) in inside) is not deferred:
            continue
        target = _resolve(node.module, node.level, holder)
        if target.startswith("mailwoman_train"):
            found.add((target, node.lineno))

    return found


def _module_level_graph() -> dict[str, set[str]]:
    graph: dict[str, set[str]] = {}
    for path in sorted(SOURCE_ROOT.rglob("*.py")):
        holder = _module_name(path)
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        graph[holder] = {target for target, _ in _imports(tree, holder, deferred=False)}
    return graph


def _reaches(graph: dict[str, set[str]], start: str, goal: str) -> bool:
    seen: set[str] = set()
    stack = list(graph.get(start, ()))
    while stack:
        current = stack.pop()
        if current == goal:
            return True
        if current in seen:
            continue
        seen.add(current)
        stack.extend(graph.get(current, ()))
    return False


def test_no_deferred_import_dodges_a_cycle() -> None:
    graph = _module_level_graph()
    offenders: list[str] = []

    for path in sorted(SOURCE_ROOT.rglob("*.py")):
        holder = _module_name(path)
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for target, lineno in sorted(_imports(tree, holder, deferred=True)):
            if _reaches(graph, target, holder):
                offenders.append(f"{path.relative_to(SOURCE_ROOT)}:{lineno} defers {target}, which imports back")

    found = set(offenders)
    introduced = sorted(found - KNOWN_CYCLES)
    assert introduced == [], "new deferred imports dodging a cycle:\n" + "\n".join(introduced)

    closed = sorted(KNOWN_CYCLES - found)
    assert closed == [], "these cycles are closed — delete them from KNOWN_CYCLES:\n" + "\n".join(closed)


def test_piece_span_is_declared_in_types() -> None:
    from mailwoman_train import types

    assert set(types.PieceSpan.__dataclass_fields__) == {
        "piece",
        "piece_id",
        "char_begin",
        "char_end",
    }
