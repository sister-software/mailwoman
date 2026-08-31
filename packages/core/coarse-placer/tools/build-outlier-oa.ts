/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OpenAddresses Latin-off-map outlier exposure for the #244 coarse-placer (milestone 3, breadth).
 *   The successor to build-outlier-latin.ts (Overture): Overture's ALPHA addresses theme only
 *   carries real rows for ~7 off-map countries, so a model trained on them MEMORIZED rather than
 *   learned an "off-map" boundary (night-15 finding). OpenAddresses covers far more countries —
 *   this assembles address strings from OA's per-country CSVs and appends them as `country:
 *   "OTHER"`.
 *
 *   Discipline (per the #244 scoping note + DeepSeek consult):
 *
 *   - LEAVE-ONE-LANGUAGE-FAMILY-OUT, not random: whole families are held out (Nordic, Baltic, …) so a
 *       trained sibling's shared n-grams can't rescue the generalization metric. TRAIN families
 *       feed train/val/test(indist); HELDOUT families go ONLY to the dedicated test file.
 *   - Schema variance: read via DuckDB read_csv_auto(..., union_by_name) so differing per-source OA
 *       schemas align; assemble to the SAME format the in-map rows use (build-outlier-latin's
 *       assemble).
 *   - Dedup (per country) + per-country CAP (downsample): PL/CZ dwarf others, so cap so OTHER isn't
 *       "mostly Polish".
 *   - Country filter: only OFF-MAP countries (never the 11 in-map); the in-map test.jsonl is untouched.
 *
 *   Run AFTER build-dataset + the exposure outliers (it APPENDS). Re-runnable: rewrites the
 *   dedicated test file and appends fresh OTHER rows — rebuild train/val before re-running.
 *
 *   Run: `mailwoman placer build-dataset --outliers oa --oa-dir <extracted-OA-root> [--per-country
 *   6000]`
 */

import { type PathBuilderLike, resolvePath } from "path-ts"

import { hashFNV1a } from "#coarse-placer/fnv-hash"
import { COUNTRIES } from "#coarse-placer/tools/country-sets"
import { assembleOutlierRow, collectOutlierRows, otherRowsJSONL } from "#coarse-placer/tools/outlier-rows"
import { defaultDataDir } from "#coarse-placer/tools/paths"
import { errorMessage } from "#errors/schema"
import { writeLocalTextFile, appendLocalTextFile } from "#fs/writers"
import { dataRootPath } from "#utils"

interface OaTestRow {
	raw: string
	country: string
	group: string
	srcCountry: string
	family: string
}

/**
 * Options for {@linkcode buildOutlierOA}.
 */
export interface BuildOutlierOAOptions {
	/**
	 * Extracted OpenAddresses root. Default `$MAILWOMAN_DATA_ROOT/openaddresses/extracted`.
	 */
	oaDir?: PathBuilderLike
	/**
	 * Row cap per off-map country. Default 6000.
	 */
	perCountry?: number
	/**
	 * Dataset dir the OTHER rows append to. Default `<repo>/data/coarse-placer`.
	 */
	data?: PathBuilderLike
}

/**
 * Result of {@linkcode buildOutlierOA}.
 */
export interface BuildOutlierOAResult {
	train: number
	val: number
	test: number
	trainCountries: number
	heldoutCountries: number
}

/**
 * The in-map countries the coarse-placer routes to — never appear in OTHER.
 */
const IN_MAP = new Set<string>(COUNTRIES)

/**
 * Language/region families for the leave-one-family-out split. Off-map countries OA's europe+asia zips plausibly carry;
 * the actual TRAIN/HELDOUT set is intersected with what's on disk at runtime. HELDOUT families are the generalization
 * probe (the model never sees a single row from them). Off-map families, intersected at runtime with what OA's
 * europe+asia zips actually carry (verified on disk: ae at au be cz dk ee fi gr il is kw kz lt lu lv nc nz pl pt qa ro
 * sa se sg si sk).
 */
const FAMILIES: Record<string, string[]> = {
	slavic_latin: ["PL", "CZ", "SK", "SI"],
	romance_offmap: ["PT", "RO"],
	germanic_offmap: ["AT", "BE", "LU"],
	nordic: ["SE", "DK", "FI", "IS"],
	hellenic: ["GR"],
	central_asian: ["KZ"],
	maritime_asia: ["SG"],
	baltic: ["EE", "LV", "LT"],
	oceania: ["AU", "NZ", "NC"],
	middle_east: ["AE", "IL", "KW", "QA", "SA"],
}

/**
 * Leave-one-language-FAMILY-out probe (DeepSeek): hold out WHOLE families the model never sees a row from — Baltic
 * (Latin, distinct), Oceania (English-Latin, distinct), Middle-East (romanized non-Latin).
 */
const HELDOUT_FAMILIES = new Set(["baltic", "oceania", "middle_east"])

/**
 * OA locality: the `city` column.
 */
const oaLocality = (r: Record<string, unknown>): string => (r.city ?? "").toString().trim()

/**
 * Coarse-placer OpenAddresses Latin-off-map outlier builder — see the module doc.
 */
export async function buildOutlierOA(
	options: BuildOutlierOAOptions = {},
	report?: (line: string) => void
): Promise<BuildOutlierOAResult> {
	const oaDir = options.oaDir || dataRootPath("openaddresses", "extracted")
	const PER = options.perCountry ?? 6000
	const dataDir = options.data || defaultDataDir()

	// Heavy dep (devDependency — operator tooling), lazy-imported so loading the tools barrel stays cheap.
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const duck = await (await DuckDBInstance.create()).connect()

	/**
	 * Read+assemble up to PER deduped rows for a country from its OA CSVs (glob under the per-country dir).
	 */
	async function rowsFor(cc: string): Promise<string[]> {
		const lc = cc.toLowerCase()
		// OA collected layout: `<cc>/[<region>/]<source>.csv` (country at root; `summary/` excluded by
		// rooting the glob at <cc>). `**` matches zero-or-more dirs → handles both flat + region-nested.
		const glob = resolvePath(oaDir, lc, "**", "*.csv")
		let res

		try {
			res = await duck.runAndReadAll(
				// union_by_name aligns the differing per-source schemas; LOWER the header access so NUMBER /
				// number both resolve. Pull a generous superset, dedup+cap in JS.
				`SELECT COLUMNS('(?i)^(number|street|city|postcode)$') FROM read_csv_auto('${glob}', union_by_name=true, ignore_errors=true, sample_size=-1) LIMIT ${PER * 8}`
			)
		} catch (error) {
			// oxlint-disable-next-line mailwoman/prefer-spliterator -- An in-memory error message, not a file.
			report?.(`  ${cc}: SKIP (${errorMessage(error).split("\n")[0]})`)

			return []
		}

		const out = collectOutlierRows(
			res.getRowObjects().map((r) => {
				// COLUMNS() preserves source-case keys; normalize to lowercase access.
				const row: Record<string, unknown> = {}

				for (const [k, v] of Object.entries(r)) {
					row[k.toLowerCase()] = v
				}

				return assembleOutlierRow(row, { locality: oaLocality, requireLetterLocality: true })
			}),
			PER
		)

		return out.toSorted((a, b) => hashFNV1a(a) - hashFNV1a(b))
	}

	const trainAppend: string[] = []
	const valAppend: string[] = []
	const testRows: OaTestRow[] = [] // {raw, country:"OTHER", group, srcCountry, family}
	let trainCC = 0
	let heldCC = 0

	for (const [family, countries] of Object.entries(FAMILIES)) {
		const heldout = HELDOUT_FAMILIES.has(family)

		for (const cc of countries) {
			if (IN_MAP.has(cc)) continue
			const rows = await rowsFor(cc)

			if (!rows.length) continue

			if (heldout) {
				for (const raw of rows) {
					testRows.push({ raw, country: "OTHER", group: "heldout", srcCountry: cc, family })
				}

				heldCC++
				report?.(`  HELDOUT ${cc} (${family}): ${rows.length} (test-only)`)
			} else {
				const nVal = Math.floor(rows.length * 0.1)
				const nTest = Math.floor(rows.length * 0.1)

				for (const raw of rows.slice(0, nVal)) {
					valAppend.push(raw)
				}

				for (const raw of rows.slice(nVal, nVal + nTest)) {
					testRows.push({ raw, country: "OTHER", group: "indist", srcCountry: cc, family })
				}

				for (const raw of rows.slice(nVal + nTest)) {
					trainAppend.push(raw)
				}

				trainCC++
				report?.(`  TRAIN ${cc} (${family}): ${rows.length}`)
			}
		}
	}

	;(duck as { disconnect?: () => void }).disconnect?.()

	await appendLocalTextFile(otherRowsJSONL(trainAppend), resolvePath(dataDir, "train.jsonl"))
	await appendLocalTextFile(otherRowsJSONL(valAppend), resolvePath(dataDir, "val.jsonl"))

	await writeLocalTextFile(
		testRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
		resolvePath(dataDir, "test-latin-offmap.jsonl")
	)

	report?.(`\nTRAIN countries: ${trainCC} · HELDOUT countries: ${heldCC}`)
	report?.(`appended OTHER → train +${trainAppend.length}, val +${valAppend.length}`)

	report?.(
		`wrote test-latin-offmap.jsonl: ${testRows.length} (indist ${testRows.filter((r) => r.group === "indist").length} / heldout ${testRows.filter((r) => r.group === "heldout").length})`
	)

	return {
		train: trainAppend.length,
		val: valAppend.length,
		test: testRows.length,
		trainCountries: trainCC,
		heldoutCountries: heldCC,
	}
}
