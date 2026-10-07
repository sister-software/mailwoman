/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The composer for the OpenCage-style enrichment block.
 */

/**
 * Degrees-minutes-seconds, rendered.
 */
export interface DMS {
	lat: string
	lon: string
}

/**
 * Web Mercator (epsg:3857) coordinate.
 */
export interface Mercator {
	x: number
	y: number
}

/**
 * ISO 4217 currency.
 */
export interface CurrencyInfo {
	isoCode: string
	name?: string
	symbol?: string
}

/**
 * Iana timezone + current offset.
 */
export interface TimezoneInfo {
	name: string
	offsetSec?: number
	offsetString?: string
}

/**
 * Solar event times, epoch seconds (UTC) for the queried date.
 */
export interface SunTimes {
	rise?: number
	set?: number
	noon?: number
}

/**
 * ISO 3166 codes for the resolved country.
 */
export interface Iso3166 {
	alpha2?: string
	alpha3?: string
	numeric?: string
}

/**
 * EU nuts statistical-region codes.
 */
export interface NUTS {
	level1?: string
	level2?: string
	level3?: string
}

/**
 * The native enrichment set the serializers map from.
 */
export interface AnnotationSet {
	dms?: DMS
	mgrs?: string
	maidenhead?: string
	geohash?: string
	mercator?: Mercator
	/**
	 * Initial direction (degrees) to Mecca.
	 */
	qiblaBearing?: number
	sun?: SunTimes
	/**
	 * E.164 country calling code (e.g. 1, 44).
	 */
	callingCode?: number
	currency?: CurrencyInfo
	/**
	 * Country flag emoji.
	 */
	flag?: string
	timezone?: TimezoneInfo
	iso3166?: Iso3166
	nuts?: NUTS
	/**
	 * UN/locode, e.g. "US NYC".
	 */
	unLocode?: string
	/**
	 * US county FIPS.
	 */
	fips?: string
	/**
	 * Wikidata QID.
	 */
	wikidata?: string
}

/**
 * The input every annotator receives: a coordinate plus the resolved place when one is available.
 */
export interface AnnotatorInput {
	lat: number
	lon: number
	/**
	 * The resolved place (ancestry, country, region and so on), whose shape belongs to the resolver.
	 */
	place?: unknown
	/**
	 * ISO 3166-1 alpha-2 of the resolved country when known.
	 * Country-reference annotators use this value.
	 */
	countryCode?: string
	/**
	 * The resolved place's name (locality) when known.
	 * Name-keyed annotators (UN/locode) use this value.
	 */
	placeName?: string
	/**
	 * The queried date for time-dependent annotations (sun times), defaulting to "now" per annotator.
	 */
	date?: Date
}

/**
 * A unit of enrichment: takes a coordinate/place, returns the fields of the set it can fill.
 */
export type Annotator = (input: AnnotatorInput) => Partial<AnnotationSet> | Promise<Partial<AnnotationSet>>

/**
 * Compose a set of annotators into a runner that merges their fields, skipping any annotator that throws.
 */
export function composeAnnotators(annotators: Annotator[]): (input: AnnotatorInput) => Promise<AnnotationSet> {
	return async (input) => {
		const parts = await Promise.all(
			annotators.map(async (annotate): Promise<Partial<AnnotationSet>> => {
				try {
					return await annotate(input)
				} catch {
					return {}
				}
			})
		)

		return Object.assign({}, ...parts) as AnnotationSet
	}
}

/**
 * OpenCage's `annotations` block, keyed and cased as OpenCage documents it.
 */
export interface OpenCageAnnotations {
	DMS?: { lat: string; lng: string }
	MGRS?: string
	Maidenhead?: string
	Mercator?: { x: number; y: number }
	geohash?: string
	qibla?: number
	sun?: { rise?: Record<string, number>; set?: Record<string, number> }
	callingcode?: number
	currency?: { iso_code: string; name?: string; symbol?: string }
	flag?: string
	timezone?: { name: string; offset_sec?: number; offset_string?: string }
	NUTS?: { NUTS0?: { code: string }; NUTS1?: { code: string }; NUTS2?: { code: string }; NUTS3?: { code: string } }
	UN_LOCODE?: string
	wikidata?: string
	FIPS?: { county?: string }
}

/**
 * Serialize the native set to OpenCage's `annotations` key names and casing,
 * emitting only populated fields.
 */
