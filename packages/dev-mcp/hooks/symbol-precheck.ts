#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PreToolUse hook: before a Write or an Edit introduces a top-level symbol, say where that name already lives.
 *
 *   It exists because the alternative does not work. The shared homes an author is supposed to reach for are listed in
 *   prose in `AGENTS.md`, and that list names a few dozen of the several thousand exported symbols in the tree — so
 *   the miss rate is structural, not a matter of attention. `jscpd` and `knip` (`yarn health:duplicates`,
 *   `yarn health:knip`) already find duplication, but only after it is written and committed. This is the same
 *   question asked at the moment it can still be answered cheaply.
 *
 *   It NEVER blocks. Exit 0 always, with `additionalContext` when there is something to say and silence otherwise; a
 *   hint that can interrupt an edit is a hint that gets switched off. Every failure path is also silence, for the same
 *   reason — a hook that throws on an unanticipated payload is a broken editor rather than a missing hint.
 *
 *   Register it in `.claude/settings.json` under `hooks.PreToolUse` with a `Write|Edit` matcher.
 */

import { readFileSync } from "node:fs"
import { relative } from "node:path"

import { tryParsingJSON } from "@mailwoman/core/objects"

import {
	extractDeclaredSymbols,
	findDeclarations,
	formatFindings,
	readWriteIntent,
	selectReportable,
} from "../symbol-index.ts"

const STDIN = 0

function main(): void {
	const payload = tryParsingJSON<Record<string, unknown>>(readFileSync(STDIN, "utf8"))
	const intent = readWriteIntent(payload)

	if (!intent) return

	const declared = extractDeclaredSymbols(intent.source)

	if (!declared.length) return

	const cwd = typeof payload?.cwd === "string" ? payload.cwd : process.cwd()

	const findings = selectReportable(findDeclarations(declared, { cwd }), {
		writingFile: relative(cwd, intent.filePath),
	})

	const additionalContext = formatFindings(findings)

	if (!additionalContext) return

	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } }))
}

try {
	main()
} catch {
	// Silence is the contract. See the header.
}
