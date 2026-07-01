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

import { open } from "node:fs/promises"

import type { AddressGeocode, PostalAddress } from "@mailwoman/record"
import { canonicalizeOrganizationName, parsePersonName, toPostalAddress, withGeocode } from "@mailwoman/record"
import { parse as parseCSVSync } from "csv-parse/sync"
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
 * Stream a delimited file's rows lazily as header-keyed objects — the same shape {@link parseCSV} returns, but
 * **without loading the file into memory**. A multi-GB source (the NPPES registry is ~4.8 GB / 9.6M rows — too big for
 * `readFileSync`, which throws `ERR_STRING_TOO_LONG`) streams line by line. Keys are the original header names so a
 * {@link ColumnMapping} written against the source's headers matches. Filter/sample the stream before
 * {@link ingestRows} to keep only the rows you geocode.
 *
 * We stream _lines_ with spliterator's `TextSpliterator` (pure-Node, the part that handles the huge file) and split
 * each line into columns here with `String.prototype.split`. We deliberately do NOT use `CSVSpliterator`: its column
 * tokenizer hard-codes `skipEmpty` (it builds the column spliterator as `{ delimiter }` with no `skipEmpty: false`), so
 * consecutive delimiters collapse and EMPTY FIELDS ARE DROPPED — fatal for a fixed-width registry like NPPES where a
 * row of 330 columns full of empties would mis-parse to 40 and shift every value. (Upstream `spliterator` bug; revisit
 * when it's fixed.)
 *
 * Assumes an unquoted delimited file (no fields containing the delimiter) — true for these government TSVs. For small,
 * possibly-quoted CSVs use {@link parseCSV} (quote-aware, in-memory).
 */
export async function* streamRows(
	source: string,
	opts: { delimiter?: Delimiter } = {}
): AsyncGenerator<Record<string, string>> {
	const sep = (opts.delimiter ?? delimiterFor(source)) === "tab" ? "\t" : ","
	// Own the file handle so it's closed deterministically. spliterator's `autoDispose` only fires on
	// natural completion, not on an early `break`/`.return()` — which then leaks the fd (a GC-time error
	// in Node 24+). We open it, pass `autoDispose: false` so spliterator never touches our handle, and
	// close it in `finally` (runs on completion AND when the consumer abandons the generator early).
	const handle = await open(source, "r")

	try {
		let header: string[] | null = null

		for await (const line of TextSpliterator.fromAsync(handle, {
			delimiter: Delimiters.LineFeed,
			autoDispose: false,
		})) {
			if (line.length === 0) continue // blank line / trailing newline
			const fields = line.replace(/\r$/, "").split(sep)

			// tolerate CRLF
			if (header === null) {
				header = fields
				continue
			}
			const row: Record<string, string> = {}

			for (let i = 0; i < header.length; i++) row[header[i]!] = fields[i] ?? ""
			yield row
		}
	} finally {
		await handle.close()
	}
}

/**
 * Maps dataset columns to record fields. A field may draw from several columns (joined with spaces).
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
	/**
	 * Extra secondary-identifier fields → the column(s) to draw each from (joined with spaces). Land on
	 * `SourceRecord.attributes` under the same key, for the matcher's `discriminators` (authorized-official name,
	 * taxonomy, license…).
	 */
	attributes?: Record<string, string | string[]>
}

/**
 * Best-effort {@link ColumnMapping} inferred from a header row — the "point it at any CSV" convenience. Each column name
 * is matched (case- and punctuation-insensitive, on whole tokens) to a field by keyword, in a precedence that resolves
 * the common ambiguities: a dedicated id / phone / email column is claimed before the generic sweep, an org / facility
 * column beats a person "name", and address columns (street / city / state / zip…) collect into one multi-column field.
 * Imperfect on bespoke headers (an explicit mapping or the LLM-assisted inference #603 is the answer there), but it
 * nails tidy and semi-tidy files with no hand-mapping. Unmatched columns are left out.
 */
