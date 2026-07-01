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
 */

export interface SmokeRowExpect {
	/** The WOF place id the cascade's TOP hit must carry. Verified against the gazetteer. */
	id?: number
	/** Human-readable cross-check (not graded — the id is the assertion). */
	name?: string
	/** Human-readable cross-check (not graded — the id is the assertion). */
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
	/** Why this row is here (bug number, preset name, failure mode it pins). */
	note?: string
	/** Provenance: issue / preset / report the row came from. */
	source?: string
}

const EXPECT_KEYS = new Set(["id", "name", "placetype", "anchor_centroid"])
const ROW_KEYS = new Set(["input", "expect", "note", "source"])

class SmokeRowError extends Error {
	constructor(sourceLabel: string, rowNumber: number, detail: string, rowText?: string) {
		super(
			`${sourceLabel}: row ${rowNumber} is malformed — ${detail}` +
				(rowText !== undefined ? `\n  row: ${rowText.length > 200 ? rowText.slice(0, 200) + "…" : rowText}` : "")
		)
		this.name = "SmokeRowError"
	}
}

/**
 * Parse + validate a JSONL smoke-row file. Throws a {@link SmokeRowError} naming the 1-based row number (and echoing the
 * offending line) on ANY malformed row. Returns at least one row — an empty file is an error, not a vacuous pass.
 */
export function parseSmokeRows(text: string, sourceLabel: string): SmokeRow[] {
	const lines = text.split("\n")
	const rows: SmokeRow[] = []

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim()

		if (!line || line.startsWith("//") || line.startsWith("#")) continue
		const rowNumber = i + 1

		let parsed: unknown

		try {
			parsed = JSON.parse(line)
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

		rows.push(row as unknown as SmokeRow)
	}

	if (rows.length === 0) {
		throw new Error(`${sourceLabel}: no rows found — an empty smoke file is an error, not a vacuous pass`)
	}

	return rows
}
