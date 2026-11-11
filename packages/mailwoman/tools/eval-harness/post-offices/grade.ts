/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Grades parses of the post-office suite, one component at a time.
 *
 *   The suite is a must-pass floor rather than a scored board: an official post-office address is a
 *   simple, well-formed query, so every row has to parse as expected and any failure is a defect.
 *
 *   A row's components are compared span by span. For each component tag the row expects or the parse
 *   returns, the parse passes when its spans of that tag sit at exactly the expected boundaries, with
 *   whitespace at the edges trimmed. Before comparing, each side's street-family spans
 *   (`street_prefix`, `street`, `street_suffix`) that touch are joined into one `street` span, so the
 *   expected street `Malabar Road Southwest` is met by a parse that splits its type and directional, in
 *   every country alike. A tag the row doesn't expect and the parse returns is a failure of that tag.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import { heldoutRowID } from "#tools/eval-harness/heldout/per/country"
import type { PipelineParse } from "#tools/eval-harness/pipeline-parse/worker"
import type { PostOfficeSuiteRow } from "#tools/eval-harness/post-offices/rows"
import {
	type ComponentSpan,
	joinStreetSpans,
	trimSpan,
	validateAnnotatedSpans,
} from "#tools/eval-harness/score/exact-parse"

/**
 * One component's comparison on one row.
 */
export interface PostOfficeComponentOutcome {
	tag: string
	/**
	 * The expected text of each span of the tag, in source order.
	 */
	expected: string[]
	/**
	 * The parsed text of each span of the tag, in source order.
	 */
	observed: string[]
	pass: boolean
}

/**
 * One row's grade.
 */
export interface PostOfficeRowGrade {
	rowID: string
	raw: string
	country: string
	form: string
	pass: boolean
	components: PostOfficeComponentOutcome[]
}

function spanKey(span: ComponentSpan): string {
	return `${span.start}:${span.end}`
}

function byTag(raw: string, spans: readonly ComponentSpan[]): Map<string, ComponentSpan[]> {
	const grouped = new Map<string, ComponentSpan[]>()

	for (const span of joinStreetSpans(raw, spans)) {
		const trimmed = trimSpan(raw, span)

		if (trimmed.start === trimmed.end) continue

		grouped.set(trimmed.tag, [...(grouped.get(trimmed.tag) ?? []), trimmed])
	}

	return grouped
}

/**
 * Grade one row's parse.
 */
export function gradePostOfficeRow(row: PostOfficeSuiteRow, parse: Pick<PipelineParse, "spans">): PostOfficeRowGrade {
	const rowID = heldoutRowID(row)
	const expected = byTag(row.raw, validateAnnotatedSpans(row, rowID))

	const observed = byTag(
		row.raw,
		parse.spans.map(([tag, start, end]) => ({ tag, start, end }))
	)

	const text = (spans: readonly ComponentSpan[] | undefined) =>
		(spans ?? []).toSorted((a, b) => a.start - b.start).map((span) => row.raw.slice(span.start, span.end))

	const components = [...new Set([...expected.keys(), ...observed.keys()])].toSorted().map((tag) => {
		const want = (expected.get(tag) ?? []).map(spanKey).toSorted()
		const got = (observed.get(tag) ?? []).map(spanKey).toSorted()

		return {
			tag,
			expected: text(expected.get(tag)),
			observed: text(observed.get(tag)),
			pass: want.length === got.length && want.every((key, index) => key === got[index]),
		}
	})

	return {
		rowID,
		raw: row.raw,
		country: row.country ?? "ZZ",
		form: row.form,
		pass: components.every((component) => component.pass),
		components,
	}
}

/**
 * One component's totals over a suite.
 */
export interface PostOfficeComponentTotal {
	tag: string
	/**
	 * Rows that expect the tag or whose parse returned it.
	 */
	rows: number
	failed: number
}

/**
 * A suite's totals: rows, failed rows, and each component's failures over the rows it applies to.
 */
export interface PostOfficeSuiteSummary {
	rows: number
	failedRows: number
	components: PostOfficeComponentTotal[]
}

export function summarizePostOfficeGrades(grades: readonly PostOfficeRowGrade[]): PostOfficeSuiteSummary {
	const components = new Map<string, PostOfficeComponentTotal>()

	for (const grade of grades) {
		for (const component of grade.components) {
			const total = components.get(component.tag) ?? { tag: component.tag, rows: 0, failed: 0 }

			total.rows++
			total.failed += component.pass ? 0 : 1
			components.set(component.tag, total)
		}
	}

	return {
		rows: grades.length,
		failedRows: grades.filter((grade) => !grade.pass).length,
		components: [...components.values()].toSorted((a, b) => a.tag.localeCompare(b.tag)),
	}
}

/**
 * The report's lines: the row and per-component counts with their denominators, then each
 * failing row's input beside the expected and observed text of each failing component.
 */
export function postOfficeSuiteReport(grades: readonly PostOfficeRowGrade[]): string[] {
	const summary = summarizePostOfficeGrades(grades)

	const lines = [
		`post-office suite: ${summary.rows - summary.failedRows}/${summary.rows} rows parse as expected, ${summary.failedRows} fail`,
		...summary.components.map(
			(total) => `  ${total.tag}: ${total.failed} of ${total.rows} rows differ from the expected value`
		),
	]

	for (const grade of grades) {
		if (grade.pass) continue

		lines.push(`FAIL ${grade.rowID} [${grade.country} ${grade.form}] ${stringifyJSON(grade.raw)}`)

		for (const component of grade.components) {
			if (component.pass) continue

			lines.push(
				`  ${component.tag}: expected ${stringifyJSON(component.expected)}, observed ${stringifyJSON(component.observed)}`
			)
		}
	}

	return lines
}
