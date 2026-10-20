/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Extract `(house number, street, locality, postcode)` tuples from built corpus parquet for the `postcode-order`
 *   recipe.
 *
 *   Each tuple keeps the corpus row's `source`, `license` and `source_id`, so the recipe's rows inherit the base
 *   source's rights and name the record behind them. The sample is capped per country and per source and spent across
 *   localities in rounds, so a cap smaller than the source still reaches every locality rather than the first few in
 *   file order.
 */

import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { parseJSONStrict } from "@mailwoman/core/json"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { moduleGraphHash } from "#build/code-hash"
import { escapeSQLString } from "#parquet/duckdb"
import type { ParquetFileRecord } from "#parquet/record"
import { type ParquetRow, rowToParquet } from "#parquet/schema"
import { openParquetRowStream } from "#parquet/streams"
import { writeParquetFile } from "#parquet/writers"
import { applyCountryBudget } from "#tools/postcode/triples"
import type { LabeledRow } from "#types"

/**
 * The corpus columns the extraction reads.
 */
export const POSTCODE_ORDER_COLUMNS = [
	"raw",
	"span_tags",
	"span_starts",
	"span_ends",
	"country",
	"source",
	"source_id",
	"license",
] as const

/**
 * One corpus row as {@linkcode POSTCODE_ORDER_COLUMNS} projects it.
 */
export interface PostcodeOrderCorpusRow {
	raw: string
	span_tags: readonly string[]
	span_starts: readonly number[]
	span_ends: readonly number[]
	country: string
	source: string
	source_id: string
	license: string
}

/**
 * The four components a tuple needs, in the order a row is checked for them.
 */
const REQUIRED_TAGS = ["house_number", "street", "locality", "postcode"] as const

/**
 * One extracted tuple, in the shape the `postcode-order` recipe reads.
 */
export interface PostcodeOrderTuple {
	house_number: string
	street: string
	locality: string
	postcode: string
	/**
	 * ISO 3166-1 alpha-2, from the corpus row's `country`.
	 */
	cc: string
	/**
	 * The corpus source the row was stored under.
	 * The recipe's output label extends it.
	 */
	source: string
	license: string
	/**
	 * Whether the source row wrote the street ahead of the house number, so the recipe keeps that order.
	 */
	streetFirst: boolean
	/**
	 * The corpus row's `source_id`.
	 */
	baseSourceID: string
}

/**
 * The tuple one corpus row yields, or null when the row lacks one of the four components.
 *
 * The first span of each tag is read, by the UTF-16 offsets `alignRow` wrote.
 *
 * @throws When the span triple is not three parallel arrays.
 * A malformed row read as one without the components would hide a corrupt file behind a smaller sample.
 */
export function postcodeOrderTupleOf(row: PostcodeOrderCorpusRow): PostcodeOrderTuple | null {
	const { raw, span_tags: tags, span_starts: starts, span_ends: ends } = row

	if (!Array.isArray(tags) || !Array.isArray(starts) || !Array.isArray(ends)) {
		throw new TypeError(`corpus row ${row.source_id} has no span triple`)
	}

	if (tags.length !== starts.length || tags.length !== ends.length) {
		throw new Error(
			`corpus row ${row.source_id} has a span triple of ${starts.length}/${ends.length}/${tags.length}; ` +
				"the three are parallel arrays and must agree in length"
		)
	}

	const values: Partial<Record<(typeof REQUIRED_TAGS)[number], { text: string; start: number }>> = {}

	for (const tag of REQUIRED_TAGS) {
		const index = tags.indexOf(tag)

		if (index === -1) return null

		const text = raw.slice(starts[index]!, ends[index]!).trim()

		if (!text) return null

		values[tag] = { text, start: starts[index]! }
	}

	return {
		house_number: values.house_number!.text,
		street: values.street!.text,
		locality: values.locality!.text,
		postcode: values.postcode!.text,
		cc: row.country.toUpperCase(),
		source: row.source,
		license: row.license,
		streetFirst: values.street!.start < values.house_number!.start,
		baseSourceID: row.source_id,
	}
}

/**
 * The `WHERE` clause that keeps rows of the chosen countries and sources carrying all four components.
 */
export function postcodeOrderFilterSQL(countries: readonly string[], sources: readonly string[]): string {
	if (!countries.length || !sources.length) {
		throw new Error("postcode-order extraction needs at least one country and one source")
	}

	const list = (values: readonly string[]) => values.map((value) => `'${escapeSQLString(value)}'`).join(", ")

	return [
		`upper(country) IN (${list(countries.map((cc) => cc.toUpperCase()))})`,
		`source IN (${list(sources)})`,
		...REQUIRED_TAGS.map((tag) => `list_contains(span_tags, '${tag}')`),
	].join(" AND ")
}

/**
 * Options for {@linkcode samplePostcodeOrderTuples}.
 */
export interface PostcodeOrderSampleOptions {
	/**
	 * Tuples one (country, source) pair may contribute.
	 */
	cap: number
	/**
	 * Tuples one locality may hold while the stream is read.
	 *
	 * The quota bounds memory on a source of a hundred million rows.
	 *
	 * @defaultValue `8`
	 */
	localityQuota?: number
}

