/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ingest — turn messy tabular data (CSV, SQLite, hand-keyed spreadsheets) into normalized
 *   {@link SourceRecord}s, the front of the cascade.
 *
 *   Two concerns, kept separate:
 *
 *   1. **Column mapping + normalization** (this is pure): a {@link ColumnMapping} says which column(s)
 *        hold the name, organization, address, phone, email; each row is normalized with
 *        `@mailwoman/record` (parse the person name, canonicalize the org). This is deterministic
 *        and testable with no heavy runtime.
 *   2. **Geocoding** (the heavy part) is an injected seam — a {@link GeocodeAddress} the caller provides.
 *        Ingest never imports the neural parser, the resolver, or the shards; it just calls the
 *        seam per address. {@link geocodeAddressVia} builds that seam from mailwoman's real parse +
 *        geocode primitives (which the CLI constructs with the model + data in hand), so the wiring
 *        is concrete and testable without pinning the heavy runtime into this package.
 *
 *   LLM-assisted column mapping (infer the mapping from a header + samples) is a documented
 *   fast-follow; the mapping is an explicit input here.
 */

import type { AddressGeocode, PostalAddress } from "@mailwoman/record"
import { canonicalizeOrganizationName, parsePersonName, toPostalAddress, withGeocode } from "@mailwoman/record"
import { parse as parseCsvSync } from "csv-parse/sync"
import { Delimiters, TextSpliterator } from "spliterator"
import type { SourceRecord } from "./types.js"

/** Resolve a raw address string into a {@link PostalAddress}. The seam to mailwoman's geocoder. */
export type GeocodeAddress = (raw: string) => Promise<PostalAddress | null> | PostalAddress | null

/** Column delimiter of a delimited source. */
export type Delimiter = "comma" | "tab"

/** Infer the delimiter from a path's extension (`.tsv` → tab, else comma). */
export function delimiterFor(path: string): Delimiter {
	return /\.tsv$/i.test(path) ? "tab" : "comma"
}

/**
 * Stream a delimited file's rows lazily as header-keyed objects — the same shape {@link parseCsv}
 * returns, but **without loading the file into memory**. A multi-GB source (the NPPES registry is
 * ~4.8 GB / 9.6M rows — too big for `readFileSync`, which throws `ERR_STRING_TOO_LONG`) streams
 * line by line. Keys are the original header names so a {@link ColumnMapping} written against the
 * source's headers matches. Filter/sample the stream before {@link ingestRows} to keep only the rows
 * you geocode.
 *
 * We stream _lines_ with spliterator's `TextSpliterator` (pure-Node, the part that handles the huge
 * file) and split each line into columns here with `String.prototype.split`. We deliberately do NOT
 * use `CSVSpliterator`: its column tokenizer hard-codes `skipEmpty` (it builds the column
 * spliterator as `{ delimiter }` with no `skipEmpty: false`), so consecutive delimiters collapse
 * and EMPTY FIELDS ARE DROPPED — fatal for a fixed-width registry like NPPES where a row of 330
 * columns full of empties would mis-parse to 40 and shift every value. (Upstream `spliterator` bug;
 * revisit when it's fixed.)
 *
 * Assumes an unquoted delimited file (no fields containing the delimiter) — true for these
 * government TSVs. For small, possibly-quoted CSVs use {@link parseCsv} (quote-aware, in-memory).
 */
export async function* streamRows(
	source: string,
	opts: { delimiter?: Delimiter } = {}
): AsyncGenerator<Record<string, string>> {
	const sep = (opts.delimiter ?? delimiterFor(source)) === "tab" ? "\t" : ","
	let header: string[] | null = null
	for await (const line of TextSpliterator.fromAsync(source, { delimiter: Delimiters.LineFeed })) {
		if (line.length === 0) continue // blank line / trailing newline
		const fields = line.replace(/\r$/, "").split(sep) // tolerate CRLF
		if (header === null) {
			header = fields
			continue
		}
		const row: Record<string, string> = {}
		for (let i = 0; i < header.length; i++) row[header[i]!] = fields[i] ?? ""
		yield row
	}
}

/**
 * Maps dataset columns to record fields. A field may draw from several columns (joined with
 * spaces).
 */
