/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/annotations` — the composer for the OpenCage-style enrichment block.
 *
 *   {@link AnnotationSet} is the native, typed, camelCase representation. Each recipe package
 *   (timezone, un-locode, coordinate formats in `@mailwoman/spatial`, country reference in
 *   `@mailwoman/codex`) implements the {@link Annotator} interface and fills part of it.
 *   {@link composeAnnotators} runs a set of annotators and merges their output. {@link toOpenCage}
 *   serializes to OpenCage's documented key names for the compat APIs; {@link toNative} returns our
 *   own shape. One schema, two serializers (the hybrid decision).
 */

/** Degrees-minutes-seconds, rendered. */
export interface DMS {
	lat: string
	lon: string
}

/** Web Mercator (EPSG:3857) coordinate. */
export interface Mercator {
	x: number
	y: number
}

/** ISO 4217 currency. */
export interface CurrencyInfo {
	isoCode: string
	name?: string
	symbol?: string
}

/** IANA timezone + current offset. */
export interface TimezoneInfo {
	name: string
	offsetSec?: number
	offsetString?: string
}

/** Solar event times, epoch seconds (UTC) for the queried date. */
export interface SunTimes {
	rise?: number
	set?: number
	noon?: number
}

/** ISO 3166 codes for the resolved country. */
export interface Iso3166 {
	alpha2?: string
	alpha3?: string
	numeric?: string
}

/** EU NUTS statistical-region codes. */
export interface Nuts {
	level1?: string
	level2?: string
	level3?: string
}

/**
 * The native enrichment set. Every field is optional; an annotator fills the slice it owns. camelCase throughout,
 * structured sub-objects — the internal representation the serializers map from.
 */
export interface AnnotationSet {
	dms?: DMS
	mgrs?: string
	maidenhead?: string
	geohash?: string
	mercator?: Mercator
	/** Initial bearing (degrees) to Mecca. */
	qiblaBearing?: number
	sun?: SunTimes
	/** E.164 country calling code (e.g. 1, 44). */
	callingCode?: number
	currency?: CurrencyInfo
	/** Country flag emoji. */
	flag?: string
	timezone?: TimezoneInfo
	iso3166?: Iso3166
	nuts?: Nuts
	/** UN/LOCODE, e.g. "US NYC". */
	unLocode?: string
	/** US county FIPS. */
	fips?: string
	/** Wikidata QID. */
	wikidata?: string
}

/** The input every annotator receives: a coordinate, and the resolved place when one is available. */
export interface AnnotatorInput {
	lat: number
	lon: number
	/** The resolved place (ancestry, country, region…); shape owned by the resolver. */
	place?: unknown
	/** ISO 3166-1 alpha-2 of the resolved country, when known — feeds country-reference annotators. */
	countryCode?: string
	/** The resolved place's name (locality), when known — feeds name-keyed annotators (UN/LOCODE). */
	placeName?: string
	/** The queried date for time-dependent annotations (sun times); defaults to "now" per annotator. */
	date?: Date
}

/** A unit of enrichment: takes a coordinate/place, returns the slice of the set it can fill. */
export type Annotator = (input: AnnotatorInput) => Partial<AnnotationSet> | Promise<Partial<AnnotationSet>>

/**
 * Compose a set of annotators into a single runner. Calling the returned function runs all annotators (concurrently)
 * over one input and merges their results into one {@link AnnotationSet}. Later annotators win on key collisions. An
 * annotator that throws is skipped, so one failing enrichment never sinks the rest.
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

/** OpenCage's `annotations` block, keyed and cased as OpenCage documents it. */
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
 * Serialize the native set to OpenCage's `annotations` key names + casing, for the compat APIs. Only the populated
 * fields are emitted.
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

/** Return the native set (the stable public native shape). */
export function toNative(set: AnnotationSet): AnnotationSet {
	return set
}

// ---------------------------------------------------------------------------
// schema.org Place / PostalAddress / GeoCoordinates — a JSON-LD OUTPUT projection (#1052)
// ---------------------------------------------------------------------------

/**
 * A schema.org [`GeoCoordinates`](https://schema.org/GeoCoordinates) node — the resolved coordinate, embedded under a
 * {@link SchemaOrgPlace}'s `geo`.
 */
export interface SchemaOrgGeoCoordinates {
	"@type": "GeoCoordinates"
	latitude: number
	longitude: number
}

/**
 * A schema.org [`PostalAddress`](https://schema.org/PostalAddress) node. Only populated fields are emitted (never
 * `null`). `streetAddress` is a single opaque line — the house-number/street/unit distinction is intentionally
 * collapsed (schema.org has no structured slots for them). `addressCountry` is ISO-3166 alpha-2.
 */
export interface SchemaOrgPostalAddress {
	"@type": "PostalAddress"
	streetAddress?: string
	postOfficeBoxNumber?: string
	addressLocality?: string
	addressRegion?: string
	postalCode?: string
	/** ISO-3166 alpha-2 (e.g. `"FR"`). */
	addressCountry?: string
}

/**
 * A schema.org [`Place`](https://schema.org/Place) node with an embedded `PostalAddress` + `GeoCoordinates` — the
 * JSON-LD projection returned by {@link toSchemaOrg}. Its `@context` makes the object valid linked data on its own.
 */
export interface SchemaOrgPlace {
	"@context": "https://schema.org"
	"@type": "Place"
	name?: string
	geo?: SchemaOrgGeoCoordinates
	address?: SchemaOrgPostalAddress
}

/**
 * The neutral resolved-address input {@link toSchemaOrg} serializes. Every field is optional; an absent field is omitted
 * from the output entirely (no `null`s). Mirrors the {@link OpenCageAnnotations} precedent: one native shape, a
 * dedicated serializer per wire format.
 */
export interface SchemaOrgInput {
	lat?: number | null
	lon?: number | null
	/** The resolved POI / venue name, when one exists. Omitted for a bare street address. */
	name?: string
	/**
	 * The rendered street line (house number + street + unit) as ONE string. Compose it with the locale-aware
	 * `@mailwoman/formatter` (`formatAddress`) where available, or {@link composeStreetAddress} for a plain join.
	 */
	streetAddress?: string
	/** PO box number, when the address is a PO box (→ `postOfficeBoxNumber`). */
	poBox?: string
	locality?: string
	region?: string
	postalCode?: string
	/** ISO-3166 alpha-2 (any case); emitted uppercased as `addressCountry`. */
	countryCode?: string
}

/**
 * Collapse parsed street parts into one opaque `streetAddress` line — the schema.org lossy-by-design collapse (house
 * number + street + unit → a single space-joined string). Parts are number-FIRST, correct for the shipped en-US / fr-FR
 * tiers; callers with `@mailwoman/formatter` render locale-aware (e.g. de-DE number-last) instead. Blank parts are
 * dropped; an all-empty input yields `""`.
 */
export function composeStreetAddress(parts: { houseNumber?: string; street?: string; unit?: string }): string {
	return [parts.houseNumber, parts.street, parts.unit]
		.map((p) => p?.trim())
		.filter(Boolean)
		.join(" ")
}

/**
 * Serialize a resolved address into a schema.org `Place` JSON-LD object — `Place { geo: GeoCoordinates, address:
 * PostalAddress }` (#1052). An OUTPUT PROJECTION, lossy by design: `streetAddress` is one opaque string, and
 * tiers/confidence/provenance don't fit the core vocabulary, so they're dropped rather than shoehorned into an
 * extension property. Only populated fields are emitted — absent fields are omitted entirely (never `null`).
 * `addressCountry` is ISO-3166 alpha-2 (uppercased). `geo` is emitted only when both coordinates are finite; the
 * `address` block only when at least one address field is present.
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

	const assign = (key: Exclude<keyof SchemaOrgPostalAddress, "@type">, value: string | undefined): void => {
		const trimmed = value?.trim()

		if (trimmed) {
			address[key] = trimmed
			hasField = true
		}
	}

	assign("streetAddress", input.streetAddress)
	assign("postOfficeBoxNumber", input.poBox)
	assign("addressLocality", input.locality)
	assign("addressRegion", input.region)
	assign("postalCode", input.postalCode)
	assign("addressCountry", input.countryCode?.toUpperCase())

	if (hasField) {
		place.address = address
	}

	return place
}
