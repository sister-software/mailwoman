// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reads Vitest's totals and failing tests, from its JSON reporter or from its default reporter's text.
 *
 * For a local run, read Vitest's JSON report beside the log first.
 * Read the log text when that report is missing, such as when the run stopped before Vitest wrote it.
 *
 * Logs downloaded from GitHub Actions also go to the text reader.
 */

import { isPresent } from "@mailwoman/core/values/objects"
import { relative } from "path-ts"

import { checkOutputLines } from "#check-kit/output-lines"
import {
	type FailingTest,
	MAX_ERROR_LINES,
	type ParsedCheckOutput,
	ParsedSource,
	unparsed,
	type VitestCounts,
} from "#check-kit/parsed"

/**
 * The fields of Vitest's JSON reporter output that this reader uses.
 */
interface VitestJSONReport {
	numFailedTests: number
	numTotalTests: number
	success: boolean
	testResults: Array<{
		name: string
		status: "failed" | "passed"
		message: string
		assertionResults: Array<{
			ancestorTitles: string[]
			title: string
			status: string
			failureMessages: string[] | null
		}>
	}>
}

function firstLine(text: string | null | undefined): string | null {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one error message, already in memory
	const line = text?.split("\n").find((candidate) => candidate.trim())

	return line?.trim() ?? null
}

const SKIPPED_STATUSES = new Set(["skipped", "pending", "todo"])

function isVitestJSONReport(value: unknown): value is VitestJSONReport {
	const report = value as Partial<VitestJSONReport> | null

	return typeof report === "object" && report != null && Array.isArray(report.testResults)
}

/**
 * Read Vitest's JSON reporter output.
 *
 * @param checkout The directory Vitest ran in, so each file is reported relative
 * to it as the text reporter prints it.
 */
export function parseVitestReport(report: unknown, checkout: string): ParsedCheckOutput {
	if (!isVitestJSONReport(report)) {
		return unparsed(ParsedSource.VitestJSON, "the Vitest JSON report has no testResults array")
	}

	const files: VitestCounts = { passed: 0, failed: 0, skipped: 0, total: report.testResults.length }
	const tests: VitestCounts = { passed: 0, failed: 0, skipped: 0, total: 0 }
	const failingTests: FailingTest[] = []

	for (const file of report.testResults) {
		const path = relative(checkout, file.name)
		const assertions = file.assertionResults

		tests.total += assertions.length

		for (const assertion of assertions) {
			if (assertion.status === "passed") {
				tests.passed++
			} else if (assertion.status === "failed") {
				tests.failed++

				failingTests.push({
					file: path,
					name: [...assertion.ancestorTitles, assertion.title].join(" > "),
					firstErrorLine: firstLine(assertion.failureMessages?.[0]),
				})
			} else if (SKIPPED_STATUSES.has(assertion.status)) {
				tests.skipped++
			}
		}

		if (file.status === "failed") {
			files.failed++

			// A file that failed with no failing test failed outside a test, such as on an import error.
			if (!assertions.some((assertion) => assertion.status === "failed")) {
				failingTests.push({ file: path, name: null, firstErrorLine: firstLine(file.message) })
			}
		} else if (assertions.length && assertions.every((assertion) => SKIPPED_STATUSES.has(assertion.status))) {
			files.skipped++
		} else {
			files.passed++
		}
	}

	return {
		parsed: true,
		reason: null,
		source: ParsedSource.VitestJSON,
		errors: failingTests.length,
		warnings: 0,
		failingChecks: [],
		failingTests,
		totals: { files, tests },
		errorLines: firstErrorLines(failingTests),
	}
}

function firstErrorLines(failingTests: readonly FailingTest[]): string[] {
	return failingTests
		.map((test) => test.firstErrorLine)
		.filter(isPresent)
		.slice(0, MAX_ERROR_LINES)
}

/**
 * A summary row such as `Test Files  1 failed | 1538 passed | 21 skipped (1560)`.
 */
const SUMMARY_ROW = /^(Test Files|Tests)\s+(.+?)\s*\((\d+)\)$/u

const SUMMARY_SEGMENT = /^(\d+) (failed|passed|skipped|todo|expected fail)$/u

function summaryCounts(segments: string, total: number): VitestCounts | null {
	const counts: VitestCounts = { passed: 0, failed: 0, skipped: 0, total }

	for (const segment of segments.split("|")) {
		const match = SUMMARY_SEGMENT.exec(segment.trim())

		if (!match) return null

		const count = Number(match[1])

		switch (match[2]) {
			case "failed":
				counts.failed += count
				break
			case "skipped":
			case "todo":
				counts.skipped += count
				break
			default:
				// An expected failure is a `test.fails` test that failed as declared, so it passed.
				counts.passed += count
		}
	}

	return counts
}

const FAILURE_HEADER = /Failed (?:Tests|Suites) \d+/u

const SEPARATOR = /^[⎯\s]*(?:\[\d+\/\d+\])?[⎯\s]*$/u

/**
 * Read the default reporter's text: the `Test Files` and `Tests` summary rows,
 * and the `Failed Tests` block.
 *
 * @returns {@link unparsed} when the output holds no `Test Files` summary row.
 */
export function parseVitestText(output: string): ParsedCheckOutput {
	const lines = checkOutputLines(output).map((line) => line.text)
	let files: VitestCounts | null = null
	let tests: VitestCounts | null = null
	const failingTests: FailingTest[] = []
	let inFailures = false
	let awaitingError: FailingTest[] = []

	for (const line of lines) {
		const text = line.trim()
		const summary = SUMMARY_ROW.exec(text)

		if (summary) {
			const counts = summaryCounts(summary[2]!, Number(summary[3]))

			if (counts) {
				if (summary[1] === "Test Files") {
					files = counts
				} else {
					tests = counts
				}

				inFailures = false

				continue
			}
		}

		if (FAILURE_HEADER.test(text)) {
			inFailures = true

			continue
		}

		if (!inFailures || !text || SEPARATOR.test(text)) continue

		if (text.startsWith("FAIL ")) {
			const target = text.slice("FAIL ".length).trim()
			const split = target.indexOf(" > ")

			const failing: FailingTest =
				split === -1
					? { file: target.replace(/\s*\[.*\]$/u, ""), name: null, firstErrorLine: null }
					: { file: target.slice(0, split), name: target.slice(split + 3), firstErrorLine: null }

			failingTests.push(failing)
			awaitingError.push(failing)

			continue
		}

		// Vitest prints one error under every test that shares it.
		for (const failing of awaitingError) {
			failing.firstErrorLine = text
		}

		awaitingError = []
	}

	if (!files) return unparsed(ParsedSource.VitestText, "the output holds no Vitest `Test Files` summary row")

	return {
		parsed: true,
		reason: null,
		source: ParsedSource.VitestText,
		errors: failingTests.length,
		warnings: 0,
		failingChecks: [],
		failingTests,
		totals: tests ? { files, tests } : null,
		errorLines: firstErrorLines(failingTests),
	}
}
