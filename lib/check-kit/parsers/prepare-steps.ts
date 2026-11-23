// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reads the output of the two `mwops worktree prepare` steps that no repository check runs:
 * `yarn install --json` and `yarn mwops release copy-weights`.
 *
 * Yarn's `--json` form writes one object per line with a `type` of `info`, `warning` or `error`,
 * and closes with a `Done` or `Failed` line, so the counts come from the types Yarn assigned.
 *
 * `mwops release copy-weights` prints its progress lines and then its output object,
 * `{ skipped, workspaces }`, as indented JSON on the last lines.
 * A failure prints the thrown error.
 * Its first line starts with the error's class name.
 */

import { tryParsingJSON } from "@mailwoman/core/values/json"

import { checkOutputLines } from "#check-kit/output-lines"
import { MAX_ERROR_LINES, type ParsedCheckOutput, ParsedSource, unparsed } from "#check-kit/parsed"

/**
 * One line of `yarn install --json`.
 */
interface YarnJSONLine {
	type: string
	displayName?: string
	data?: unknown
}

/**
 * Yarn's closing line, such as `Done with warnings in 6s 863ms` or `Failed with errors in 1s`.
 */
const YARN_CLOSING = /^(Done|Failed)\b/u

function parsedCounts(errors: number, warnings: number, errorLines: string[]): ParsedCheckOutput {
	return {
		parsed: true,
		reason: null,
		source: ParsedSource.ScriptText,
		errors,
		warnings,
		failingChecks: [],
		failingTests: [],
		totals: null,
		errorLines: errorLines.slice(0, MAX_ERROR_LINES),
	}
}

/**
 * Read `yarn install --json` output: the error and warning lines Yarn typed, and its closing line.
 */
export function parseYarnInstallOutput(output: string, exitCode: number | null): ParsedCheckOutput {
	let closing: string | null = null
	let errors = 0
	let warnings = 0
	const errorLines: string[] = []

	for (const { text } of checkOutputLines(output)) {
		const line = tryParsingJSON<YarnJSONLine>(text.trim())

		if (!line || typeof line.type !== "string") continue

		const data = typeof line.data === "string" ? line.data : ""

		if (YARN_CLOSING.test(data)) {
			closing = data

			continue
		}

		if (line.type === "error") {
			errors++
			errorLines.push(`${line.displayName ?? "yarn"}: ${data}`)
		} else if (line.type === "warning") {
			warnings++
		}
	}

	if (!closing) return unparsed(ParsedSource.ScriptText, "yarn printed no Done or Failed line")

	if (exitCode !== 0 && !errors) {
		return unparsed(ParsedSource.ScriptText, `yarn exited with ${exitCode ?? "a signal"} and printed no error line`)
	}

	return parsedCounts(errors, warnings, errorLines)
}

/**
 * The first line of an error `runCLICommand` printed: `Error: …`, `TypeError: …`,
 * or another subclass's own class name.
 */
const THROWN_ERROR = /^(?:[A-Z]\w*)?Error: /u

/**
 * Read `yarn mwops release copy-weights` output: its closing output object, or the error it threw.
 */
export function parseWeightsCopyOutput(output: string, exitCode: number | null): ParsedCheckOutput {
	const lines = checkOutputLines(output).map(({ text }) => text)
	const thrown = lines.filter((line) => THROWN_ERROR.test(line.trim()))

	if (thrown.length) return parsedCounts(thrown.length, 0, thrown)

	const opening = lines.lastIndexOf("{")

	const report =
		opening === -1 ? null : tryParsingJSON<{ skipped?: unknown; workspaces?: unknown }>(lines.slice(opening).join("\n"))

	if (!report || typeof report.skipped !== "boolean" || !Array.isArray(report.workspaces)) {
		return unparsed(ParsedSource.ScriptText, "copy-weights printed neither its output object nor an error")
	}

	if (exitCode !== 0) {
		return unparsed(ParsedSource.ScriptText, `copy-weights printed its output object and exited with ${exitCode}`)
	}

	// A skipped copy is reported as a warning, because the workspaces it names were never written.
	return parsedCounts(0, report.skipped ? 1 : 0, [])
}