/**
 * Samples tuples capped per (country, source) and stratified by locality.
 *
 * Rows arrive in file order, so each locality keeps its first `localityQuota` tuples.
 * The cap is then spent one tuple per locality per round, as `applyCountryBudget`
 * spends a country's budget across regions.
 */
export async function samplePostcodeOrderTuples(
	tuples: AsyncIterable<PostcodeOrderTuple> | Iterable<PostcodeOrderTuple>,
	options: PostcodeOrderSampleOptions
): Promise<PostcodeOrderTuple[]> {
	const quota = options.localityQuota ?? 8
	const held = new Map<string, number>()
	const pool: Array<{ cc: string; region: string; tuple: PostcodeOrderTuple }> = []

	for await (const tuple of tuples) {
		const stratum = `${tuple.cc} ${tuple.source}`
		const key = `${stratum} ${tuple.locality.toLowerCase()}`
		const n = held.get(key) ?? 0

		if (n >= quota) continue

		held.set(key, n + 1)
		// `applyCountryBudget` caps by its `cc` field and rotates through its `region` field,
		// so the pair and the locality take those places.
		pool.push({ cc: stratum, region: tuple.locality.toLowerCase(), tuple })
	}

	return applyCountryBudget(pool, options.cap).map(({ tuple }) => tuple)
}

/**
 * Streams the tuples of the chosen countries and sources out of corpus parquet files, in file order.
 */
export async function* readPostcodeOrderTuples(
	files: readonly PathBuilderLike[],
	countries: readonly string[],
	sources: readonly string[]
): AsyncGenerator<PostcodeOrderTuple> {
	const where = postcodeOrderFilterSQL(countries, sources)

	for (const file of files) {
		for await (const row of openParquetRowStream<PostcodeOrderCorpusRow>(file, {
			columns: POSTCODE_ORDER_COLUMNS,
			where,
		})) {
			const tuple = postcodeOrderTupleOf(row)

			if (tuple) {
				yield tuple
			}
		}
	}
}

/**
 * What {@linkcode writePostcodeOrderParquet} reads and writes.
 */
export interface PostcodeOrderParquetOptions {
	/**
	 * The `postcode-order` recipe's labeled-row JSONL, one source.
	 */
	rows: PathBuilderLike
	/**
	 * The tuples file the recipe read: the base source's extract.
	 */
	tuples: PathBuilderLike
	/**
	 * The parquet file to write.
	 * Its record is written beside it.
	 */
	output: PathBuilderLike
	/**
	 * The seed the recipe ran with, since it decides the separator variants.
	 */
	seed: number
}

/**
 * Writes the recipe's rows as one parquet file with its record.
 *
 * The extract hash is the base source's tuples file, and `inputSources` names that base source.
 * The code hash covers the recipe module, this writer and what they import at runtime, across workspaces.
 *
 * That includes `@mailwoman/postcode`'s placement table, which the recipe reaches through `country-formats`.
 *
 * @throws When the tuples file holds more than one base source, since one file's extract is one source's.
 */
export async function writePostcodeOrderParquet(options: PostcodeOrderParquetOptions): Promise<ParquetFileRecord> {
	const rows: ParquetRow[] = []

	for await (const line of TextSpliterator.fromAsync(options.rows)) {
		if (line) {
			rows.push(rowToParquet(parseJSONStrict<LabeledRow>(line)))
		}
	}

	const baseSources = new Set<string>()

	for await (const line of TextSpliterator.fromAsync(options.tuples)) {
		if (line) {
			baseSources.add(parseJSONStrict<PostcodeOrderTuple>(line).source)
		}
	}

	if (baseSources.size !== 1) {
		throw new Error(
			`writePostcodeOrderParquet: ${options.tuples.toString()} holds ${baseSources.size} base sources ` +
				`(${[...baseSources].join(", ")}). Write one tuples file per base source.`
		)
	}

	return writeParquetFile(rows, options.output, {
		extractHash: await sha256File(options.tuples),
		codeHash: await moduleGraphHash([
			resolveModulePath("@mailwoman/corpus/recipes/postcode-order"),
			import.meta.filename,
		]),
		config: {
			recipe: "postcode-order",
			seed: options.seed,
			inputSources: [...baseSources],
		},
	})
}

/**
 * Writes one tuples file per base source, so each recipe run, and so each overlay file, holds one source.
 *
 * @returns The written path and tuple count for each source.
 */
export async function writePostcodeOrderTuples(
	tuples: readonly PostcodeOrderTuple[],
	outputDirectory: PathBuilderLike
): Promise<Array<{ source: string; path: string; tuples: number }>> {
	const bySource = Map.groupBy(tuples, (tuple) => tuple.source)
	const written: Array<{ source: string; path: string; tuples: number }> = []

	for (const [source, rows] of [...bySource].toSorted(([a], [b]) => a.localeCompare(b))) {
		const path = PathBuilder.from(outputDirectory)(`postcode-order-${source}.tuples.jsonl`)

		await writeLocalJSONLFile(rows, path)
		written.push({ source, path: path.toString(), tuples: rows.length })
	}

	return written
}