export function toOpenCage(set: AnnotationSet): OpenCageAnnotations {
	const out: OpenCageAnnotations = {}

	if (set.dms) {
		out.DMS = { lat: set.dms.lat, lng: set.dms.lon }
	}

	if (set.mgrs != null) {
		out.MGRS = set.mgrs
	}

	if (set.maidenhead != null) {
		out.Maidenhead = set.maidenhead
	}

	if (set.mercator) {
		out.Mercator = { x: set.mercator.x, y: set.mercator.y }
	}

	if (set.geohash != null) {
		out.geohash = set.geohash
	}

	if (set.qiblaBearing != null) {
		out.qibla = set.qiblaBearing
	}

	if (set.sun) {
		out.sun = {}

		if (set.sun.rise != null) {
			out.sun.rise = { apparent: set.sun.rise }
		}

		if (set.sun.set != null) {
			out.sun.set = { apparent: set.sun.set }
		}
	}

	if (set.callingCode != null) {
		out.callingcode = set.callingCode
	}

	if (set.currency) {
		out.currency = { iso_code: set.currency.isoCode }

		if (set.currency.name != null) {
			out.currency.name = set.currency.name
		}

		if (set.currency.symbol != null) {
			out.currency.symbol = set.currency.symbol
		}
	}

	if (set.flag != null) {
		out.flag = set.flag
	}

	if (set.timezone) {
		out.timezone = { name: set.timezone.name }

		if (set.timezone.offsetSec != null) {
			out.timezone.offset_sec = set.timezone.offsetSec
		}

		if (set.timezone.offsetString != null) {
			out.timezone.offset_string = set.timezone.offsetString
		}
	}

	if (set.nuts) {
		out.NUTS = {}

		if (set.nuts.level1 != null) {
			out.NUTS.NUTS1 = { code: set.nuts.level1 }
		}

		if (set.nuts.level2 != null) {
			out.NUTS.NUTS2 = { code: set.nuts.level2 }
		}

		if (set.nuts.level3 != null) {
			out.NUTS.NUTS3 = { code: set.nuts.level3 }
		}
	}

	if (set.unLocode != null) {
		out.UN_LOCODE = set.unLocode
	}

	if (set.wikidata != null) {
		out.wikidata = set.wikidata
	}

	if (set.fips != null) {
		out.FIPS = { county: set.fips }
	}

	return out
}

/**
 * Return the native set (the stable public native shape).
 */
export function toNative(set: AnnotationSet): AnnotationSet {
	return set
}

/**
 * A schema.org [`GeoCoordinates`](https://schema.org/GeoCoordinates) node holding the
 * resolved coordinate, embedded under a {@link SchemaOrgPlace}'s `geo`.
 */
export interface SchemaOrgGeoCoordinates {
	"@type": "GeoCoordinates"
	latitude: number
	longitude: number
}

/**
 * A schema.org [`PostalAddress`](https://schema.org/PostalAddress) node that emits only populated fields
 * and collapses the house-number, street and unit distinction into one opaque `streetAddress` line.
 */
export interface SchemaOrgPostalAddress {
	"@type": "PostalAddress"
	streetAddress?: string
	postOfficeBoxNumber?: string
	addressLocality?: string
	addressRegion?: string
	postalCode?: string
	/**
	 * ISO-3166 alpha-2 (e.g. `"FR"`).
	 */
	addressCountry?: string
}

/**
 * A schema.org [`Place`](https://schema.org/Place) node with an embedded `PostalAddress`
 * and `GeoCoordinates`, returned as valid linked data by {@link toSchemaOrg}.
 */
export interface SchemaOrgPlace {
	"@context": "https://schema.org"
	"@type": "Place"
	name?: string
	geo?: SchemaOrgGeoCoordinates
	address?: SchemaOrgPostalAddress
}

/**
 * The neutral resolved-address input {@link toSchemaOrg} serializes, omitting every absent field.
 */
export interface SchemaOrgInput {
	lat?: number | null
	lon?: number | null
	/**
	 * The resolved POI or venue name when one exists, omitted for a bare street address.
	 */
	name?: string
	/**
	 * The rendered street line (house number + street + unit) as one string.
	 *
	 * Use `@mailwoman/codex/address/format` for locale-aware rendering
	 * or {@link composeStreetAddress} for a plain join.
	 */
	streetAddress?: string
	/**
	 * PO box number, when the address is a PO box (→ `postOfficeBoxNumber`).
	 */
	poBox?: string
	locality?: string
	region?: string
	postalCode?: string
	/**
	 * ISO-3166 alpha-2 in any case, emitted uppercased as `addressCountry`.
	 */
	countryCode?: string
}

/**
 * Collapse parsed street parts into one space-joined `streetAddress` line,
 * dropping blank parts and yielding `""` for an all-empty input.
 */
export function composeStreetAddress(parts: { houseNumber?: string; street?: string; unit?: string }): string {
	return [parts.houseNumber, parts.street, parts.unit]
		.map((part) => part?.trim())
		.filter((part) => part !== undefined && part.length)
		.join(" ")
}

/**
 * Serialize a resolved address into a schema.org `Place` JSON-LD object, emitting only
 * populated fields and the `address` block only when at least one address field is present.
 */
export function toSchemaOrg(input: SchemaOrgInput): SchemaOrgPlace {
	const place: SchemaOrgPlace = { "@context": "https://schema.org", "@type": "Place" }

	if (input.name?.trim()) {
		place.name = input.name.trim()
	}

	if (input.lat != null && input.lon != null && Number.isFinite(input.lat) && Number.isFinite(input.lon)) {
		place.geo = { "@type": "GeoCoordinates", latitude: input.lat, longitude: input.lon }
	}

	const address: SchemaOrgPostalAddress = { "@type": "PostalAddress" }
	let hasField = false

	const assign = (key: Exclude<keyof SchemaOrgPostalAddress, "@type">, value: string | null): void => {
		const trimmed = value?.trim()

		if (trimmed) {
			address[key] = trimmed
			hasField = true
		}
	}

	assign("streetAddress", input.streetAddress ?? null)
	assign("postOfficeBoxNumber", input.poBox ?? null)
	assign("addressLocality", input.locality ?? null)
	assign("addressRegion", input.region ?? null)
	assign("postalCode", input.postalCode ?? null)
	assign("addressCountry", input.countryCode?.toUpperCase() ?? null)

	if (hasField) {
		place.address = address
	}

	return place
}
