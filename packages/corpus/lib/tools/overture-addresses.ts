/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Flatten a per-country Overture addresses parquet into the line-delimited JSON the `overture`
 *   corpus adapter reads.
 *
 *   The adapter's header names `scripts/ingest-overture-addresses.ts --corpus-jsonl` as the producer
 *   of that jsonl. There is no root `scripts/` directory any more, and the parquet files the ingest
 *   downloaded are on disk, so this reads them where they sit.
 *
 *   The one transformation is the locality. Overture writes a country's administrative hierarchy into
 *   `address_levels`, coarsest first: for Italy, regione, provincia, comune. `postal_city` is a
 *   separate column that some countries populate and others leave empty on every row — it is empty on
 *   all 25,914,431 rows of `addresses-it.parquet`. Reading `postal_city` alone therefore reports a
 *   country with a complete administrative hierarchy as having no localities at all, so this reads
 *   `postal_city` when it carries a value and the last `address_levels` entry otherwise, and says in
 *   its summary which one each row used.
 */

import { openWriteStream } from "@mailwoman/core/fs/streams"
import { stringifyJSON } from "@mailwoman/core/json"
import { once } from "@mailwoman/core/utils/events"
import type { PathBuilderLike } from "path-ts"

import { openParquetRowStream } from "#parquet/streams"

/**
 * The columns this tool projects out of an Overture addresses parquet.
 *
 * `sources` carries the per-record upstream dataset and license, which is what a
 * country's attribution requirement is read from rather than inferred.
 */
export const OVERTURE_ADDRESS_COLUMNS = [
	"street",
	"number",
	"unit",
	"postcode",
	"postal_city",
	"address_levels",
	"sources",
] as const

/**
 * One row as DuckDB returns it from an Overture addresses parquet.
 */
export interface OvertureAddressRow {
	street?: string | null
	number?: string | null
	unit?: string | null
	postcode?: string | null
	postal_city?: string | null
	address_levels?: readonly { value?: string | null }[] | null
	sources?: readonly { dataset?: string | null; license?: string | null }[] | null
}

/**
 * The flattened shape the `overture` adapter reads, one per jsonl line.
 */
export interface OvertureCorpusLine {
	street?: string
	number?: string
	unit?: string
	postcode?: string
	locality?: string
}

/**
 * What a flatten pass observed, so a caller can tell an empty column from an empty country.
 */
export interface OvertureFlattenSummary {
	rows: number
	written: number
	localityFromPostalCity: number
	localityFromAddressLevels: number
	rowsWithNoLocality: number
	rowsWithNoStreet: number
	rowsWithNoPostcode: number
	datasets: Record<string, number>
	licenses: Record<string, number>
}

/**
 * The locality for one row, and which column supplied it.
 *
 * Returns `undefined` rather than an empty string when neither column carries one,
 * so a caller counting localities counts rows that have one instead of rows that have a key.
 */
export function localityOf(
	row: OvertureAddressRow
): { value: string; from: "postal_city" | "address_levels" } | undefined {
	const city = (row.postal_city ?? "").trim()

	if (city) return { value: city, from: "postal_city" }

	const levels = (row.address_levels ?? []).map((entry) => (entry?.value ?? "").trim()).filter(Boolean)
	const last = levels.at(-1)

	if (last) return { value: last, from: "address_levels" }

	return undefined
}

/**
 * Read one country's Overture addresses parquet and write the adapter's jsonl beside it.
 *
 * A row with no street is written anyway: the adapter decides what a usable row is, and dropping rows
 * here would make the jsonl's count disagree with the parquet's for reasons this tool did not record.
 * The summary counts them.
 */
export async function flattenOvertureAddresses(
	parquetPath: PathBuilderLike,
	outputPath: PathBuilderLike,
	options: { limit?: number } = {}
): Promise<OvertureFlattenSummary> {
	const summary: OvertureFlattenSummary = {
		rows: 0,
		written: 0,
		localityFromPostalCity: 0,
		localityFromAddressLevels: 0,
		rowsWithNoLocality: 0,
		rowsWithNoStreet: 0,
		rowsWithNoPostcode: 0,
		datasets: {},
		licenses: {},
	}

	// Brazil's parquet is 89,899,299 rows.
	// Collecting the lines before writing them would hold the whole country in memory, so each
	// line goes to the sink as it is built and a full write buffer is awaited rather than queued.
	const sink = openWriteStream(outputPath)

	for await (const row of openParquetRowStream<OvertureAddressRow>(parquetPath, {
		columns: OVERTURE_ADDRESS_COLUMNS,
		limit: options.limit,
	})) {
		summary.rows++

		const street = (row.street ?? "").trim()
		const number = (row.number ?? "").trim()
		const unit = (row.unit ?? "").trim()
		const postcode = (row.postcode ?? "").trim()
		const locality = localityOf(row)

		if (!street) {
			summary.rowsWithNoStreet++
		}
		if (!postcode) {
			summary.rowsWithNoPostcode++
		}

		if (locality) {
			if (locality.from === "postal_city") {
				summary.localityFromPostalCity++
			} else {
				summary.localityFromAddressLevels++
			}
		} else {
			summary.rowsWithNoLocality++
		}

		for (const entry of row.sources ?? []) {
			const dataset = (entry?.dataset ?? "").trim() || "unstated"
			const license = (entry?.license ?? "").trim() || "unstated"
			summary.datasets[dataset] = (summary.datasets[dataset] ?? 0) + 1
			summary.licenses[license] = (summary.licenses[license] ?? 0) + 1
		}

		const line: OvertureCorpusLine = {}

		if (street) {
			line.street = street
		}
		if (number) {
			line.number = number
		}
		if (unit) {
			line.unit = unit
		}
		if (postcode) {
			line.postcode = postcode
		}
		if (locality) {
			line.locality = locality.value
		}

		if (!sink.write(`${stringifyJSON(line)}\n`)) {
			await once(sink, "drain")
		}
		summary.written++
	}

	sink.end()
	await once(sink, "finish")

	return summary
}
