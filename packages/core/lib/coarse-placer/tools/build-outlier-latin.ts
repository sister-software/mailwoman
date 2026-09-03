/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Latin-script off-map outlier exposure for the #244 coarse-placer (milestone 3). M2's OTHER class
 *   was trained on NON-Latin/non-CJK scripts (Cyrillic, Arabic, …) from WOF names, so off-map
 *   COUNTRIES written in Latin script (Poland, Brazil, Mexico, …) still mis-place to a trained
 *   Latin country (the "Latin-off-map residual"). The fix is REAL off-map addresses (not synthetic
 *   name variants — see #564: synthetic mass fits its own quirks): assemble address strings from
 *   the Overture per-country address parquet and append them as `country: "OTHER"`.
 *
 *   Discipline: countries split into TRAIN (their rows feed train/val OTHER) and HELDOUT (rows go
 *   ONLY to the dedicated test file), so we can measure generalization to off-map countries the
 *   model never saw — not just memorization. The in-map test.jsonl is left UNTOUCHED so the
 *   before/after in-map regression check stays clean; the Latin metric lives in its own file.
 *
 *   Run AFTER build-dataset + the exposure outliers (it appends). Re-runnable: it rewrites the
 *   dedicated test file and appends fresh OTHER rows (so don't run it twice onto the same splits
 *   without rebuilding train/val).
 *
 *   Run: `mailwoman placer build-dataset --outliers latin [--per-country 6000] [--overture
 *   $MAILWOMAN_DATA_ROOT/overture/2026-05-20.0]`
 */

import { type PathBuilderLike, resolvePath } from "path-ts"

import { hashFNV1a } from "#coarse-placer/fnv-hash"
import { assembleOutlierRow, collectOutlierRows, otherRowsJSONL } from "#coarse-placer/tools/outlier-rows"
import { defaultDataDir } from "#coarse-placer/tools/paths"
import { errorMessage } from "#errors/schema"
import { writeLocalTextFile, appendLocalTextFile } from "#fs/writers"
import { dataRootPath } from "#utils"

interface LatinTestRow {
	raw: string
	country: string
	group: string
	srcCountry: string
}

/**
 * Options for {@linkcode buildOutlierLatin}.
 */
export interface BuildOutlierLatinOptions {
	/**
	 * Rows sampled per off-map country. Default 6000.
	 */
	perCountry?: number
	/**
	 * Overture release dir. Default `$MAILWOMAN_DATA_ROOT/overture/2026-05-20.0`.
	 */
	overture?: PathBuilderLike
	/**
	 * Dataset dir the OTHER rows append to. Default `<repo>/data/coarse-placer`.
	 */
	data?: PathBuilderLike
}

/**
 * Result of {@linkcode buildOutlierLatin}.
 */
export interface BuildOutlierLatinResult {
	train: number
	val: number
	test: number
}

/**
 * Off-map (NOT among the trained countries) and Latin-script. TRAIN feeds the OTHER class; HELDOUT is test-only — the
 * generalization probe (unseen off-map countries should still route OTHER). #743: PL/PT/CZ moved from OTHER to
 * FIRST-CLASS in-map countries (they're now in COARSE_CLASSES), so they're removed here — keeping them would feed
 * contradictory gold (the same address labelled both PL and OTHER). That leaves BR/MX as the Latin off-map TRAIN
 * exposure and CA/LI as the heldout probe (the hard near-twins of in-map US/DE — an honest worst case). The in-map
 * expansion itself shrinks the off-map Latin surface, and the bulk OTHER exposure is non-Latin (build-
 * outlier-exposure.ts), so the thinner Latin train set is acceptable; watch OTHER-Latin recall in the openset eval.
 */
const TRAIN_COUNTRIES = ["BR", "MX"]
const HELDOUT_COUNTRIES = ["CA", "LI"]

/**
 * Address_levels arrives as a list (node-api) or its string repr; pull the value strings out.
 */
function levelValues(al: unknown): string[] {
	if (Array.isArray(al)) return al.flatMap((x) => (x && x.value ? [String(x.value)] : []))
	const s = String(al ?? "")
	const out: string[] = []

	for (const m of s.matchAll(/'value':\s*'([^']*)'/g)) {
		out.push(m[1]!)
	}

	if (!out.length) {
		for (const m of s.matchAll(/"value":\s*"([^"]*)"/g)) {
			out.push(m[1]!)
		}
	}

	return out
}

