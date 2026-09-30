/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Read an INSPIRE Addresses (AD) theme from a member state's WFS download service.
 *
 * The INSPIRE Directive makes Addresses a mandatory Annex I theme and accepts two kinds of download
 * service: a predefined-dataset ATOM feed and a Web Feature Service. Most member states publish the
 * second, so a file download reaches only a minority of them.
 *
 * An `ad:Address` feature carries its point, its lifecycle dates and its locator. It does not carry
 * its street name, its postcode or its administrative units: those are separate feature types, and
 * the address references them through `component`. A complete address is therefore assembled from
 * several feature types rather than read from one.
 *
 * Measured on Slovakia's service, one address holds four component references that resolve to three
 * `ad:AdminUnitName` features and one `ad:PostalDescriptor`. Resolving each reference with its own
 * request would cost roughly four requests per address, which is 6.8 million for that service's
 * 1,704,196 addresses. This module therefore pages each feature type in bulk and joins locally.
 *
 * A service's feature count is read with `readCheckedWFSFeatureCount` from `@mailwoman/core/api`,
 * which owns every WFS count this repository takes.
 */

import { assertNoOGCServiceException, type APIClient } from "@mailwoman/core/api"
import { stringifyJSON, tryParsingJSON } from "@mailwoman/core/json"

/**
 * The WFS version this module speaks.
 *
 * 2.0.0 is the version that defines `startIndex` paging and the `hits` result type,
 * and it is what every service measured for this module advertises.
 */
const WFS_VERSION = "2.0.0"

/**
 * The feature types an INSPIRE Addresses service publishes.
 *
 * `Address` is the subject.
 * The other four are the components an address references, and each has to be
 * paged separately to build the join.
 */
export const AD_FEATURE_TYPES = [
	"Address",
	"ThoroughfareName",
	"PostalDescriptor",
	"AdminUnitName",
	"AddressAreaName",
] as const

/**
 * One of the {@link AD_FEATURE_TYPES}.
 */
export type ADFeatureType = (typeof AD_FEATURE_TYPES)[number]

/**
 * The AD feature type a service's qualified name denotes, or `null` where it denotes none.
 *
 * Services name the same type four ways, measured across the four this module was written from.
 * Slovakia and Flanders publish `ad:Address`.
 *
 * Estonia publishes `AD_Address:AD.Address` and `AD_Address:AD.Address_ThoroughfareName`.
 * Poland publishes `ms:AD.Address`.
 *
 * A reader that compares the part after the colon against `Address` finds a type
 * on two services and none on the other two, which reads as a service publishing
 * no addresses rather than as a naming difference.
 */
export function adFeatureTypeOf(qualifiedName: string): ADFeatureType | null {
	const local = qualifiedName.slice(qualifiedName.lastIndexOf(":") + 1)

	const bare = local.startsWith("AD.Address_")
		? local.slice("AD.Address_".length)
		: local.startsWith("AD.")
			? local.slice("AD.".length)
			: local

	return AD_FEATURE_TYPES.find((type) => type === bare) ?? null
}

/**
 * What a service's capabilities document states about itself.
 */
export interface WFSCapabilities {
	/**
	 * Every `outputFormat` value the service advertises for `GetFeature`.
	 */
	outputFormats: readonly string[]
	/**
	 * The advertised format this module would ask for, or `null` when the service offers no JSON.
	 *
	 * A service without one is readable through its GML, which this module leaves
	 * to its caller rather than reporting as unreadable.
	 *
	 * `application/json` is preferred over `application/geo+json` because a service
	 * may advertise the second and reject it.
	 * Estonia advertises both and answers a `GetFeature` for `application/geo+json`
	 * with `InvalidParameterValue: Failed to find response for output format`,
	 * while the same request under `application/json` returns the features.
	 */
	jsonFormat: string | null
	/**
	 * Every advertised JSON format, in the order this module would try them.
	 *
	 * A caller whose first request is rejected tries the next rather than concluding that the
	 * service serves no JSON, because an advertised format is a claim rather than a guarantee.
	 */
	jsonFormats: readonly string[]
	/**
	 * Whether the service advertises `ImplementsResultPaging`.
	 *
	 * A service that does not cannot be paged, so a caller has to take the whole
	 * type in one request or decline it.
	 * Reading past the first page of such a service silently repeats page one.
	 */
	supportsPaging: boolean
	/**
	 * The qualified type name for each AD feature type the service publishes, keyed by the local name.
	 *
	 * The prefix differs per service: Slovakia and Flanders publish `ad:Address`,
	 * and Estonia publishes under its own prefix.
	 * A caller that assumes `ad:` receives HTTP 400 from the rest.
	 */
	typeNames: Readonly<Partial<Record<ADFeatureType, string>>>
}

