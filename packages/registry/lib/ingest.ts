/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Column mapping and normalization are pure. Geocoding is an injected dependency, so this package never imports the neural parser, resolver, or extracts.
 */

import { isPresent } from "@mailwoman/core/objects"
import type { AddressGeocode, PostalAddress } from "@mailwoman/record"
import { canonicalizeOrganizationName, parsePersonName, toPostalAddress, withGeocode } from "@mailwoman/record"
import type { PathBuilderLike } from "path-ts"
import { type AsyncSequence, CSVSpliterator, Delimiters } from "spliterator"

import type { SourceRecord } from "#types"

/**
 * Resolve a raw address string into a {@link PostalAddress}, the entry point to mailwoman's geocoder.
 */
export type GeocodeAddress = (raw: string) => Promise<PostalAddress | null> | PostalAddress | null

/**
 * The column delimiters a tabular source may declare, by name, each the spliterator's own byte.
 *
 * The `satisfies` clause makes a delimiter name spliterator no longer ships a compile error
 * rather than a silently parallel vocabulary.
 */
const COLUMN_DELIMITERS = {
	comma: Delimiters.Comma,
	tab: Delimiters.Tab,
} as const satisfies Partial<Record<Lowercase<keyof typeof Delimiters>, (typeof Delimiters)[keyof typeof Delimiters]>>

/**
 * Column delimiter of a delimited source.
 */
export type Delimiter = keyof typeof COLUMN_DELIMITERS

/**
 * Infer the delimiter from a path's extension (`.tsv` → tab, else comma).
 */
export function delimiterFor(path: string): Delimiter {
	return /\.tsv$/i.test(path) ? "tab" : "comma"
}

/**
 * Stream a delimited file's rows lazily as header-keyed objects.
 *
 * @returns The spliterator's own {@linkcode AsyncSequence}, whose `map`/`filter`
 * fuse into the same pull loop.
 * Wrapping this in an `async function*` would cost an async frame per row and take those operators away.
 */
export function streamRows(
	source: PathBuilderLike,
	opts: { delimiter?: Delimiter } = {}
): AsyncSequence<Record<string, string>> {
	const path = source.toString()

	return CSVSpliterator.fromAsync<Record<string, string>>(path, {
		columnDelimiter: COLUMN_DELIMITERS[opts.delimiter ?? delimiterFor(path)],
		// A {@linkcode ColumnMapping} holds columns in the publisher's spelling rather than a
		// normalized key such as `facility_name`, so the keys must arrive as the file writes them.
		// The reader's default normalizes.
		normalizeKeys: false,
	})
}

/**
 * Maps dataset columns to record fields, where a field may draw from several columns joined with spaces.
 */
export interface ColumnMapping {
	/**
	 * Column holding a stable row id, falling back to the row index.
	 */
	id?: string
	/**
	 * A literal provenance label for every row (not a column).
	 */
	source?: string
	name?: string | string[]
	organization?: string | string[]
	address?: string | string[]
	phone?: string
	email?: string
	/**
	 * Extra secondary-identifier fields mapped to the column(s) to draw each from, landing
	 * on `SourceRecord.attributes` under the same key for the matcher's `discriminators`.
	 */
	attributes?: Record<string, string | string[]>
}

/**
 * Best-effort {@link ColumnMapping} inferred from a header row, the "point it at any CSV" convenience.
 */
export function inferMapping(header: readonly string[]): ColumnMapping {
	// Pad to whole-token boundaries so "state" doesn't match inside "statement".
	const tok = (h: string) =>
		` ${h
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, " ")
			.trim()} `

	const mapping: ColumnMapping = {}
	const name: string[] = []
	const address: string[] = []

	for (const column of header) {
		const h = tok(column)
		const has = (...words: string[]): boolean => words.some((w) => h.includes(` ${w} `))

		if (!mapping.email && has("email", "e mail")) {
			mapping.email = column
		} else if (!mapping.phone && has("phone", "telephone", "tel", "mobile", "cell")) {
			mapping.phone = column
		} else if (!mapping.id && has("id", "npi", "ein", "frn", "spin", "uuid", "guid", "key")) {
			mapping.id = column
		} else if (has("org", "organization", "organisation", "company", "business", "facility", "agency", "employer")) {
			mapping.organization ??= column
		} else if (
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
		) {
			address.push(column)
		} else if (has("name", "first", "last", "given", "family", "middle", "surname", "fullname", "contact")) {
			name.push(column)
		}
	}

	if (name.length) {
		mapping.name = name.length === 1 ? name[0]! : name
	}

	if (address.length) {
		mapping.address = address
	}

	return mapping
}

/**
 * Options for {@link ingestRows}.
 */
export interface IngestOptions {
	/**
	 * The geocoding interface.
	 * Without it records carry name/org but no resolved address.
	 */
	geocodeAddress?: GeocodeAddress
	/**
	 * Separator for joining a multi-column address mapping, comma-join giving the parser delimited
	 * input rather than a concatenated run (name/org always join with a space). @default ", "
	 */
	addressSeparator?: string
}

