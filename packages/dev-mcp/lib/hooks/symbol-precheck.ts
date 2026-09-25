#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PreToolUse hook that reports where a top-level symbol already exists before a Write or Edit declares it.
 *
 *   The hook never blocks an edit. It prints `additionalContext` when it finds a match and prints nothing
 *   otherwise, including on every error. It runs under a `Write|Edit` matcher in `.claude/settings.json`.
 */

import { readStandardInputJSON } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { relative } from "path-ts"

import {
	extractDeclaredSymbols,
	findDeclarations,
	formatFindings,
	readWriteIntent,
	selectReportable,
} from "#symbol/index"

async function main(): Promise<void> {
	const payload = await readStandardInputJSON<Record<string, unknown>>().catch(() => null)
	const intent = readWriteIntent(payload)

	if (!intent) return

	const declared = extractDeclaredSymbols(intent.source)

	if (!declared.length) return

	const cwd = typeof payload?.cwd === "string" ? payload.cwd : process.cwd()

	const findings = selectReportable(findDeclarations(declared, { cwd }), {
		writingFile: relative(cwd, intent.filePath),
	})

	const additionalContext = formatFindings(findings, declared)

	if (!additionalContext) return

	process.stdout.write(stringifyJSON({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } }))
}

try {
	await main()
} catch {
	// A hook error must never interrupt the edit, so the hook prints nothing.
}