/**
 * A value a GeoServer JSON response uses for a voidable property that holds no value.
 *
 * INSPIRE marks many attributes voidable, which requires the property to be present
 * carrying either a value or a void with a reason.
 * GeoServer encodes that void as an object rather than as `null`, so `String(value)`
 * on one yields `[object Object]` and stores it as though it were data.
 */
export interface VoidedValue {
	"@nil": string | boolean
	"@nilReason"?: string
}

/**
 * Is this property value a void rather than a value?
 */
export function isVoided(value: unknown): value is VoidedValue {
	return (
		typeof value === "object" && value !== null && "@nil" in value && String((value as VoidedValue)["@nil"]) === "true"
	)
}

/**
 * The value of a property, or `null` where the service marked it void or omitted it.
 *
 * `null` for a void keeps the void from reaching a caller as the text `[object Object]`.
 *
 * INSPIRE separates a void from an absence: an absent property states that no value exists,
 * and a void states that whether one exists is unknown.
 * This collapses both to `null`, so a caller that needs the two apart reads the
 * property's presence on `properties` itself.
 */
export function readVoidable<T>(value: T | VoidedValue | undefined): T | null {
	if (value === undefined || isVoided(value)) return null

	return value as T
}

/**
 * Reads a service's capabilities, so a caller asks only for what the service offers.
 */
export async function readWFSCapabilities(
	client: Pick<APIClient, "fetch">,
	options: { wfsURL: string; context: string }
): Promise<WFSCapabilities> {
	const { data } = await client.fetch<string>({
		method: "GET",
		url: options.wfsURL,
		responseType: "text",
		params: { service: "WFS", version: WFS_VERSION, request: "GetCapabilities" },
	})

	assertNoOGCServiceException(data, options.context)

	const outputFormats = [
		...new Set(
			[...data.matchAll(/<(?:\w+:)?Parameter\s+name="outputFormat"[\s\S]*?<\/(?:\w+:)?Parameter>/giu)]
				.flatMap((block) => [...(block[0] ?? "").matchAll(/<(?:\w+:)?Value>([\s\S]*?)<\/(?:\w+:)?Value>/giu)])
				.map((match) => (match[1] ?? "").trim())
				.filter((format) => format.length > 0)
		),
	]

	if (!outputFormats.length) {
		throw new Error(
			`${options.context}: the capabilities document advertised no outputFormat values, so the formats this service accepts could not be read`
		)
	}

	const typeNames: Partial<Record<ADFeatureType, string>> = {}

	// Only the feature-type list declares feature types.
	// `Name` also labels operation parameters and service contacts, and one of those
	// matching would publish a type the service lacks.
	const featureTypeList = data.match(/<(?:\w+:)?FeatureTypeList>[\s\S]*?<\/(?:\w+:)?FeatureTypeList>/iu)?.[0] ?? ""

	for (const match of featureTypeList.matchAll(/<(?:\w+:)?Name>\s*([\w.:_-]+)\s*<\/(?:\w+:)?Name>/giu)) {
		const qualified = match[1] ?? ""
		const known = adFeatureTypeOf(qualified)

		if (known && !typeNames[known]) {
			typeNames[known] = qualified
		}
	}

	// `application/json` is GeoServer's GeoJSON writer, and `application/geo+json` is
	// the alias a service may advertise without implementing.
	// The other JSON-ish formats carry a different envelope, so they are left out rather than tried.
	const jsonFormats = ["application/json", "application/geo+json"].filter((format) => outputFormats.includes(format))

	return {
		outputFormats,
		jsonFormat: jsonFormats[0] ?? null,
		jsonFormats,
		supportsPaging: /ImplementsResultPaging[\s\S]{0,120}?>\s*(?:TRUE|true)\s*</u.test(data),
		typeNames,
	}
}

/**
 * One page of features, as the service returned them.
 */
export interface FeaturePage<Feature> {
	features: readonly Feature[]
	/**
	 * The count the service reported for the whole query, or `null` where it declined to state one.
	 *
	 * A service may answer `unknown`, which is a refusal to count rather than a count of zero.
	 */
	numberMatched: number | null
	numberReturned: number
}

/**
 * A GeoJSON feature, as far as this module reads one.
 */
