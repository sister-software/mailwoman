/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-country accuracy of two models on the same held-out corpus rows.
 *
 *   The regression board holds rows for the locales the model already served, so a corpus change that adds
 *   countries shows its gains only where the board happens to hold a row. This grader reads rows that
 *   `corpus split-slice` routed to the test split, which no model trained on that corpus or its bases has seen,
 *   and scores every arm on the same rows. Each row is parsed with its own country as the locale hint, and a
 *   gold span counts as recovered when the parse holds its text, folded, under the same tag.
 */

import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { normalizeDuckDBValue } from "@mailwoman/corpus/parquet/streams"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"
import type { PathBuilderLike } from "path-ts"

/**
 * One held-out row, in the corpus parquet schema.
 */
export interface HeldoutRow {
	raw: string
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	country: string | null
	source: string
}

/**
 * One country's scores for one arm.
 */
export interface CountryScore {
	rows: number
	/**
	 * Rows whose every gold span the parse recovered.
	 */
	rowsExact: number
	spans: number
	spansRecovered: number
}

/**
 * Reads up to `perCountry` test-split rows per country and row kind from a corpus manifest's test files.
 *
 * The rows of each country are ordered by a hash of their text, so the same
 * corpus yields the same sample on every run.
 *
 * @param pathRoot The local directory that stands for the manifest's `/data` prefix, such as the data root.
 */
export async function sampleHeldoutRows(
	manifestPath: PathBuilderLike,
	perCountry: number,
	pathRoot: string
): Promise<HeldoutRow[]> {
	const manifest = await readLocalJSONFile<{ slices: Array<{ path: string; split: string }> }>(manifestPath)
	const files = manifest.slices
		.filter((slice) => slice.split === "test")
		.map((slice) => slice.path.replace(/^\/data/u, pathRoot))

	if (!files.length) throw new Error(`${manifestPath.toString()} lists no test files`)

	using db = await openDuckDB()
	const list = files.map((file) => `'${escapeSQLString(file)}'`).join(", ")

	const reader = await db.runAndReadAll(
		`SELECT raw, span_starts, span_ends, span_tags, country, source FROM read_parquet([${list}], union_by_name = true) ` +
			// Each country draws its quota of address rows and of gazetteer rows separately (`heldoutRowKind`).
			`QUALIFY row_number() OVER (PARTITION BY coalesce(country, 'ZZ'), starts_with(source, 'wof-') ORDER BY hash(raw)) <= ` +
			Math.trunc(perCountry).toString()
	)

	return reader
		.getRowObjects()
		.map(
			(row) =>
				Object.fromEntries(
					Object.entries(row).map(([key, value]) => [key, normalizeDuckDBValue(value)])
				) as unknown as HeldoutRow
		)
}

/**
 * Whether a row is a gazetteer surface or an address, read from its source.
 *
 * Who's On First sources render place names with their admin parents, such as
 * `Wollin, Mecklenburg-Vorpommern`, and make up most of a small country's test rows.
 * Scored together with addresses they set a country's score by the source mix
 * rather than by how the model reads addresses.
 */
export function heldoutRowKind(source: string): "gazetteer" | "address" {
	return source.startsWith("wof-") ? "gazetteer" : "address"
}

/**
 * Scores one model over every row, grouped by the row's country
 * and {@link heldoutRowKind}, keyed `<country>/<kind>`.
 *
 * @param cacheRoot A package-shaped weights directory, as `mwdev_arc` takes.
 */
export async function scoreHeldoutByCountry(
	rows: readonly HeldoutRow[],
	cacheRoot: string
): Promise<Map<string, CountryScore>> {
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot })
	const scores = new Map<string, CountryScore>()

	for (const row of rows) {
		const country = `${row.country ?? "ZZ"}/${heldoutRowKind(row.source)}`
		const score = scores.get(country) ?? { rows: 0, rowsExact: 0, spans: 0, spansRecovered: 0 }

		const byTag = groupTuplesByTag(
			await classifier.parse(row.raw, { postcodeRepair: true, ...(row.country ? { localeHint: row.country } : {}) })
		)

		let exact = true

		for (const [i, tag] of row.span_tags.entries()) {
			const gold = foldCaseWhitespace(row.raw.slice(row.span_starts[i], row.span_ends[i]))

			score.spans++

			if ((byTag.get(tag) ?? []).some((value) => foldCaseWhitespace(value) === gold)) {
				score.spansRecovered++
			} else {
				exact = false
			}
		}

		score.rows++

		if (exact) {
			score.rowsExact++
		}

		scores.set(country, score)
	}

	return scores
}
