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

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = PACKAGE_ROOT / "src" / "mailwoman_train"

#: Cycles this tree still carries, each with the move that closes it. The list only ever shrinks: a
#: new entry means a cycle was introduced, and an entry that stops matching means one was closed and
#: the line should go. Both are assertions below, so neither can drift.
KNOWN_CYCLES: frozenset[str] = frozenset()


def _module_name(path: Path) -> str:
    relative = path.relative_to(SOURCE_ROOT).with_suffix("")
    parts = [p for p in relative.parts if p != "__init__"]
    return ".".join(["mailwoman_train", *parts])


def _resolve(module: str | None, level: int, holder: str, *, is_package: bool) -> str:
    """The absolute module a `from ... import` names, given the module holding it.

    Inside a package's `__init__.py` a single dot means that package; inside a plain module it means
    the package containing it. Conflating the two makes `from .x` in `a/b/__init__.py` resolve to
    `a.x`, and if `a.x` happens to exist the check passes over a broken import.
    """
    if level == 0:
        return module or ""
    base = holder.split(".")
    drop = level - 1 if is_package else level
    anchor = base[: len(base) - drop] if len(base) > drop else base[:1]
    return ".".join([*anchor, module]) if module else ".".join(anchor)


def _imports(tree: ast.AST, holder: str, *, deferred: bool, is_package: bool) -> set[tuple[str, int]]:
    """Intra-package targets imported at module level (deferred=False) or in a body (deferred=True)."""
    found: set[tuple[str, int]] = set()
    bodies = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)]
    inside = {id(n) for body in bodies for n in ast.walk(body)}

    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        if (id(node) in inside) is not deferred:
            continue
        target = _resolve(node.module, node.level, holder, is_package=is_package)
        if target.startswith("mailwoman_train"):
            found.add((target, node.lineno))

    return found


def _module_level_graph() -> dict[str, set[str]]:
    graph: dict[str, set[str]] = {}
    for path in sorted(SOURCE_ROOT.rglob("*.py")):
        holder = _module_name(path)
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        graph[holder] = {
            target for target, _ in _imports(tree, holder, deferred=False, is_package=path.name == "__init__.py")
        }
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
        for target, lineno in sorted(_imports(tree, holder, deferred=True, is_package=path.name == "__init__.py")):
            if _reaches(graph, target, holder):
                offenders.append(f"{path.relative_to(SOURCE_ROOT)}:{lineno} defers {target}, which imports back")

    found = set(offenders)
    introduced = sorted(found - KNOWN_CYCLES)
    assert introduced == [], "new deferred imports dodging a cycle:\n" + "\n".join(introduced)

    closed = sorted(KNOWN_CYCLES - found)
    assert closed == [], "these cycles are closed — delete them from KNOWN_CYCLES:\n" + "\n".join(closed)


def test_every_deferred_import_names_a_module_that_exists() -> None:
    """A deferred import is not checked until it runs, and most of them never run under test.

    Moving a module one directory deeper re-levels every relative import inside it. A module-level
    import that survives the move wrong fails at import; a deferred one fails at first call, on a
    branch a config has to enable. Four of these pointed at `mailwoman_train.data.gazetteer_anchor`
    after the data move and the whole suite stayed green.
    """
    known = {_module_name(path) for path in SOURCE_ROOT.rglob("*.py")}
    known |= {name.rsplit(".", 1)[0] for name in known if "." in name}
    offenders: list[str] = []

    for path in sorted(SOURCE_ROOT.rglob("*.py")):
        holder = _module_name(path)
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for target, lineno in sorted(_imports(tree, holder, deferred=True, is_package=path.name == "__init__.py")):
            if target not in known:
                offenders.append(f"{path.relative_to(SOURCE_ROOT)}:{lineno} defers {target}, which does not exist")

    assert offenders == [], "deferred imports naming a missing module:\n" + "\n".join(offenders)


def _declared_names(tree: ast.Module) -> set[str]:
    """Names a module DEFINES, plus whatever it re-exports on purpose through ``__all__``."""
    declared: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            declared.add(node.name)
        elif isinstance(node, ast.Assign):
            declared.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            declared.add(node.target.id)
        elif isinstance(node, ast.Assign | ast.AnnAssign):
            continue
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets):
            declared.update(
                element.value for element in getattr(node.value, "elts", []) if isinstance(element, ast.Constant)
            )
    return declared


def test_an_import_names_the_module_that_declares_it() -> None:
    """Importing a name from a module that only re-imported it pins the wrong file.

    A plain module's import list is its own business, not a public surface: ``trainer`` imports
    ``build_optimizer`` so it can call it, and a test that took the name from there kept passing
    after the function moved to ``optim.groups`` — so the move looked complete while six call sites
    still named the old file. A package ``__init__`` is the exception: re-exporting IS what it is
    for, and so is an explicit ``__all__``.
    """
    modules: dict[str, ast.Module] = {}
    packages: set[str] = set()
    for path in SOURCE_ROOT.rglob("*.py"):
        name = _module_name(path)
        modules[name] = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        if path.name == "__init__.py":
            packages.add(name)

    declared = {name: _declared_names(tree) for name, tree in modules.items()}
    submodules = {name.rsplit(".", 1)[0] for name in modules if "." in name}
    offenders: list[str] = []
    roots = [SOURCE_ROOT, PACKAGE_ROOT / "tests", PACKAGE_ROOT / "launch"]
    assert all(root.is_dir() for root in roots), f"a root to scan is missing: {roots}"

    for root in roots:
        for path in sorted(root.rglob("*.py")):
            holder = _module_name(path) if root is SOURCE_ROOT else str(path.relative_to(root.parent))
            is_package = path.name == "__init__.py"
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom):
                    continue
                anchor = holder if root is SOURCE_ROOT else ""
                target = _resolve(node.module, node.level, anchor, is_package=is_package)
                if target in packages or target not in modules:
                    continue
                for alias in node.names:
                    if alias.name in declared[target] or f"{target}.{alias.name}" in submodules:
                        continue
                    offenders.append(
                        f"{path.name}:{node.lineno} imports {alias.name} from {target}, which re-imports it"
                    )

    assert offenders == [], "imports naming a module that does not declare the name:\n" + "\n".join(offenders)


def test_piece_span_is_declared_in_types() -> None:
    from mailwoman_train import types

    assert set(types.PieceSpan.__dataclass_fields__) == {
        "piece",
        "piece_id",
        "char_begin",
        "char_end",
    }
