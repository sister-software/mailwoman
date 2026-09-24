/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build balanced coarse-placer train, validation, and test datasets. Sample each country
 *   separately, deduplicate addresses, then split each country's rows 80/10/10.
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
	 * Rows sampled per country.
	 *
	 * Default 50000.
	 */
	perCountry?: number
	/**
	 * Dataset output dir.
	 *
	 * Default `<repo>/data/coarse-placer`.
	 */
	data?: PathBuilderLike
}

/**
 * Result of {@linkcode buildDataset}.
 */
export interface BuildDatasetResult {
	outDir: string
	train: number
	val: number
	test: number
}

const VAL_FRAC = 0.1
const TEST_FRAC = 0.1

// Format Overture addresses in varied native forms so country prediction uses
// address features, not one fixed template.
// Apply the same deduplicated 80/10/10 split as the corpus data.
/**
 * Format a street, number, postcode, and locality as an address.
 */
function formatEU(street: unknown, number: unknown, postcode: unknown, loc: string, t: number): string {
	const s = String(street).trim()
	const num = number != null && String(number).trim() !== "" ? ` ${String(number).trim()}` : ""
	const pc = postcode != null && String(postcode).trim() !== "" ? String(postcode).trim() : ""

	switch (t) {
		case 1:
			return `${s}${num} ${loc}` // Omit postcode and comma.
		case 2:
			return `${s}${num}, ${loc}${pc ? `, ${pc}` : ""}` // Put postcode last.
		case 3:
			return `${s}, ${pc ? `${pc} ` : ""}${loc}` // Omit house number.
		default:
			return `${s}${num}, ${pc ? `${pc} ` : ""}${loc}` // {street number, postcode locality}
	}
}

/**
 * Build the coarse-placer dataset files.
 */
export async function buildDataset(
	options: BuildDatasetOptions = {},
	report?: (line: string) => void
): Promise<BuildDatasetResult> {
	const PER = options.perCountry ?? 50_000
	const OUT_DIR = resolvePathBuilder(options.data || defaultDataDir())

	const TRAIN_GLOB = dataRootPath("corpus", "versioned", "v0.5.0", "corpus-v0.5.0", "train", "*.parquet")

	// Use the newer G-NAF corpus for AU, which has more address rows than the v0.5.0 pin.
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

	// Load DuckDB only when the dataset builder runs.
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
		// Filter by country before sampling to preserve the per-country quota.
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
		// Interleave classes deterministically.
		rows.sort((a, b) => hashFNV1a(a.raw + a.country) - hashFNV1a(b.raw + b.country))
		const p = resolvePath(OUT_DIR, `${name}.jsonl`)

		await writeLocalJSONLFile(rows, p)
		report?.(`→ ${p}  (${rows.length} rows)`)
	}

	return { outDir: resolvePath(OUT_DIR), train: train.length, val: val.length, test: test.length }
}
