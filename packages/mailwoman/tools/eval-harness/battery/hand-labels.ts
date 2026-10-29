/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Disagreement rows labeled by hand against `docs/engineering/reference/label-convention.mdx`, and the scorer that
 *   compares parses with those labels.
 *
 *   Each row of the fixture records the address, the hand labels as a battery field map, and the convention rule
 *   that decided them. A row whose source labels the reader accepted records `decision: "source"`. A row the reader
 *   corrected records `decision: "corrected"` and keeps the source's labels in `source`. A row written by hand to
 *   exercise a rule records `decision: "written"`.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { JSONSpliterator } from "spliterator"

/**
 * The convention rules a hand label can name, one per section of the convention page,
 * plus `source-fields` for a row whose labels follow the source with no rule in question.
 */
export const LABEL_CONVENTION_RULES = [
	"city-shares-region-name",
	"lot-number",
	"number-sign-unit",
	"spaced-po-box",
	"unit-in-venue",
	"bare-place",
	"not-an-address-component",
	"number-as-written",
	"source-fields",
] as const

export type LabelConventionRule = (typeof LABEL_CONVENTION_RULES)[number]

/**
 * A field map: each tag's spans joined in text order, street parts joined into `street`, lowercased.
 */
export type FieldMap = Record<string, string>

/**
 * One hand-labeled row.
 */
export interface HandLabeledRow {
	id: string
	/**
	 * The disagreement group the row was drawn from.
	 */
	group: string
	country: string
	raw: string
	labels: FieldMap
	decision: "source" | "corrected" | "written"
	rule: LabelConventionRule
	/**
	 * The source's labels, kept on a corrected row.
	 */
	source?: FieldMap
	note?: string
}

/**
 * The fixture's path inside the package.
 */
export const HAND_LABELS_FIXTURE: string = resolvePackagePath(
	"mailwoman",
	"tools",
	"eval-harness",
	"fixtures",
	"label-convention",
	"disagreement-labels-v1.jsonl"
)

/**
 * Reads the hand-labeled rows, refusing a row that names no known rule, lacks labels,
 * or is corrected without keeping its source labels.
 */
export async function readHandLabels(path: string = HAND_LABELS_FIXTURE): Promise<HandLabeledRow[]> {
	const rows = await Array.fromAsync(JSONSpliterator.fromAsync<HandLabeledRow>(path))

	for (const row of rows) {
		if (!(LABEL_CONVENTION_RULES as readonly string[]).includes(row.rule)) {
			throw new Error(`${path}: row ${row.id} names the unknown rule ${row.rule}`)
		}

		if (!Object.keys(row.labels).length) throw new Error(`${path}: row ${row.id} holds no labels`)

		if (row.decision === "corrected" && !row.source) {
			throw new Error(`${path}: corrected row ${row.id} keeps no source labels`)
		}
	}

	return rows
}

/**
 * Whether two field maps hold the same fields with the same values.
 */
export function sameFieldMap(a: FieldMap, b: FieldMap): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])

	return [...keys].every((key) => a[key] === b[key])
}

/**
 * One arm's agreement with the hand labels and with the source's labels on the same rows.
 */
export interface HandLabelScore {
	arm: string
	rows: number
	rightByHand: number
	/**
	 * Rows right against the source's labels, the hand labels standing in on a row with no source.
	 */
	rightBySource: number
}

/**
 * Scores each arm's parses, keyed by row id, against the hand labels and against the source's labels.
 *
 * @throws When an arm holds no parse for a row.
 */
export function scoreHandLabels(
	rows: readonly HandLabeledRow[],
	parses: ReadonlyMap<string, ReadonlyMap<string, FieldMap>>
): HandLabelScore[] {
	return [...parses].map(([arm, byID]) => {
		const score: HandLabelScore = { arm, rows: 0, rightByHand: 0, rightBySource: 0 }

		for (const row of rows) {
			const parse = byID.get(row.id)

			if (!parse) throw new Error(`hand-labeled row ${row.id} holds no parse for ${arm}`)

			score.rows++

			if (sameFieldMap(parse, row.labels)) {
				score.rightByHand++
			}

			if (sameFieldMap(parse, row.decision === "corrected" ? row.source! : row.labels)) {
				score.rightBySource++
			}
		}

		return score
	})
}
