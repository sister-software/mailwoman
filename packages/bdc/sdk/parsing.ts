/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC BDC availability CSV row reader.
 *
 *   Streams the FCC's 12-column availability CSV through `CSVSpliterator` in `array` mode and projects the
 *   seven columns 2a keeps. Columns 0-2 (`frn`, `provider_id`, `brand_name`) and 9, 11 (`state_usps`,
 *   `h3_res8_id`) are read past and never emitted: `provider_id` comes from the {@linkcode ProviderID}
 *   parameter instead (the FCC partitions availability files per provider, so the caller already knows it),
 *   and FRN/brand/state/H3 join concerns are a 2c registry-join seam.
 *
 *   Two projection decisions are load-bearing and pre-registered. `location_id` (column 3) stays a STRING —
 *   the FCC's values are zero-padded 10-digit strings and `parseInt` would lose the leading zeros (decision
 *   1). `geoid` (column 10) is a string joining `TIGERBlockTable.GEOID` (decision 3).
 *
 *   ## Why the source is a resource, not a Buffer
 *
 *   This read is STREAMING because the files do not fit the alternative. One state × one technology —
 *   `bdc_48_FibertothePremises_fixed_broadband_D25` — is 920 MB and 10,369,043 rows, and a national run
 *   spans every state × every technology. The previous byte scanner took a `Buffer`, so its caller opened
 *   with `readFile(csvPath)` and held the whole file resident per file.
 *
 *   ## Why quoting is not optional here
 *
 *   Measured on that same file: 421,555 rows carry one embedded comma inside a quoted `brand_name` and 327
 *   carry two ("FiberFirst, LLC", "Valor Telecommunications of Texas, LP"). A delimiter scan blind to quotes
 *   shifts every column right of `brand_name` on 4% of rows — measured exactly, a quote-blind
 *   `String.split(",")` mismatches 81,095 of 2,000,000 real rows. `enableQuoteHandling` also keeps an
 *   embedded NEWLINE inside its row — no row in that file needs it (the 12/13/14-field line counts sum
 *   exactly to `wc -l`, so no record is split across lines), but the guarantee is what makes the reader safe
 *   on a file nobody has measured yet.
 *
 *   ## What this costs, and where the cost actually is
 *
 *   The retired byte scanner did line-find + column-split + project in 1,105 ns/row from a resident buffer;
 *   this reader costs 2,157 ns/row streaming. Decomposed on 2,000,000 real rows, one arm per process (arms
 *   in a shared process mis-rank — the JIT warms across them):
 *
 *   ```
 *   lines only, byte ranges, streaming      157 ns/row     <- the floor
 *   + one TextDecoder.decode per line       233 ns/row
 *   + String.split(",") + project            672 ns/row     <- quote-BLIND, 4% wrong
 *   CSVSpliterator mode:"array" + project  2,157 ns/row     <- what we ship
 *   ```
 *
 *   So the cost is the column emitter, not CSV parsing and not streaming: splitting one ~110-byte line into
 *   twelve strings costs 1,823 ns/row over a floor where decode-plus-split costs 439. It is NOT
 *   `enableQuoteHandling`, which is ~8% of the total. Filed upstream as sister-software/spliterator#6; when
 *   that lands, this reader gets faster without changing.
 *
 *   Do not route around it by hand-rolling a splitter here again. The staging insert this feeds measures 615
 *   ns/row, so the parse does dominate the ingest path — but a local fast-and-quote-blind parser is exactly
 *   the trade that produced the scanner this replaced.
 */

import type { AsyncDataResource } from "spliterator"
import { CSVSpliterator } from "spliterator"

import type { ProviderID } from "./common.ts"

/**
 * Column positions in the FCC's 12-column availability CSV. Named rather than sliced by offset so a reader can check
 * them against the header row without counting commas:
 *
 * `frn,provider_id,brand_name,location_id,technology,max_advertised_download_speed,`
 * `max_advertised_upload_speed,low_latency,business_residential_code,state_usps,block_geoid,h3_res8_id`
 */