/**
 * Join the named column(s) of a row into a single trimmed string, or undefined if empty.
 */
export function pick(row: Record<string, string>, columns?: string | string[], separator = " "): string | undefined {
	if (!columns) return undefined
	const list = Array.isArray(columns) ? columns : [columns]

	const value = list
		.map((c) => row[c])
		.filter(isPresent)
		.join(separator)
		.trim()

	return value || undefined
}

/**
 * Normalize one tabular row into a {@link SourceRecord} under a {@link ColumnMapping},
 * pure aside from the optional geocode interface so the deterministic normalization
 * can run single-threaded while geocoding is offloaded.
 */
export async function ingestRow(
	row: Record<string, string>,
	mapping: ColumnMapping,
	index: number,
	opts: IngestOptions = {}
): Promise<SourceRecord> {
	const id = (mapping.id ? row[mapping.id] : "") || String(index)
	const nameValue = pick(row, mapping.name)
	const orgValue = pick(row, mapping.organization)
	const addressValue = pick(row, mapping.address, opts.addressSeparator ?? ", ")

	let attributes: Record<string, string> | undefined

	if (mapping.attributes) {
		for (const [key, columns] of Object.entries(mapping.attributes)) {
			const value = pick(row, columns)

			if (value) {
				;(attributes ??= {})[key] = value
			}
		}
	}

	return {
		id,
		source: mapping.source,
		name: nameValue ? parsePersonName(nameValue) : undefined,
		organization: orgValue ? canonicalizeOrganizationName(orgValue) : undefined,
		phone: (mapping.phone && row[mapping.phone]) || undefined,
		email: (mapping.email && row[mapping.email]?.toLowerCase()) || undefined,
		address: addressValue && opts.geocodeAddress ? ((await opts.geocodeAddress(addressValue)) ?? undefined) : undefined,
		attributes,
		raw: row,
	}
}

/**
 * Normalize tabular rows into {@link SourceRecord}s under a {@link ColumnMapping}.
 *
 * @see {@link streamRows} for the streaming path, which is the preferred way to handle multi-GB files.
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
 * Stream a delimited file as normalized {@link SourceRecord}s in file order with no geocoding.
 * Geocode separately through `geocodeStream`.
 */
export function normalizeCSV(
	source: PathBuilderLike,
	opts: { mapping: ColumnMapping; delimiter?: Delimiter }
): AsyncSequence<SourceRecord> {
	return streamRows(source, { delimiter: opts.delimiter }).map((row, index) => ingestRow(row, opts.mapping, index))
}

/**
 * The subset of mailwoman's `GeocodeResult` the adapter consumes, kept structural
 * so this package never imports the heavy geocoder.
 */
export interface RawGeocode {
	lat: number | null
	lon: number | null
	resolution_tier: AddressGeocode["tier"]
	uncertainty_m: number | null
	hierarchy?: AddressGeocode["hierarchy"]
}

/**
 * The component map {@link toPostalAddress} consumes
 * (kept structural so this package never imports the geocoder).
 */
type GeocodeComponents = Parameters<typeof toPostalAddress>[0]

/**
 * What every shape of {@link geocodeAddressVia}'s dependencies carries.
 */
export interface GeocodeDepsBase {
	/**
	 * Country (ISO-2 or name) the address is formatted under.
	 *
	 * When omitted, {@link toPostalAddress} reads the parsed `country` component instead.
	 */
	country?: string
}

/**
 * Two independent calls: parse the address, then geocode it.
 *
 * Mailwoman's `geocodeAddress` re-parses internally, so the address is read twice
 * unless the two callbacks share a parser.
 */
export interface TwoStepGeocodeDeps extends GeocodeDepsBase {
	parse: (raw: string) => Promise<GeocodeComponents> | GeocodeComponents
	geocode: (raw: string) => Promise<RawGeocode | null> | RawGeocode | null
}

/**
 * Parse the address once and answer both the components and the geocode, for
 * when the parse is the expensive step you'd rather not pay for twice.
 */
export interface OneStepGeocodeDeps extends GeocodeDepsBase {
	parseAndGeocode: (raw: string) => Promise<{ components: GeocodeComponents; geo: RawGeocode | null }>
}

/**
 * The dependencies {@link geocodeAddressVia} builds a {@link GeocodeAddress} from;
 * `"parseAndGeocode" in deps` tells the two shapes apart.
 */
export type GeocodeAddressViaDeps = TwoStepGeocodeDeps | OneStepGeocodeDeps

/**
 * Build a {@link GeocodeAddress} from injected parse and geocode primitives.
 *
 * When geocoding can't place the address, the parsed-but-unlocated address is still returned.
 */
export function geocodeAddressVia(deps: GeocodeAddressViaDeps): GeocodeAddress {
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
