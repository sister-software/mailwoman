// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The fields a check's output parser reads, shared by the Vitest and script parsers.
 *
 * A parser that can't find what it expects returns {@link unparsed}.
 * The counts are then `null`, because a zero would claim the output held no failure.
 */

/**
 * One failing test as Vitest reported it.
 */
export interface FailingTest {
	/**
	 * The test file, relative to the checkout when Vitest printed it so.
	 */
	file: string
	/**
	 * The describe blocks and the test title joined with ` > `, as Vitest's summary prints them.
	 *
	 * `null` when the file itself failed, such as on an import error.
	 */
	name: string | null
	/**
	 * The first non-empty line of the first error, or `null` when Vitest printed none.
	 */
	firstErrorLine: string | null
}

/**
 * Passed, failed and skipped counts for one Vitest level, with the total Vitest reported.
 */
export interface VitestCounts {
	passed: number
	failed: number
	skipped: number
	total: number
}

/**
 * Vitest's file and test totals.
 */
interface VitestTotals {
	files: VitestCounts
	tests: VitestCounts
}

/**
 * Where a parser read its fields from.
 */
export const ParsedSource = {
	VitestJSON: "vitest-json",
	VitestText: "vitest-text",
	ScriptText: "script-text",
} as const

export type ParsedSource = (typeof ParsedSource)[keyof typeof ParsedSource]

/**
 * What a parser read from a check's output.
 */
export interface ParsedCheckOutput {
	/**
	 * Whether the parser found the lines it expects.
	 *
	 * When `false`, `reason` states what was missing, and every count is `null`.
	 */
	parsed: boolean
	reason: string | null
	source: ParsedSource
	errors: number | null
	warnings: number | null
	/**
	 * The scripts or repository checks the output names as failing.
	 */
	failingChecks: string[]
	failingTests: FailingTest[]
	totals: VitestTotals | null
	/**
	 * The first error lines, at most {@link MAX_ERROR_LINES}, so a result shows what failed without the log.
	 */
	errorLines: string[]
}

/**
 * The most error lines a result repeats from the log.
 */
export const MAX_ERROR_LINES = 20

/**
 * A result for output the parser couldn't read.
 */
export function unparsed(source: ParsedSource, reason: string): ParsedCheckOutput {
	return {
		parsed: false,
		reason,
		source,
		errors: null,
		warnings: null,
		failingChecks: [],
		failingTests: [],
		totals: null,
		errorLines: [],
	}
}