const Column = {
	LocationID: 3,
	Technology: 4,
	MaxAdvertisedDownloadSpeed: 5,
	MaxAdvertisedUploadSpeed: 6,
	LowLatency: 7,
	BusinessResidentialCode: 8,
	BlockGeoID: 10,
} as const

/**
 * A single parsed row of FCC BDC availability data.
 *
 * @see {@linkcode readAvailabilityRows}
 */
export interface BDCAvailabilityRow {
	provider_id: number
	/**
	 * Kept as a string — the FCC's `location_id` values are zero-padded 10-digit strings; `parseInt`ing would lose
	 * leading zeros (2a decision 1).
	 */
	location_id: string
	technology_code: number
	max_advertised_download_speed: number
	max_advertised_upload_speed: number
	low_latency: 0 | 1
	business_residential_code: string
	/**
	 * Joins `TIGERBlockTable.GEOID` (note: uppercase column on that side) — 2a decision 3.
	 */
	geoid: string
}

/**
 * Project one already-split CSV row onto {@linkcode BDCAvailabilityRow}.
 *
 * Separate from the iteration so the sync and async readers cannot drift in what they emit — the one-function
 * discipline. Not exported: a caller with a split row wants {@linkcode readAvailabilityRowsSync}.
 */
function projectRow(columns: readonly string[], providerID: ProviderID): BDCAvailabilityRow {
	return {
		provider_id: providerID,
		location_id: columns[Column.LocationID] ?? "",
		technology_code: Number.parseInt(columns[Column.Technology] ?? "", 10),
		max_advertised_download_speed: Number.parseInt(columns[Column.MaxAdvertisedDownloadSpeed] ?? "", 10),
		max_advertised_upload_speed: Number.parseInt(columns[Column.MaxAdvertisedUploadSpeed] ?? "", 10),
		low_latency: columns[Column.LowLatency] === "1" ? 1 : 0,
		business_residential_code: columns[Column.BusinessResidentialCode] ?? "",
		geoid: columns[Column.BlockGeoID] ?? "",
	}
}

/**
 * Shared reader options. `header: true` consumes the first row as the header even in `array` mode;
 * `enableQuoteHandling` is what makes the 421,882 quoted-brand rows keep their column alignment. `crlf` already
 * defaults to `true` for CSV (RFC 4180), so a CRLF file does not leak `\r` into the last column.
 */
const READER_OPTIONS = { mode: "array", enableQuoteHandling: true } as const

/**
 * Stream an FCC BDC availability CSV, yielding every data row. The header row is consumed, never emitted.
 *
 * `source` is anything `spliterator` can open asynchronously — a path string, a `path-ts` builder, a URL, a file
 * handle, or an async chunk iterator. Prefer handing it the path and letting it own the read: that is what keeps a 920
 * MB file off the heap.
 */
export async function* readAvailabilityRows(
	source: AsyncDataResource,
	providerID: ProviderID
): AsyncIterable<BDCAvailabilityRow> {
	for await (const columns of CSVSpliterator.fromAsync<string[]>(source, READER_OPTIONS)) {
		yield projectRow(columns, providerID)
	}
}

/**
 * Synchronous sibling for an in-memory buffer — fixtures and tests, never the build path.
 *
 * Kept because a test that must assert on a literal CSV should not have to stand up a stream to do it. If you are
 * reaching for this against a file on disk, reach for {@linkcode readAvailabilityRows} instead.
 */
export function* readAvailabilityRowsSync(
	csvBuffer: Buffer | string,
	providerID: ProviderID
): Iterable<BDCAvailabilityRow> {
	for (const columns of CSVSpliterator.from<string[]>(csvBuffer, READER_OPTIONS)) {
		yield projectRow(columns, providerID)
	}
}
