"""Emit Python comments and module docstrings as JSON for repository comment triage."""

from __future__ import annotations

import ast
import io
import json
import re
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


def docstrings(path: Path) -> list[dict[str, object]]:
    text = path.read_text(encoding="utf-8")
    tree = ast.parse(text, filename=str(path))
    nodes: list[dict[str, object]] = []
    owners = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)

    for owner in ast.walk(tree):
        if not isinstance(owner, owners) or not owner.body:
            continue

        expression = owner.body[0]
        if not (
            isinstance(expression, ast.Expr)
            and isinstance(expression.value, ast.Constant)
            and isinstance(expression.value.value, str)
        ):
            continue

        source = ast.get_source_segment(text, expression) or ""
        opening = re.match(r"^[\t ]*(?:[rRuUbBfF]*)('''|\"\"\")", source)
        if opening is None:
            continue

        delimiter = opening.group(1)
        closing = source.rfind(delimiter)
        if closing < opening.end():
            continue

        body = source[opening.end() : closing]
        body_lines = body.splitlines()
        line_offset = source[: opening.end()].count("\n")
        first_content = next((index for index, line in enumerate(body_lines) if line.strip()), 0)
        last_content = next(
            (index for index in range(len(body_lines) - 1, -1, -1) if body_lines[index].strip()),
            -1,
        )
        content_lines = [line.strip() for line in body_lines[first_content : last_content + 1]]

        nodes.append(
            {
                "startLine": expression.lineno,
                "endLine": expression.end_lineno,
                "contentStartLine": expression.lineno + line_offset + first_content,
                "content": "\n".join(content_lines),
            }
        )

    return sorted(nodes, key=lambda node: int(node["startLine"]))


if len(sys.argv) > 1 and sys.argv[1] == "--docstrings":
    print(json.dumps({path: docstrings(Path(path)) for path in sys.argv[2:]}))
else:
    print(json.dumps({path: comments(Path(path)) for path in sys.argv[1:]}))