export interface GeoJSONFeature {
	type: "Feature"
	id?: string
	geometry: { type: string; coordinates: unknown } | null
	properties: Record<string, unknown>
}

/**
 * Reads one page of a feature type.
 *
 * `startIndex` past the first page needs {@linkcode WFSCapabilities.supportsPaging}.
 * A service that declines paging answers page two with page one, so this refuses
 * rather than returning the repeat.
 */
export async function readFeaturePage(
	client: Pick<APIClient, "fetch">,
	options: {
		wfsURL: string
		typeName: string
		outputFormat: string
		count: number
		startIndex: number
		supportsPaging: boolean
		context: string
	}
): Promise<FeaturePage<GeoJSONFeature>> {
	if (options.startIndex > 0 && !options.supportsPaging) {
		throw new Error(
			`${options.context}: a page was requested at startIndex ${options.startIndex} from a service that does not advertise ImplementsResultPaging, and such a service answers every page with the first`
		)
	}

	const { data } = await client.fetch<string>({
		method: "GET",
		url: options.wfsURL,
		responseType: "text",
		params: {
			service: "WFS",
			version: WFS_VERSION,
			request: "GetFeature",
			typeNames: options.typeName,
			outputFormat: options.outputFormat,
			count: String(options.count),
			startIndex: String(options.startIndex),
		},
	})

	assertNoOGCServiceException(data, options.context)

	const payload = tryParsingJSON<{ features?: GeoJSONFeature[]; numberMatched?: unknown; numberReturned?: unknown }>(
		data
	)

	if (!payload) {
		throw new TypeError(
			`${options.context}: the service answered ${stringifyJSON(options.outputFormat)} with a body that is not JSON, beginning ${stringifyJSON(data.slice(0, 120))}`
		)
	}

	if (!Array.isArray(payload.features)) {
		throw new TypeError(`${options.context}: the response carried no features array, so the page could not be read`)
	}

	// A service may report `unknown`, which declines to count rather than counting none.
	const matched = payload.numberMatched
	const numberMatched = typeof matched === "number" ? matched : /^\d+$/u.test(String(matched)) ? Number(matched) : null

	return {
		features: payload.features,
		numberMatched,
		numberReturned: payload.features.length,
	}
}

/**
 * Every `component` reference an address carries, as the service wrote them.
 */
export function componentReferences(feature: GeoJSONFeature): readonly string[] {
	const component = feature.properties?.["component"]
	const entries = Array.isArray(component) ? component : component === undefined ? [] : [component]

	return entries
		.map((entry) =>
			typeof entry === "object" && entry !== null ? String((entry as Record<string, unknown>)["@href"] ?? "") : ""
		)
		.filter((href) => href.length > 0)
}

/**
 * The key a component reference joins on, or `null` where this reference states none.
 *
 * Two shapes appear in the services measured.
 * Slovakia writes a stored-query URL whose `id` parameter carries the feature
 * id, `…&id=AdminUnitName.15345`.
 *
 * Flanders writes an external vocabulary URI, `http://vocab.belgif.be/auth/refnis1995/1000#id`,
 * which points at a term in another register rather than at a feature of this service.
 *
 * Returning `null` for the second keeps it apart from a resolvable reference.
 * A caller that treats an unresolvable reference as a missing component would
 * record a complete address as incomplete.
 */
export function componentJoinKey(href: string): string | null {
	let url: URL

	try {
		url = new URL(href)
	} catch {
		return null
	}

	const id = url.searchParams.get("id")

	if (id) return id

	// A stored-query URL states its id as a parameter.
	// Anything else is another register's term.
	return null
}

/**
 * What a pass over one service established about its references.
 *
 * A caller reads this rather than inferring from a count of joined addresses, because an address
 * whose components live in another register is complete at the source and unjoinable here.
 */
export interface ComponentResolution {
	/**
	 * References whose key this module could read.
	 */
	resolvable: number
	/**
	 * References that point at a term in another register, with one example.
	 */
	external: number
	externalExample: string | null
}

/**
 * Counts how many of an address page's component references this module can join.
 */
export function resolveComponents(features: readonly GeoJSONFeature[]): ComponentResolution {
	let resolvable = 0
	let external = 0
	let externalExample: string | null = null

	for (const feature of features) {
		for (const href of componentReferences(feature)) {
			if (componentJoinKey(href)) {
				resolvable++

				continue
			}

			external++
			externalExample ??= href
		}
	}

	return { resolvable, external, externalExample }
}
