"""Read the launcher's sync functions as data, by interpreting their string assignments.

`modal/train_remote.py` has no test coverage: it imports the Modal SDK, talks to a volume, and
every function in it is a deployment entry point. So "the suite still passes" after the launcher is
collapsed into a table would carry no information at all.

This walks each `def sync_*` and resolves the strings it builds — the rclone commands it runs, the
paths it checks, the `__pycache__` directories it clears — into concrete values. A small
interpreter rather than a regex, because the strings are f-strings over local bindings
(`package`, `overlay`, `retry`) and comprehension variables (`for index in range(8)`), and a
placeholder left unresolved would compare equal to itself while describing nothing.

`unresolved_count` is reported beside the census for that reason: a census full of `{name}` holes
is not a pin, and the number says how many holes there are.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Any

#: Call targets whose first argument names a path the launcher verifies.
PATH_CHECKS = frozenset({"isfile", "isdir", "exists", "_contains", "_file_contains"})


@dataclass
class SyncSpec:
    """What one `sync_*` function does, as strings."""

    name: str
    rclone_commands: list[str] = field(default_factory=list)
    check_paths: list[str] = field(default_factory=list)
    pycache_paths: list[str] = field(default_factory=list)

    @property
    def unresolved_count(self) -> int:
        """Strings still carrying an unsubstituted `{...}` placeholder."""
        every = self.rclone_commands + self.check_paths + self.pycache_paths
        return sum(1 for value in every if "{" in value)


class _Resolver:
    """Evaluates the string-valued subset of Python these functions use."""

    def __init__(self, env: dict[str, Any]) -> None:
        self.env = dict(env)

    def value(self, node: ast.AST) -> Any:
        """The node's value, or None when it is outside the subset."""
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return self.env.get(node.id)
        if isinstance(node, ast.JoinedStr):
            return self._joined(node)
        if isinstance(node, ast.FormattedValue):
            return self._formatted(node)
        if isinstance(node, ast.List | ast.Tuple):
            return [self.value(element) for element in node.elts]
        if isinstance(node, ast.Call):
            return self._call(node)
        return None

    def _joined(self, node: ast.JoinedStr) -> str:
        out = []
        for part in node.values:
            resolved = self.value(part)
            out.append(str(resolved) if resolved is not None else _placeholder(part))
        return "".join(out)

    def _formatted(self, node: ast.FormattedValue) -> Any:
        resolved = self.value(node.value)
        if resolved is None:
            return None
        spec = node.format_spec
        if isinstance(spec, ast.JoinedStr):
            spec_text = self._joined(spec)
            if "{" not in spec_text:
                return format(resolved, spec_text)
        return resolved

    def _call(self, node: ast.Call) -> Any:
        """`range(n)` and `str.join`, the two the launcher uses inside a comprehension."""
        if isinstance(node.func, ast.Name) and node.func.id == "range" and len(node.args) == 1:
            count = self.value(node.args[0])
            return list(range(count)) if isinstance(count, int) else None
        return None

    def bind(self, target: ast.AST, value: Any) -> None:
        if isinstance(target, ast.Name) and value is not None:
            self.env[target.id] = value


def _placeholder(part: ast.AST) -> str:
    """What an unresolvable interpolation is recorded as, so a hole stays visible."""
    if isinstance(part, ast.FormattedValue):
        return "{" + ast.unparse(part.value) + "}"
    return "{?}"


def _module_constants(tree: ast.Module) -> dict[str, Any]:
    resolver = _Resolver({})
    for node in tree.body:
        if isinstance(node, ast.Assign):
            value = resolver.value(node.value)
            for target in node.targets:
                resolver.bind(target, value)
    return resolver.env


def _collect(spec: SyncSpec, resolver: _Resolver, body: list[ast.stmt]) -> None:
    """Walk statements in order, binding names and recording the strings they build."""
    for statement in body:
        if isinstance(statement, ast.Assign):
            value = resolver.value(statement.value)
            for target in statement.targets:
                resolver.bind(target, value)
            _record(spec, value)
        elif isinstance(statement, ast.For):
            items = resolver.value(statement.iter)
            _record(spec, items, pycache=_is_pycache_loop(statement))
            if isinstance(items, list) and items:
                resolver.bind(statement.target, items[0])
            _collect(spec, resolver, statement.body)
            continue
        elif isinstance(statement, ast.If | ast.With | ast.Try):
            _collect(spec, resolver, statement.body)
            _collect(spec, resolver, getattr(statement, "orelse", []))
            continue
        # The comprehension pass owns the calls inside a comprehension, because only it can bind
        # the loop variable. Walking them here too would record the same check a second time with
        # `{index}` still in it — a hole that compares equal to itself and names no file.
        _record_calls_in(spec, resolver, statement)
        inside = _comprehension_nodes(statement)
        for node in ast.walk(statement):
            if id(node) not in inside:
                _record_calls(spec, resolver, node)


def _comprehension_nodes(statement: ast.stmt) -> set[int]:
    """Every node id living inside a comprehension in this statement."""
    inside: set[int] = set()
    for node in ast.walk(statement):
        if isinstance(node, ast.ListComp | ast.GeneratorExp | ast.SetComp | ast.DictComp):
            inside.update(id(child) for child in ast.walk(node))
    return inside


def _is_pycache_loop(statement: ast.For) -> bool:
    return "__pycache__" in ast.unparse(statement.iter)


def _record(spec: SyncSpec, value: Any, *, pycache: bool = False) -> None:
    for text in _strings(value):
        if pycache or text.endswith("__pycache__"):
            spec.pycache_paths.append(text)
        elif text.startswith("rclone"):
            spec.rclone_commands.append(text)


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for element in value for item in _strings(element)]
    return []


def _record_calls_in(spec: SyncSpec, resolver: _Resolver, statement: ast.stmt) -> None:
    for node in ast.walk(statement):
        if isinstance(node, ast.ListComp | ast.GeneratorExp | ast.SetComp):
            _record_comprehension(spec, resolver, node)


def _record_comprehension(spec: SyncSpec, resolver: _Resolver, node: ast.AST) -> None:
    """Expand a comprehension over a literal sequence or `range(n)`, one record per item."""
    generators = getattr(node, "generators", [])
    if len(generators) != 1:
        return
    generator = generators[0]
    items = resolver.value(generator.iter)
    if not isinstance(items, list):
        return
    for item in items:
        inner = _Resolver(resolver.env)
        inner.bind(generator.target, item)
        for call in ast.walk(node.elt):
            _record_calls(spec, inner, call, in_comprehension=True)


def _record_calls(spec: SyncSpec, resolver: _Resolver, node: ast.AST, *, in_comprehension: bool = False) -> None:
    if not isinstance(node, ast.Call) or not node.args:
        return
    func = node.func
    name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
    if name not in PATH_CHECKS:
        return
    if isinstance(node.args[0], ast.ListComp | ast.GeneratorExp):
        return
    resolved = resolver.value(node.args[0])
    if isinstance(resolved, str) and resolved not in spec.check_paths:
        spec.check_paths.append(resolved)


def extract_sync_functions(source: str) -> dict[str, SyncSpec]:
    """Every `def sync_*` in the launcher, as a `SyncSpec`."""
    tree = ast.parse(source)
    constants = _module_constants(tree)
    specs: dict[str, SyncSpec] = {}
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef) or not node.name.startswith("sync_"):
            continue
        spec = SyncSpec(name=node.name)
        _collect(spec, _Resolver(constants), node.body)
        specs[node.name] = spec
    return specs
