/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds balanced coarse-placer train, validation and test sets. Each country is sampled separately,
 *   deduplicated and split 80/10/10.
 */

import { type PathBuilderLike, resolvePath, resolvePathBuilder } from "path-ts"

import { hashFNV1a } from "#coarse-placer/fnv-hash"
import { COUNTRIES, IN_MAP_EU, NEW_EU } from "#coarse-placer/tools/country-sets"
import { defaultDataDir } from "#coarse-placer/tools/paths"
import { dataRootPath } from "#data-root"
import { errorMessage } from "#errors/schema"
import { makeDirectories, writeLocalJSONLFile } from "#fs/writers"
import { OVERTURE_ADDRESSES_RELEASE } from "#overture-pins"

interface DatasetRow {
	raw: string
	country: string
}

/**
 * Options for {@linkcode buildDataset}.
 */
export interface BuildDatasetOptions {
	/**
	 * The number of rows sampled per country.
	 * The default is 50,000.
	 */
	perCountry?: number
	/**
	 * The output directory.
	 * The default is `<repo>/data/coarse-placer`.
	 */
	data?: PathBuilderLike
}

/**
 * The output directory and row count of each split from {@linkcode buildDataset}.
 */
export interface BuildDatasetResult {
	outDir: string
	train: number
	val: number
	test: number
}

const VAL_FRAC = 0.1
const TEST_FRAC = 0.1

/**
 * Formats an Overture address in one of four layouts chosen by `t`.
 *
 * Varying the layout makes the classifier learn from address content instead of one fixed template.
 */
function formatEU(street: unknown, number: unknown, postcode: unknown, loc: string, t: number): string {
	const s = String(street).trim()
	const num = number != null && String(number).trim() !== "" ? ` ${String(number).trim()}` : ""
	const pc = postcode != null && String(postcode).trim() !== "" ? String(postcode).trim() : ""

	switch (t) {
		case 1:
			// This layout has no postcode or comma.
			return `${s}${num} ${loc}`
		case 2:
			// This layout puts the postcode last.
			return `${s}${num}, ${loc}${pc ? `, ${pc}` : ""}`
		case 3:
			// This layout has no house number.
			return `${s}, ${pc ? `${pc} ` : ""}${loc}`
		default:
			return `${s}${num}, ${pc ? `${pc} ` : ""}${loc}`
	}
}

/**
 * Builds the coarse-placer dataset files.
 */
export async function buildDataset(
	options: BuildDatasetOptions = {},
	report?: (line: string) => void
): Promise<BuildDatasetResult> {
	const PER = options.perCountry ?? 50_000
	const OUT_DIR = resolvePathBuilder(options.data || defaultDataDir())

	const TRAIN_GLOB = dataRootPath("corpus", "versioned", "v0.5.0", "corpus-v0.5.0", "train", "*.parquet")

	// AU rows come from the G-NAF corpus, which has more AU rows than v0.5.0.
	const AU_GLOB = dataRootPath(
		"corpus",
		"versioned",
		"v0.9.2-multilocale-au",
		"corpus-v0.9.2-multilocale-au",
		"train",
		"*.parquet"
	)

	const OVERTURE_DIR = dataRootPath("overture", OVERTURE_ADDRESSES_RELEASE)
	await makeDirectories(OUT_DIR)

	const { DuckDBInstance } = await import("@duckdb/node-api")
	const duck = await (await DuckDBInstance.create()).connect()

	await duck.run("SET memory_limit='4GB'; SET threads=4;")

	const train: DatasetRow[] = [],
		val: DatasetRow[] = [],
		test: DatasetRow[] = []

	const CORPUS_SOURCES: ReadonlyArray<[string, string]> = [
		...COUNTRIES.map((c): [string, string] => [c, TRAIN_GLOB.toString()]),
		["AU", AU_GLOB.toString()],
	]

	for (const [country, glob] of CORPUS_SOURCES) {
		// The country filter runs before sampling so each country gets its full quota.
		const q = `SELECT raw FROM (
				SELECT raw FROM read_parquet('${glob}') WHERE country = '${country}' AND nullif(trim(raw), '') IS NOT NULL
			) USING SAMPLE ${Math.ceil(PER * 1.3)} ROWS`

		const res = await duck.runAndReadAll(q)
		const seen = new Set<string>()
		const rows: string[] = []

		for (const r of res.getRowObjects()) {
			if (rows.length >= PER) break
			const raw = String(r.raw).trim()

			if (!raw || seen.has(raw)) continue
			seen.add(raw)
			rows.push(raw)
		}

		const nVal = Math.floor(rows.length * VAL_FRAC)
		const nTest = Math.floor(rows.length * TEST_FRAC)
		const valRows = rows.slice(0, nVal)
		const testRows = rows.slice(nVal, nVal + nTest)
		const trainRows = rows.slice(nVal + nTest)

		for (const raw of trainRows) {
			train.push({ raw, country })
		}

		for (const raw of valRows) {
			val.push({ raw, country })
		}

		for (const raw of testRows) {
			test.push({ raw, country })
		}

		report?.(`  ${country}: train ${trainRows.length}  val ${valRows.length}  test ${testRows.length}`)
	}

	for (const country of [...NEW_EU, ...IN_MAP_EU]) {
		const parquet = `${OVERTURE_DIR}/addresses-${country.toLowerCase()}.parquet`

		const q = `SELECT street, number, postcode,
				COALESCE(NULLIF(trim(postal_city), ''), address_levels[len(address_levels)].value) AS loc
			FROM read_parquet('${parquet}')
			WHERE street IS NOT NULL AND trim(street) <> ''
			USING SAMPLE ${Math.ceil(PER * 1.4)} ROWS`

		let res

		try {
			res = await duck.runAndReadAll(q)
		} catch (error) {
			report?.(`  ${country}: SKIPPED — ${errorMessage(error)}`)

			continue
		}

		const seen = new Set<string>()
		const rows: string[] = []

		for (const r of res.getRowObjects()) {
			if (rows.length >= PER) break
			const loc = r.loc == null ? "" : String(r.loc).trim()

			if (!loc) continue

			const raw = formatEU(r.street, r.number, r.postcode, loc, hashFNV1a(`${r.street}|${loc}`) % 4)

			if (!raw || seen.has(raw)) continue

			seen.add(raw)
			rows.push(raw)
		}

		const nVal = Math.floor(rows.length * VAL_FRAC)
		const nTest = Math.floor(rows.length * TEST_FRAC)

		for (const raw of rows.slice(0, nVal)) {
			val.push({ raw, country })
		}

		for (const raw of rows.slice(nVal, nVal + nTest)) {
			test.push({ raw, country })
		}

		for (const raw of rows.slice(nVal + nTest)) {
			train.push({ raw, country })
		}

		report?.(`  ${country} (overture): train ${rows.length - nVal - nTest}  val ${nVal}  test ${nTest}`)
	}

	const splits: [string, DatasetRow[]][] = [
		["train", train],
		["val", val],
		["test", test],
	]

	for (const [name, rows] of splits) {
		// Sorting by hash interleaves the countries deterministically.
		rows.sort((a, b) => hashFNV1a(a.raw + a.country) - hashFNV1a(b.raw + b.country))
		const p = resolvePath(OUT_DIR, `${name}.jsonl`)

		await writeLocalJSONLFile(rows, p)
		report?.(`→ ${p}  (${rows.length} rows)`)
	}

	return { outDir: resolvePath(OUT_DIR), train: train.length, val: val.length, test: test.length }
}
