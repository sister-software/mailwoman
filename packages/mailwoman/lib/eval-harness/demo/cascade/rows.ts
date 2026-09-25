/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Row schema and validation for the demo-cascade smoke eval. It lives apart from `smoke.ts` so tests can load it
 *   without the model or the hot database.
 */

import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"

/**
 * Expected top cascade hit for a smoke row.
 * A row sets exactly one of `id` and `anchor_centroid`.
 */
export interface SmokeRowExpect {
	/**
	 * WOF place ID that the top cascade hit must carry.
	 */
	id?: number
	/**
	 * Place name for human cross-checking.
	 * The eval does not grade it.
	 */
	name?: string
	/**
	 * Placetype for human cross-checking.
	 * The eval does not grade it.
	 */
	placetype?: string
	/**
	 * Whether the cascade finds no WOF row and the demo's anchor-centroid fallback must produce the hit.
	 */
	anchor_centroid?: boolean
}

/**
 * One smoke-eval row.
 */
export interface SmokeRow {
	input: string
	expect: SmokeRowExpect
	/**
	 * Reason the row exists, such as the failure mode it guards against.
	 */
	note?: string
	/**
	 * Issue, preset, or report that the row came from.
	 */
	source?: string
}

const EXPECT_KEYS = new Set(["id", "name", "placetype", "anchor_centroid"])
const ROW_KEYS = new Set(["input", "expect", "note", "source"])

/**
 * Maximum number of characters of an invalid row that the error message repeats.
 */
const ERROR_ROW_ECHO_LIMIT = 200

class SmokeRowError extends Error {
	constructor(sourceLabel: string, rowNumber: number, detail: string, rowText?: string) {
		super(
			`${sourceLabel}: row ${rowNumber} is malformed — ${detail}` +
				(rowText !== undefined
					? `\n  row: ${rowText.length > ERROR_ROW_ECHO_LIMIT ? rowText.slice(0, ERROR_ROW_ECHO_LIMIT) + "…" : rowText}`
					: "")
		)

		this.name = "SmokeRowError"
	}
}

/**
 * Parses and validates a JSONL smoke-row file.
 *
 * Blank lines and lines starting with `//` or `#` are skipped.
 *
 * @throws A {@link SmokeRowError} with the one-based line number and the line text when a row is invalid.
 * @throws An `Error` when the file has no rows.
 */
export function parseSmokeRows(text: string, sourceLabel: string): SmokeRow[] {
	// Error messages report file line numbers. `TextSpliterator` drops empty segments and would shift the numbering
	// after a blank line. `split()` keeps every line.
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- row numbering needs blank lines kept
	const lines = text.split("\n")
	const rows: SmokeRow[] = []

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim()

		if (!line || line.startsWith("//") || line.startsWith("#")) continue
		const rowNumber = i + 1

		let parsed: unknown

		try {
			parsed = parseJSONStrict(line)
		} catch (error) {
			throw new SmokeRowError(sourceLabel, rowNumber, `invalid JSON (${(error as Error).message})`, line)
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new SmokeRowError(sourceLabel, rowNumber, "row must be a JSON object", line)
		}

		const row = parsed as Record<string, unknown>

		for (const key of Object.keys(row)) {
			if (!ROW_KEYS.has(key)) {
				throw new SmokeRowError(sourceLabel, rowNumber, `unknown key ${stringifyJSON(key)}`, line)
			}
		}

		if (typeof row.input !== "string" || row.input.trim() === "") {
			throw new SmokeRowError(sourceLabel, rowNumber, "`input` must be a non-empty string", line)
		}

		if (typeof row.expect !== "object" || row.expect === null || Array.isArray(row.expect)) {
			throw new SmokeRowError(sourceLabel, rowNumber, "`expect` must be an object", line)
		}

		const expect = row.expect as Record<string, unknown>

		for (const key of Object.keys(expect)) {
			if (!EXPECT_KEYS.has(key)) {
				throw new SmokeRowError(
					sourceLabel,
					rowNumber,
					`unknown \`expect\` key ${stringifyJSON(key)} (allowed: ${[...EXPECT_KEYS].join(", ")})`,
					line
				)
			}
		}

		const hasID = expect.id !== undefined
		const hasAnchor = expect.anchor_centroid !== undefined

		if (hasID === hasAnchor) {
			throw new SmokeRowError(
				sourceLabel,
				rowNumber,
				"`expect` must carry exactly one of `id` (a verified WOF id) or `anchor_centroid: true`",
				line
			)
		}

		if (hasID && (typeof expect.id !== "number" || !Number.isInteger(expect.id) || expect.id <= 0)) {
			throw new SmokeRowError(sourceLabel, rowNumber, "`expect.id` must be a positive integer WOF id", line)
		}

		if (hasAnchor && expect.anchor_centroid !== true) {
			throw new SmokeRowError(sourceLabel, rowNumber, "`expect.anchor_centroid` must be literally `true`", line)
		}

		for (const key of ["name", "placetype"] as const) {
			if (expect[key] !== undefined && typeof expect[key] !== "string") {
				throw new SmokeRowError(sourceLabel, rowNumber, `\`expect.${key}\` must be a string when present`, line)
			}
		}

		for (const key of ["note", "source"] as const) {
			if (row[key] !== undefined && typeof row[key] !== "string") {
				throw new SmokeRowError(sourceLabel, rowNumber, `\`${key}\` must be a string when present`, line)
			}
		}

		// Building the row from the checked fields keeps the schema and the validation in sync.
		rows.push({
			input: row.input,
			expect: {
				...(typeof expect.id === "number" ? { id: expect.id } : {}),
				...(typeof expect.name === "string" ? { name: expect.name } : {}),
				...(typeof expect.placetype === "string" ? { placetype: expect.placetype } : {}),
				...(expect.anchor_centroid === true ? { anchor_centroid: true } : {}),
			},
			...(typeof row.note === "string" ? { note: row.note } : {}),
			...(typeof row.source === "string" ? { source: row.source } : {}),
		})
	}

	if (!rows.length) {
		throw new Error(`${sourceLabel}: no rows found — an empty smoke file is an error, not a vacuous pass`)
	}

	return rows
}
