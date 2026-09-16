"""Emit Python comments and module docstrings as JSON for repository comment triage."""

from __future__ import annotations

import ast
import io
import json
import sys
import tokenize
from pathlib import Path


def offset(lines: list[str], line: int, column: int) -> int:
    return sum(len(value) for value in lines[: line - 1]) + column


def comments(path: Path) -> list[dict[str, object]]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    nodes: list[dict[str, object]] = []
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type != tokenize.COMMENT:
            continue
        nodes.append(
            {
                "start": offset(lines, token.start[0], token.start[1]),
                "end": offset(lines, token.end[0], token.end[1]),
                "startLine": token.start[0],
                "startColumn": token.start[1] + 1,
                "endLine": token.end[0],
                "endColumn": token.end[1] + 1,
                "kind": "line",
                "text": token.string,
            }
        )
    tree = ast.parse(text, filename=str(path))
    if (
        tree.body
        and isinstance(tree.body[0], ast.Expr)
        and isinstance(tree.body[0].value, ast.Constant)
        and isinstance(tree.body[0].value.value, str)
    ):
        node = tree.body[0]
        nodes.append(
            {
                "start": offset(lines, node.lineno, node.col_offset),
                "end": offset(lines, node.end_lineno, node.end_col_offset),
                "startLine": node.lineno,
                "startColumn": node.col_offset + 1,
                "endLine": node.end_lineno,
                "endColumn": node.end_col_offset + 1,
                "kind": "docstring",
                "text": ast.get_source_segment(text, node) or "",
            }
        )
    return nodes


print(json.dumps({path: comments(Path(path)) for path in sys.argv[1:]}))
