/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The held-out non-native postcode-order evaluation suite.
 *
 *   A French address arrives as `«postcode» «locality»` in every source, so `Via del Corso 12, Roma 00186` or
 *   `Av. Paulista 1000, 01310-100 São Paulo` is a sequence that measures whether a model reads a postcode by its
 *   form rather than by its slot. This module reads `(house number, street, locality, postcode)` tuples from a
 *   corpus's held-out `test` split, never from `train`, and renders each with its postcode in the slot opposite
 *   the one libaddressinput's `fmt` states for its country. The rows are golden `{raw, components, country}`
 *   lines, the shape `fr-order --golden` writes, so they never reach a training corpus.
 *
 *   Training rows with the postcode on the non-native side come from the `postcode_move` augmentation in
 *   the trainer (#2750), which moves the postcode at training time. A corpus-time renderer of the same
 *   order would mix it a second time at an unmeasured share.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { postcodePlacement } from "@mailwoman/postcode/country-formats"
import type { PathBuilderLike } from "path-ts"

import { escapeSQLString } from "#parquet/duckdb"
import { openParquetRowStream } from "#parquet/streams"
import { applyCountryBudget } from "#tools/postcode/triples"

/**
 * The only corpus split the suite reads.
 *
 * A model fits `train`.
 * Its training run selects checkpoints on `val`.
 * Neither is held out.
 */
export const NON_NATIVE_ORDER_SPLIT = "test"

/**
 * Refuses any split other than {@linkcode NON_NATIVE_ORDER_SPLIT}.
 */
export function assertHeldOutSplit(split: string): void {
	if (split !== NON_NATIVE_ORDER_SPLIT) {
		throw new Error(
			`the non-native postcode-order suite reads only the ${NON_NATIVE_ORDER_SPLIT} split, not ${stringifyJSON(split)}. ` +
				"An evaluation row drawn from the rows a model trained or selected on measures recall, not generalization."
		)
	}
}

/**
 * The corpus columns the extraction reads.
 */
export const NON_NATIVE_ORDER_COLUMNS = [
	"raw",
	"span_tags",
	"span_starts",
	"span_ends",
	"country",
	"source",
	"source_id",
] as const

/**
 * One corpus row as {@linkcode NON_NATIVE_ORDER_COLUMNS} projects it.
 */
export interface NonNativeOrderCorpusRow {
	raw: string
	span_tags: readonly string[]
	span_starts: readonly number[]
	span_ends: readonly number[]
	country: string
	source: string
	source_id: string
}

/**
 * The four components a tuple needs, in the order a row is checked for them.
 */
const REQUIRED_TAGS = ["house_number", "street", "locality", "postcode"] as const

/**
 * One extracted tuple.
 */
export interface NonNativeOrderTuple {
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
	 */
	source: string
	/**
	 * Whether the source row wrote the street ahead of the house number, so the rendering keeps that order.
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
export function nonNativeOrderTupleOf(row: NonNativeOrderCorpusRow): NonNativeOrderTuple | null {
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
		streetFirst: values.street!.start < values.house_number!.start,
		baseSourceID: row.source_id,
	}
}

/**
 * The `WHERE` clause that keeps rows of the chosen countries and sources carrying all four components.
 */
export function nonNativeOrderFilterSQL(countries: readonly string[], sources: readonly string[]): string {
	if (!countries.length || !sources.length) {
		throw new Error("non-native postcode-order extraction needs at least one country and one source")
	}

	const list = (values: readonly string[]) => values.map((value) => `'${escapeSQLString(value)}'`).join(", ")

	return [
		`upper(country) IN (${list(countries.map((cc) => cc.toUpperCase()))})`,
		`source IN (${list(sources)})`,
		...REQUIRED_TAGS.map((tag) => `list_contains(span_tags, '${tag}')`),
	].join(" AND ")
}

/**
 * Options for {@linkcode sampleNonNativeOrderTuples}.
 */
export interface NonNativeOrderSampleOptions {
	/**
	 * Tuples one (country, source) pair may contribute.
	 */
	cap: number
	/**
	 * Tuples one locality may hold while the stream is read.
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
export async function sampleNonNativeOrderTuples(
	tuples: AsyncIterable<NonNativeOrderTuple> | Iterable<NonNativeOrderTuple>,
	options: NonNativeOrderSampleOptions
): Promise<NonNativeOrderTuple[]> {
	const quota = options.localityQuota ?? 8
	const held = new Map<string, number>()
	const pool: Array<{ cc: string; region: string; tuple: NonNativeOrderTuple }> = []

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
 * Streams the tuples of the chosen countries and sources out of a corpus split's parquet files.
 * The tuples arrive in file order.
 *
 * @throws Unless `split` is the held-out {@linkcode NON_NATIVE_ORDER_SPLIT}.
 */
export async function* readNonNativeOrderTuples(
	split: string,
	files: readonly PathBuilderLike[],
	countries: readonly string[],
	sources: readonly string[]
): AsyncGenerator<NonNativeOrderTuple> {
	assertHeldOutSplit(split)

	const where = nonNativeOrderFilterSQL(countries, sources)

	for (const file of files) {
		for await (const row of openParquetRowStream<NonNativeOrderCorpusRow>(file, {
			columns: NON_NATIVE_ORDER_COLUMNS,
			where,
		})) {
			const tuple = nonNativeOrderTupleOf(row)

			if (tuple) {
				yield tuple
			}
		}
	}
}

// A draw below `COMMA_JOIN` joins the address and the admin tail with a comma, below `NEWLINE_JOIN`
// with a line break, and otherwise with a space, the comma-free form a user types into one search box.
const COMMA_JOIN = 0.8
const NEWLINE_JOIN = 0.92

// The share of tails that put a comma between the locality and the postcode (`Roma, 00186`).
const TAIL_COMMA_SHARE = 0.3

// The share of street-first addresses written with a comma before the house number (`Av. Paulista, 1000`).
const HOUSE_NUMBER_COMMA_SHARE = 0.3

/**
 * Renders one tuple with the postcode opposite its country's native slot,
 * or returns null when the country's layout states no order.
 */
export function renderPostcodeOrder(tuple: NonNativeOrderTuple, random: () => number): string | null {
	const native = postcodePlacement(tuple.cc)

	if (!native) return null

	const { house_number: hn, street, locality, postcode } = tuple

	const address = tuple.streetFirst
		? `${street}${random() < HOUSE_NUMBER_COMMA_SHARE ? ", " : " "}${hn}`
		: `${hn} ${street}`

	const tailSeparator = random() < TAIL_COMMA_SHARE ? ", " : " "

	const tail =
		native === "before_locality" ? `${locality}${tailSeparator}${postcode}` : `${postcode}${tailSeparator}${locality}`

	const join = random()
	const joiner = join < COMMA_JOIN ? ", " : join < NEWLINE_JOIN ? "\n" : " "

	return `${address}${joiner}${tail}`
}

/**
 * One golden evaluation row, in the shape `fr-order --golden` writes.
 */
export interface NonNativeOrderGoldenRow {
	raw: string
	components: { house_number: string; street: string; locality: string; postcode: string }
	country: string
	/**
	 * The corpus source and `source_id` the tuple came from, so a failure traces to its test-split row.
	 */
	source: string
	baseSourceID: string
}

/**
 * The golden rows for `tuples`, skipping a country whose layout states no order.
 *
 * @returns The rows and the count skipped, so a shortfall is reported rather than hidden.
 */
export function nonNativeOrderGoldenRows(
	tuples: readonly NonNativeOrderTuple[],
	seed: number
): { rows: NonNativeOrderGoldenRow[]; skipped: number } {
	const random = makeMulberry32(seed)
	const rows: NonNativeOrderGoldenRow[] = []
	let skipped = 0

	for (const tuple of tuples) {
		const raw = renderPostcodeOrder(tuple, random)

		if (!raw) {
			skipped++

			continue
		}

		rows.push({
			raw,
			components: {
				house_number: tuple.house_number,
				street: tuple.street,
				locality: tuple.locality,
				postcode: tuple.postcode,
			},
			country: tuple.cc,
			source: tuple.source,
			baseSourceID: tuple.baseSourceID,
		})
	}

	return { rows, skipped }
}