export function inferMapping(header: readonly string[]): ColumnMapping {
	// Pad to whole-token boundaries so "state" doesn't match inside "statement".
	const tok = (h: string) =>
		` ${h
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim()} `
	const mapping: ColumnMapping = {}
	const name: string[] = []
	const address: string[] = []

	for (const column of header) {
		const h = tok(column)
		const has = (...words: string[]): boolean => words.some((w) => h.includes(` ${w} `))

		if (!mapping.email && has("email", "e mail")) mapping.email = column
		else if (!mapping.phone && has("phone", "telephone", "tel", "mobile", "cell")) mapping.phone = column
		else if (!mapping.id && has("id", "npi", "ein", "frn", "spin", "uuid", "guid", "key")) mapping.id = column
		else if (has("org", "organization", "organisation", "company", "business", "facility", "agency", "employer"))
			mapping.organization ??= column
		else if (
			has(
				"street",
				"address",
				"addr",
				"city",
				"town",
				"state",
				"province",
				"zip",
				"zipcode",
				"postal",
				"postcode",
				"county"
			)
		)
			address.push(column)
		else if (has("name", "first", "last", "given", "family", "middle", "surname", "fullname", "contact"))
			name.push(column)
	}

	if (name.length) mapping.name = name.length === 1 ? name[0]! : name

	if (address.length) mapping.address = address

	return mapping
}

/** Options for {@link ingestRows}. */
export interface IngestOptions {
	/** The geocoding seam. Without it, records carry name/org but no resolved address. */
	geocodeAddress?: GeocodeAddress
	/**
	 * Separator for joining a multi-column ADDRESS mapping (name/org always join with a space). Default `" "`. Pass `",
	 * "` to give the parser delimited input (`"214 Main St, Austin, TX 78701"`) instead of a concatenated run (`"214 Main
	 * St Austin TX 78701"`) — the latter strips the parser's segmentation boundaries and is partly OOD (it also breaks
	 * all-caps case-normalization; #694). **Default `", "` (#694 flip, validated).** Comma-join is the correct shape for
	 * an address built from separate columns, and #700 measured it at +15% cross-dataset rooftop (579→667) with no
	 * comma-less crater. The dedup GBT was trained on the old space-joined coords, so this flip is paired with a GBT
	 * re-validation (#694). Pass `" "` to restore the legacy space-join for a byte-stable A/B.
	 */
	addressSeparator?: string
}

/** Parse a CSV string (with a header row) into row objects keyed by column name. */
export function parseCSV(text: string): Record<string, string>[] {
	return parseCSVSync(text, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true })
}

/** Join the named column(s) of a row into a single trimmed string, or undefined if empty. */
export function pick(row: Record<string, string>, columns?: string | string[], separator = " "): string | undefined {
	if (!columns) return undefined
	const list = Array.isArray(columns) ? columns : [columns]
	const value = list
		.map((c) => row[c]?.trim())
		.filter(Boolean)
		.join(separator)
		.trim()

	return value || undefined
}

/**
 * Normalize one tabular row into a {@link SourceRecord} under a {@link ColumnMapping}: parse the person name,
 * canonicalize the org, and (if `opts.geocodeAddress` is provided) geocode the joined address. `id` falls back to the
 * caller-supplied row index. Pure aside from the optional geocode seam, so the deterministic normalization can run
 * single-threaded (see {@link normalizeCSV}) while geocoding is offloaded (see `geocodeStream`).
 */
export async function ingestRow(
	row: Record<string, string>,
	mapping: ColumnMapping,
	index: number,
	opts: IngestOptions = {}
): Promise<SourceRecord> {
	const id = (mapping.id ? row[mapping.id]?.trim() : "") || String(index)
	const nameValue = pick(row, mapping.name)
	const orgValue = pick(row, mapping.organization)
	const addressValue = pick(row, mapping.address, opts.addressSeparator ?? ", ")

	let attributes: Record<string, string> | undefined

	if (mapping.attributes) {
		for (const [key, columns] of Object.entries(mapping.attributes)) {
			const value = pick(row, columns)

			if (value) (attributes ??= {})[key] = value
		}
	}

	return {
		id,
		source: mapping.source,
		name: nameValue ? parsePersonName(nameValue) : undefined,
		organization: orgValue ? canonicalizeOrganizationName(orgValue) : undefined,
		phone: (mapping.phone && row[mapping.phone]?.trim()) || undefined,
		email: (mapping.email && row[mapping.email]?.trim()?.toLowerCase()) || undefined,
		address: addressValue && opts.geocodeAddress ? ((await opts.geocodeAddress(addressValue)) ?? undefined) : undefined,
		attributes,
		raw: row,
	}
}

