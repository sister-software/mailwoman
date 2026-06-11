#!/usr/bin/env bash
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# Raw-angle-bracket MDX lint. Docusaurus compiles BOTH .md and .mdx through micromark's MDX-JSX
# extension, so a bare `<55` or `<word` in prose is a BUILD-BREAKING parse error ("Unexpected
# character before name"). This class broke three builds on 2026-06-10 alone (the consolidation
# session doc, the deep-dive review, the fill-rate record) — hence this gate.
#
# Checks STAGED docs markdown by default (pre-commit), or explicit paths when given.
# Skips fenced code blocks and inline code; flags raw `<` followed by an alphanumeric in prose.
set -euo pipefail

if [ $# -gt 0 ]; then
	files="$*"
else
	files=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^docs/.*\.(md|mdx)$' || true)
fi
[ -z "$files" ] && exit 0

fail=0
for f in $files; do
	[ -f "$f" ] || continue
	# Strip fenced code blocks, then inline code spans, then flag raw <alnum in what remains.
	# Digits-only: the measured build-breaking class is `<55`-style numeric prose. Uppercase
	# `<Component>` is legitimate MDX JSX and lowercase `<word>` is usually real HTML — flagging
	# them false-positives on valid docs (bit on the pipeline-contract page, night-11).
	hits=$(awk '/^```/{fence=!fence; next} !fence' "$f" | sed 's/`[^`]*`//g' | grep -nE '<[0-9]' || true)
	if [ -n "$hits" ]; then
		echo "✗ $f — raw '<' before alphanumeric (MDX parses it as a JSX tag; build will fail):" >&2
		echo "$hits" | head -5 | sed 's/^/    /' >&2
		fail=1
	fi
done
if [ $fail -ne 0 ]; then
	echo "" >&2
	echo "Fix: spell it out ('under 80%'), use ≤/＜, or backtick the expression." >&2
	exit 1
fi
