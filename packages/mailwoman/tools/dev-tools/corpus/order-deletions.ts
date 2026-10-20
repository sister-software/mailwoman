/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Find corpus rows whose postcode sits on the side of the locality-and-region block that the row's
 *   country does not print it on, as libaddressinput's `fmt` states the placement.
 *
 *   `order-deletions.run.ts` reads a parquet file through this module and writes the matching `source_id`s
 *   as a deletion sidecar (#2750).
 */

import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { openParquetRowStream } from "@mailwoman/corpus/parquet/streams"
import { postcodePlacement } from "@mailwoman/postcode/country-formats"
import type { PathBuilderLike } from "path-ts"

/**
 * The span tags that form the admin block a postcode sits beside.
 */
const ADMIN_BLOCK_TAGS: ReadonlySet<string> = new Set(["locality", "region"])

/**
 * Which side of the admin block a row's postcode starts on.
 */
export type PostcodeSide = "before_locality" | "after_locality"

/**
 * The side of the locality-and-region block the row's single postcode span sits on.
 *
 * Null when the row lacks a locality, holds other than one postcode, or has admin spans on both sides of it.
 */
export function postcodeSide(tags: readonly string[], starts: readonly number[]): PostcodeSide | null {
	if (tags.length !== starts.length)
		throw new Error(`span_tags has ${tags.length} entries and span_starts ${starts.length}`)

	const postcodes = tags.flatMap((tag, index) => (tag === "postcode" ? [index] : []))

	if (postcodes.length !== 1 || !tags.includes("locality")) return null

	const postcodeStart = starts[postcodes[0]!]!
	let before = 0
	let after = 0

	for (const [index, tag] of tags.entries()) {
		if (!ADMIN_BLOCK_TAGS.has(tag)) continue

		if (starts[index]! < postcodeStart) {
			before++
		} else {
			after++
		}
	}

	if (before && after) return null

	return before ? "after_locality" : "before_locality"
}

/**
 * The span columns {@linkcode findReversedRows} reads.
 */
export interface OrderRow {
	source_id: string
	country: string | null
	span_tags: readonly string[] | null
	span_starts: readonly number[] | null
}

/**
 * Whether the row's postcode sits on its country's placement side (`native`) or the other (`reversed`).
 *
 * Null when the country states no placement or the row's side is undetermined.
 */
export function rowPostcodeOrder(row: OrderRow): "native" | "reversed" | null {
	if (!row.country || !row.span_tags || !row.span_starts) return null

	const native = postcodePlacement(row.country)

	if (!native) return null

	const side = postcodeSide(row.span_tags, row.span_starts)

	if (side == null) return null

	return side === native ? "native" : "reversed"
}

/**
 * Per-country counts of one scan.
 */
export interface CountryOrderCount {
	rows: number
	native: number
	reversed: number
	/**
	 * Native-order rows that share a `source_id` with a reversed row.
	 * A deletion by `source_id` also drops these.
	 */
	nativeSharingID: number
}

/**
 * The reversed rows' ids and the per-country counts behind them.
 */
export interface ReversedRows {
	ids: string[]
	countries: Map<string, CountryOrderCount>
}

/**
 * Scan a parquet file, restricted to `countries` when given, for rows {@linkcode isReversedOrder} matches.
 */
export async function findReversedRows(path: PathBuilderLike, countries?: readonly string[]): Promise<ReversedRows> {
	const wanted = countries?.length ? new Set(countries.map((code) => code.toUpperCase())) : null
	const ids: string[] = []
	const nativeRows: [id: string, country: string][] = []
	const counts = new Map<string, CountryOrderCount>()

	const stream = openParquetRowStream<OrderRow>(path, {
		columns: ["source_id", "country", "span_tags", "span_starts"],
	})

	for await (const row of stream) {
		const country = (row.country ?? "").toUpperCase()

		if (wanted && !wanted.has(country)) continue

		const count = counts.get(country) ?? { rows: 0, native: 0, reversed: 0, nativeSharingID: 0 }

		counts.set(country, count)

		count.rows++

		if (typeof row.source_id !== "string" || !row.source_id) {
			throw new Error(`${path.toString()} holds a ${country} row with no source_id`)
		}

		const order = rowPostcodeOrder(row)

		if (order === "native") {
			count.native++
			nativeRows.push([row.source_id, country])
		} else if (order === "reversed") {
			count.reversed++
			ids.push(row.source_id)
		}
	}

	const reversedIDs = new Set(ids)

	for (const [id, country] of nativeRows) {
		if (reversedIDs.has(id)) {
			counts.get(country)!.nativeSharingID++
		}
	}

	return { ids: [...reversedIDs], countries: counts }
}

/**
 * Write `ids` as a one-column (`source_id`) parquet sidecar, sorted,
 * as the overlay's deletion loader reads it.
 */
export async function writeSourceIDSidecar(ids: readonly string[], path: PathBuilderLike): Promise<void> {
	if (!ids.length) throw new Error(`no source_id to write to ${path.toString()}`)

	using db = await openDuckDB()
	const list = ids.map((id) => `'${escapeSQLString(id)}'`).join(",")

	await db.run(
		`COPY (SELECT DISTINCT unnest([${list}]) AS source_id ORDER BY source_id) ` +
			`TO '${escapeSQLString(path.toString())}' (FORMAT parquet, COMPRESSION snappy)`
	)
}