/**
 * Normalize tabular rows into {@link SourceRecord}s under a {@link ColumnMapping}. Accepts a sync OR async iterable, so
 * {@link parseCSV} (in-memory) and {@link streamRows} (lazy, for huge files) both thread straight through.
 */
export async function ingestRows(
	rows: Iterable<Record<string, string>> | AsyncIterable<Record<string, string>>,
	mapping: ColumnMapping,
	opts: IngestOptions = {}
): Promise<SourceRecord[]> {
	const records: SourceRecord[] = []
	let index = 0

	for await (const row of rows) {
		records.push(await ingestRow(row, mapping, index, opts))
		index++
	}

	return records
}

/**
 * Stream a delimited file as normalized {@link SourceRecord}s — `streamRows` + {@link ingestRow} with **no geocoding**.
 * This is the single-threaded, "fast enough" ergonomic core: column mapping, name parsing, and org canonicalization for
 * a multi-GB file, line by line. Geocode separately by piping the output through `geocodeStream` (the only heavy step
 * worth threading); for a light file (e.g. one that already carries geo cells) just consume this and stop.
 */
export async function* normalizeCSV(
	source: string,
	opts: { mapping: ColumnMapping; delimiter?: Delimiter }
): AsyncGenerator<SourceRecord> {
	let index = 0

	for await (const row of streamRows(source, { delimiter: opts.delimiter })) {
		yield await ingestRow(row, opts.mapping, index)
		index++
	}
}

/**
 * The subset of mailwoman's `GeocodeResult` the adapter consumes — kept structural so this package never imports the
 * heavy geocoder, yet a real `GeocodeResult` maps straight in.
 */
export interface RawGeocode {
	lat: number | null
	lon: number | null
	resolution_tier: AddressGeocode["tier"]
	uncertainty_m: number | null
	hierarchy?: AddressGeocode["hierarchy"]
}

/** The component map {@link toPostalAddress} consumes (kept structural so this package never imports the geocoder). */
type GeocodeComponents = Parameters<typeof toPostalAddress>[0]

/**
 * Build a {@link GeocodeAddress} from mailwoman's real parse + geocode primitives (injected — the CLI constructs the
 * neural parser, resolver, and shards and passes them in). Parse → components → {@link toPostalAddress} (which fills
 * the canonical key + formatted form) → attach the resolved coordinate. When geocoding can't place the address, the
 * parsed-but-unlocated address is still returned.
 *
 * Two shapes:
 *
 * - `{ parse, geocode }` — the original: two independent calls. mailwoman's `geocodeAddress` re-parses internally, so
 *   this parses the address twice (fine when the two callbacks don't share a parser).
 * - `{ parseAndGeocode }` — parse the address ONCE and return both the components and the geocode. Use this when the
 *   parse is the expensive step you'd rather not pay for twice (e.g. share `parseForGeocode`'s tree between the
 *   PostalAddress and `geocodeAddress`'s `parsedTree`). ~1.3× over the two-call shape on a real geocode pipeline.
 */
export function geocodeAddressVia(
	deps: { country?: string } & (
		| {
				parse: (raw: string) => Promise<GeocodeComponents> | GeocodeComponents
				geocode: (raw: string) => Promise<RawGeocode | null> | RawGeocode | null
		  }
		| { parseAndGeocode: (raw: string) => Promise<{ components: GeocodeComponents; geo: RawGeocode | null }> }
	)
): GeocodeAddress {
	return async (raw: string): Promise<PostalAddress | null> => {
		let components: GeocodeComponents
		let resolved: RawGeocode | null

		if ("parseAndGeocode" in deps) {
			const r = await deps.parseAndGeocode(raw)
			components = r.components
			resolved = r.geo
		} else {
			components = await deps.parse(raw)
			resolved = await deps.geocode(raw)
		}

		const base = toPostalAddress(components, { country: deps.country, raw })

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
