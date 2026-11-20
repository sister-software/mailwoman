// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reads error and warning counts and failing check names from the text of the
 * repository's lint, prose, health and compile scripts.
 *
 * Those scripts are `run-p` groups over several tools, so one reader recognizes each
 * tool's lines: `run-p`'s exit report, `mwops health`'s check rows and diagnostics,
 * Vale's findings and summaries, oxlint's and TypeScript's diagnostics, and the summary
 * rows of oxfmt, dependency-cruiser and the code-block linter.
 *
 * Both Vale configurations of `lint:prose:code` report a finding one rule set shares,
 * so a Vale finding is counted once by its file, position and rule.
 */

import { checkOutputLines } from "#check-kit/output-lines"
import { MAX_ERROR_LINES, type ParsedCheckOutput, ParsedSource, unparsed } from "#check-kit/parsed"

/**
 * Options for {@link parseScriptOutput}.
 */
export interface ScriptOutputOptions {
	/**
	 * Whether empty output with exit status 0 is the tool's success form, as it is for `tsc -b`.
	 */
	emptyIsSuccess?: boolean
}

const RUN_P_EXIT = /^ERROR: "([^"]+)" exited with (\d+)\.$/u
const HEALTH_ROW = /^([✓✗]) (\S+)$/u
const HEALTH_DIAGNOSTIC = /^ {4}(error|warning): /u
const VALE_FINDING = /^(\d+:\d+)\s+(error|warning|suggestion)\s+.+?\s{2,}(\S+)\s*$/u
const VALE_FILE = /^[\w@./-]+\.[A-Za-z]+$/u
const VALE_SUMMARY = /^[✔✖⚠] (\d+) errors?, (\d+) warnings? and (\d+) suggestions? in \d+ files?\.$/u
const OXLINT_FINDING = /^(\S+:\d+:\d+): (warning|error) (\S+): /u
const TYPESCRIPT_ERROR = /\berror TS\d+:/u
const OXFMT_ISSUES = /^Format issues found in above (\d+) files?\./u
const OXFMT_CLEAN = /^All matched files use the correct format\./u
const DEPCRUISE_VIOLATIONS = /^✘ \d+ dependency violations? \((\d+) errors?, (\d+) warnings?\)/u
const DEPCRUISE_CLEAN = /^✔ no dependency violations found/u
const CODE_BLOCKS = /^code-blocks: (\d+) finding\(s\)/u
const TYPOS_ERROR = /^error: `/u
const MANIFEST_LINT_CLEAN = /^✓ No issues found$/u

/**
 * Read a script's output.
 *
 * @param exitCode The script's exit status.
 * It is authoritative: a non-zero status that no line explains returns {@link unparsed}.
 */
export function parseScriptOutput(
	output: string,
	exitCode: number | null,
	options: ScriptOutputOptions = {}
): ParsedCheckOutput {
	const failingChecks = new Set<string>()
	const errorLines: string[] = []
	const valeFindings = new Map<string, "error" | "warning" | "suggestion">()
	let errors = 0
	let warnings = 0
	let recognized = false
	let valeFile: string | null = null
	let valeRun = { errors: 0, warnings: 0 }
	const mismatches: string[] = []

	let currentLabel: string | null = null

	// `run-p` reports one failing script per group, so a script that printed an error joins the failing list too.
	const error = (line: string): void => {
		errors++

		if (currentLabel) {
			failingChecks.add(currentLabel)
		}

		if (errorLines.length < MAX_ERROR_LINES) {
			errorLines.push(line)
		}
	}

	for (const { label, text: raw } of checkOutputLines(output)) {
		const text = raw.trim()

		currentLabel = label

		if (!text) continue

		let match = RUN_P_EXIT.exec(text)

		if (match) {
			recognized = true
			failingChecks.add(match[1]!)

			continue
		}

		match = HEALTH_ROW.exec(text)

		if (match && !raw.startsWith(" ")) {
			recognized = true

			if (match[1] === "✗") {
				failingChecks.add(match[2]!)
			}

			continue
		}

		match = HEALTH_DIAGNOSTIC.exec(raw)

		if (match) {
			if (match[1] === "error") {
				error(text)
			} else {
				warnings++
			}

			continue
		}

		match = VALE_SUMMARY.exec(text)

		if (match) {
			recognized = true

			// Each summary closes one Vale run, and its counts must equal the findings read for that run.
			if (Number(match[1]) !== valeRun.errors || Number(match[2]) !== valeRun.warnings) {
				mismatches.push(
					`a Vale summary reports ${match[1]} error(s) and ${match[2]} warning(s), and ${valeRun.errors} and ${valeRun.warnings} finding lines were read`
				)
			}

			valeRun = { errors: 0, warnings: 0 }
			valeFile = null

			continue
		}

		match = VALE_FINDING.exec(text)

		if (match) {
			const severity = match[2] as "error" | "warning" | "suggestion"
			const key = `${label ?? ""}\0${valeFile ?? ""}\0${match[1]}\0${match[3]}`

			if (severity === "error") {
				valeRun.errors++
			} else if (severity === "warning") {
				valeRun.warnings++
			}

			if (!valeFindings.has(key)) {
				valeFindings.set(key, severity)

				if (severity === "error") {
					error(`${valeFile ?? "?"}:${text}`)
				} else if (severity === "warning") {
					warnings++
				}
			}

			continue
		}

		match = OXLINT_FINDING.exec(text)

		if (match) {
			recognized = true

			if (match[2] === "error") {
				error(text)
			} else {
				warnings++
			}

			continue
		}

		if (TYPESCRIPT_ERROR.test(text)) {
			recognized = true
			error(text)

			continue
		}

		match = OXFMT_ISSUES.exec(text)

		if (match) {
			recognized = true
			failingChecks.add(label ?? "oxfmt")
			error(text)
			errors += Number(match[1]) - 1

			continue
		}

		match = DEPCRUISE_VIOLATIONS.exec(text)

		if (match) {
			recognized = true
			warnings += Number(match[2])

			if (match[1] !== "0") {
				error(text)
				errors += Number(match[1]) - 1
			}

			continue
		}

		match = CODE_BLOCKS.exec(text)

		if (match) {
			recognized = true

			if (match[1] !== "0") {
				error(text)
				errors += Number(match[1]) - 1
			}

			continue
		}

		if (TYPOS_ERROR.test(text)) {
			recognized = true
			error(text)

			continue
		}

		if (VALE_FILE.test(text) && raw.startsWith(" ")) {
			valeFile = text

			continue
		}

		if (OXFMT_CLEAN.test(text) || DEPCRUISE_CLEAN.test(text) || MANIFEST_LINT_CLEAN.test(text)) {
			recognized = true
		}
	}

	if (mismatches.length) return unparsed(ParsedSource.ScriptText, mismatches.join("; "))

	const empty = !output.trim()

	if (!recognized && !(empty && exitCode === 0 && options.emptyIsSuccess)) {
		return unparsed(
			ParsedSource.ScriptText,
			empty ? "the script printed nothing" : "no line matched a tool's result format"
		)
	}

	if (exitCode !== 0 && !failingChecks.size && !errors) {
		return unparsed(
			ParsedSource.ScriptText,
			`the script exited with ${exitCode ?? "a signal"}, and no line names a failing check or reports an error`
		)
	}

	return {
		parsed: true,
		reason: null,
		source: ParsedSource.ScriptText,
		errors,
		warnings,
		failingChecks: [...failingChecks],
		failingTests: [],
		totals: null,
		errorLines,
	}
}
