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

	if (set.dms) out.DMS = { lat: set.dms.lat, lng: set.dms.lon }

	if (set.mgrs != null) out.MGRS = set.mgrs

	if (set.maidenhead != null) out.Maidenhead = set.maidenhead

	if (set.mercator) out.Mercator = { x: set.mercator.x, y: set.mercator.y }

	if (set.geohash != null) out.geohash = set.geohash

	if (set.qiblaBearing != null) out.qibla = set.qiblaBearing

	if (set.sun) {
		out.sun = {}

		if (set.sun.rise != null) out.sun.rise = { apparent: set.sun.rise }

		if (set.sun.set != null) out.sun.set = { apparent: set.sun.set }
	}

	if (set.callingCode != null) out.callingcode = set.callingCode

	if (set.currency) {
		out.currency = { iso_code: set.currency.isoCode }

		if (set.currency.name != null) out.currency.name = set.currency.name

		if (set.currency.symbol != null) out.currency.symbol = set.currency.symbol
	}

	if (set.flag != null) out.flag = set.flag

	if (set.timezone) {
		out.timezone = { name: set.timezone.name }

		if (set.timezone.offsetSec != null) out.timezone.offset_sec = set.timezone.offsetSec

		if (set.timezone.offsetString != null) out.timezone.offset_string = set.timezone.offsetString
	}

	if (set.nuts) {
		out.NUTS = {}

		if (set.nuts.level1 != null) out.NUTS.NUTS1 = { code: set.nuts.level1 }

		if (set.nuts.level2 != null) out.NUTS.NUTS2 = { code: set.nuts.level2 }

		if (set.nuts.level3 != null) out.NUTS.NUTS3 = { code: set.nuts.level3 }
	}

	if (set.unLocode != null) out.UN_LOCODE = set.unLocode

	if (set.wikidata != null) out.wikidata = set.wikidata

	if (set.fips != null) out.FIPS = { county: set.fips }

	return out
}

/** Return the native set (the stable public native shape). */
export function toNative(set: AnnotationSet): AnnotationSet {
	return set
}