/**
 * Overture locality: `postal_city`, falling back to the last (then first) `address_levels` value.
 */
function overtureLocality(r: Record<string, unknown>): string {
	const levels = levelValues(r.address_levels)

	return (r.postal_city ? String(r.postal_city) : "") || levels.at(-1) || levels[0] || ""
}

/**
 * Coarse-placer Overture Latin-off-map outlier builder — see the module doc.
 */
export async function buildOutlierLatin(
	options: BuildOutlierLatinOptions = {},
	report?: (line: string) => void
): Promise<BuildOutlierLatinResult> {
	const PER = options.perCountry ?? 6000
	const overtureDir = options.overture || dataRootPath("overture", "2026-05-20.0")
	const dataDir = options.data || defaultDataDir()

	// Heavy dep (devDependency — operator tooling), lazy-imported so loading the tools barrel stays cheap.
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const duck = await (await DuckDBInstance.create()).connect()

	async function rowsFor(cc: string): Promise<string[]> {
		const f = resolvePath(overtureDir, `addresses-${cc.toLowerCase()}.parquet`)
		let res

		try {
			res = await duck.runAndReadAll(
				`SELECT number, street, postcode, postal_city, address_levels FROM read_parquet('${f}') LIMIT ${PER}`
			)
		} catch (error) {
			// oxlint-disable-next-line mailwoman/prefer-spliterator -- An in-memory error message, not a file.
			report?.(`  ${cc}: SKIP (${errorMessage(error).split("\n")[0]})`)

			return []
		}

		return collectOutlierRows(res.getRowObjects().map((r) => assembleOutlierRow(r, { locality: overtureLocality })))
	}

	const trainAppend: string[] = []
	const valAppend: string[] = []
	const testRows: LatinTestRow[] = []

	// dedicated Latin off-map test: {raw, country:"OTHER", group, srcCountry}

	for (const cc of TRAIN_COUNTRIES) {
		const rows = (await rowsFor(cc)).toSorted((a, b) => hashFNV1a(a) - hashFNV1a(b))
		const nVal = Math.floor(rows.length * 0.1)
		const nTest = Math.floor(rows.length * 0.1)
		const val = rows.slice(0, nVal)
		const test = rows.slice(nVal, nVal + nTest)
		const train = rows.slice(nVal + nTest)

		for (const raw of train) {
			trainAppend.push(raw)
		}

		for (const raw of val) {
			valAppend.push(raw)
		}

		for (const raw of test) {
			testRows.push({ raw, country: "OTHER", group: "indist", srcCountry: cc })
		}

		report?.(`  TRAIN ${cc}: ${rows.length} (train ${train.length} / val ${val.length} / test ${test.length})`)
	}

	for (const cc of HELDOUT_COUNTRIES) {
		const rows = await rowsFor(cc)

		for (const raw of rows) {
			testRows.push({ raw, country: "OTHER", group: "heldout", srcCountry: cc })
		}

		report?.(`  HELDOUT ${cc}: ${rows.length} (test-only)`)
	}

	;(duck as { disconnect?: () => void }).disconnect?.()

	// Append OTHER rows to train/val; write the dedicated Latin off-map test file.
	await appendLocalTextFile(otherRowsJSONL(trainAppend), resolvePath(dataDir, "train.jsonl"))
	await appendLocalTextFile(otherRowsJSONL(valAppend), resolvePath(dataDir, "val.jsonl"))

	await writeLocalTextFile(
		testRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
		resolvePath(dataDir, "test-latin-offmap-overture.jsonl")
	)

	report?.(`\nappended OTHER → train +${trainAppend.length}, val +${valAppend.length}`)

	report?.(
		`wrote test-latin-offmap-overture.jsonl: ${testRows.length} rows (indist ${testRows.filter((r) => r.group === "indist").length} / heldout ${testRows.filter((r) => r.group === "heldout").length})`
	)

	return { train: trainAppend.length, val: valAppend.length, test: testRows.length }
}
