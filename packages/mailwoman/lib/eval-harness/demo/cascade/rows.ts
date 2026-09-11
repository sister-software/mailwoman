/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Row schema + loud validation for the demo-cascade smoke eval (#524). Split out of the runner
 *   (`demo-cascade-smoke.ts`) so the schema contract is unit-testable without loading the model /
 *   the hot DB — a malformed row must fail NAMING the row, never silently skip or crash mid-run.
 *
 *   Row convention (see `data/eval/external/demo-cascade-smoke.README.md`): each row asserts the
 *   RESOLVED WOF PLACE ID of the top cascade hit — the whole-stack contract — not parse components.
 *   Exactly one of `expect.id` (a verified WOF id) or `expect.anchor_centroid` (postcode-only dead
 *   ends where the slim DB has no row and the demo synthesizes an anchor-centroid hit) per row.
 *
 *   RESTORED 2026-08-06. The 2026-07-10 probe triage (c61159ef) swept this file into the gitignored
 *   `scripts/diagnostic/` drawer while leaving its only importer — `demo-cascade-smoke.ts`, a
 *   promotion-eval battery leg — behind in `scripts/eval/`. The commit message's "check spawn targets
 *   verified present post-move" was true of the spawn TARGET and false of its dependency, so the
 *   cascade leg has been an `ERR_MODULE_NOT_FOUND` ever since; it was spawned with `nothrow` and only
 *   when a `wof-hot.db` was present, which is why nothing surfaced it for four weeks.
 */

import { parseJSONStrict } from "@mailwoman/core/json"

export interface SmokeRowExpect {
	/**
	 * The WOF place id the cascade's TOP hit must carry. Verified against the gazetteer.
	 */
	id?: number
	/**
	 * Human-readable cross-check (not graded — the id is the assertion).
	 */
	name?: string
	/**
	 * Human-readable cross-check (not graded — the id is the assertion).
	 */
	placetype?: string
	/**
	 * The cascade dead-ends (no WOF row) and the demo's anchor-centroid fallback must fire instead. Mutually exclusive
	 * with `id`.
	 */
	anchor_centroid?: boolean
}

export interface SmokeRow {
	input: string
	expect: SmokeRowExpect
	/**
	 * Why this row is here (bug number, preset name, failure mode it pins).
	 */
	note?: string
	/**
	 * Provenance: issue / preset / report the row came from.
	 */
	source?: string
}

const EXPECT_KEYS = new Set(["id", "name", "placetype", "anchor_centroid"])
const ROW_KEYS = new Set(["input", "expect", "note", "source"])

/**
 * How much of an offending row the error echoes back. Long enough to recognize the row at a glance, short enough that a
 * pathological single-line file cannot flood the terminal.
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
 * Parse + validate a JSONL smoke-row file. Throws a {@link SmokeRowError} naming the 1-based row number (and echoing the
 * offending line) on ANY malformed row. Returns at least one row — an empty file is an error, not a vacuous pass.
 */
export function parseSmokeRows(text: string, sourceLabel: string): SmokeRow[] {
	// The row NUMBER is the point of this parser: every error names the 1-based line a human would
	// count to in the file. TextSpliterator drops empty segments, so a fixture with a blank line
	// renumbers every row after it — measured, by the "numbers rows by FILE line" case in
	// demo-cascade-rows.test.ts, which caught exactly that when this was briefly a spliterator.
	// split() keeps blank lines, and the input is one bounded committed fixture.
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
				throw new SmokeRowError(sourceLabel, rowNumber, `unknown key ${JSON.stringify(key)}`, line)
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
					`unknown \`expect\` key ${JSON.stringify(key)} (allowed: ${[...EXPECT_KEYS].join(", ")})`,
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

		// Assembled field by field rather than cast: every value above has been checked, and building the row from those
		// checks is what makes the schema and the validator one statement instead of two that can drift.
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