export interface ColumnMapping {
	/** Column holding a stable row id. Falls back to the row index. */
	id?: string
	/** A literal provenance label for every row (not a column). */
	source?: string
	name?: string | string[]
	organization?: string | string[]
	address?: string | string[]
	phone?: string
	email?: string
}

/** Options for {@link ingestRows}. */
export interface IngestOptions {
	/** The geocoding seam. Without it, records carry name/org but no resolved address. */
	geocodeAddress?: GeocodeAddress
}

/** Parse a CSV string (with a header row) into row objects keyed by column name. */
export function parseCsv(text: string): Record<string, string>[] {
	return parseCsvSync(text, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true })
}

/** Join the named column(s) of a row into a single trimmed string, or undefined if empty. */
function pick(row: Record<string, string>, columns?: string | string[]): string | undefined {
	if (!columns) return undefined
	const list = Array.isArray(columns) ? columns : [columns]
	const value = list
		.map((c) => row[c]?.trim())
		.filter(Boolean)
		.join(" ")
		.trim()
	return value || undefined
}

/**
 * Normalize tabular rows into {@link SourceRecord}s under a {@link ColumnMapping}. Accepts a sync OR
 * async iterable, so {@link parseCsv} (in-memory) and {@link streamRows} (lazy, for huge files) both
 * thread straight through.
 */
export async function ingestRows(
	rows: Iterable<Record<string, string>> | AsyncIterable<Record<string, string>>,
	mapping: ColumnMapping,
	opts: IngestOptions = {}
): Promise<SourceRecord[]> {
	const records: SourceRecord[] = []
	let index = 0

	for await (const row of rows) {
		const id = (mapping.id ? row[mapping.id]?.trim() : "") || String(index)
		const nameValue = pick(row, mapping.name)
		const orgValue = pick(row, mapping.organization)
		const addressValue = pick(row, mapping.address)

		const record: SourceRecord = {
			id,
			source: mapping.source,
			name: nameValue ? parsePersonName(nameValue) : undefined,
			organization: orgValue ? canonicalizeOrganizationName(orgValue) : undefined,
			phone: (mapping.phone && row[mapping.phone]?.trim()) || undefined,
			email: (mapping.email && row[mapping.email]?.trim()?.toLowerCase()) || undefined,
			address:
				addressValue && opts.geocodeAddress ? ((await opts.geocodeAddress(addressValue)) ?? undefined) : undefined,
			raw: row,
		}

		records.push(record)
		index++
	}

	return records
}

/**
 * The subset of mailwoman's `GeocodeResult` the adapter consumes — kept structural so this package
 * never imports the heavy geocoder, yet a real `GeocodeResult` maps straight in.
 */
export interface RawGeocode {
	lat: number | null
	lon: number | null
	resolution_tier: AddressGeocode["tier"]
	uncertainty_m: number | null
	hierarchy?: AddressGeocode["hierarchy"]
}

/**
 * Build a {@link GeocodeAddress} from mailwoman's real parse + geocode primitives (injected — the
 * CLI constructs the neural parser, resolver, and shards and passes them in). Parse → components →
 * {@link toPostalAddress} (which fills the canonical key + formatted form) → attach the resolved
 * coordinate. When geocoding can't place the address, the parsed-but-unlocated address is still
 * returned.
 */
export function geocodeAddressVia(deps: {
	parse: (raw: string) => Promise<Parameters<typeof toPostalAddress>[0]> | Parameters<typeof toPostalAddress>[0]
	geocode: (raw: string) => Promise<RawGeocode | null> | RawGeocode | null
	country?: string
}): GeocodeAddress {
	return async (raw: string): Promise<PostalAddress | null> => {
		const components = await deps.parse(raw)
		const base = toPostalAddress(components, { country: deps.country, raw })

		const resolved = await deps.geocode(raw)
		if (!resolved || resolved.lat === null || resolved.lon === null) return base

		const geocode: AddressGeocode = {
			coordinate: { latitude: resolved.lat, longitude: resolved.lon },
			tier: resolved.resolution_tier,
			uncertaintyMeters: resolved.uncertainty_m,
			hierarchy: resolved.hierarchy,
		}
		return withGeocode(base, geocode)
	}
}
