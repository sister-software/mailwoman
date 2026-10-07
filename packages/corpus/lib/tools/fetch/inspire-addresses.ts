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
 * An `ad:Address` feature holds its point, its lifecycle dates and its locator. Its street name,
 * postcode and administrative units are separate feature types that the address references through
 * `component`. A complete address therefore comes from several feature types.
 *
 * Measured on Slovakia's service, one address holds four component references that resolve to three
 * `ad:AdminUnitName` features and one `ad:PostalDescriptor`. One request per reference would cost
 * roughly four requests per address, 6.8 million for that service's 1,704,196 addresses. This module
 * therefore pages each feature type in bulk and joins locally.
 *
 * A service's feature count is read with `readCheckedWFSFeatureCount` from `@mailwoman/core/api`,
 * which owns every WFS count this repository takes.
 */

import { assertNoOGCServiceException, type APIClient } from "@mailwoman/core/api"
import { stringifyJSON, tryParsingJSON } from "@mailwoman/core/json"

import { componentJoinKey } from "#inspire/address"
import { WFS_VERSION } from "#tools/fetch/wfs-harvest"

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
 * on two services and none on the other two.
 * That reads as a service publishing no addresses rather than as a naming difference.
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
	 * A service without one is readable through its GML.
	 * This module leaves that to its caller rather than reporting it as unreadable.
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
	 * A request past the first page of such a service silently repeats page one.
	 */
	supportsPaging: boolean
	/**
	 * The `CountDefault` the service advertises, or `null` where it advertises none.
	 *
	 * The largest page the service will serve.
	 * Its own `numberMatched` reports that number when the service caps the query rather than counting it.
	 *
	 * Estonia advertises 1000000 and Poland 1000, measured 2026-10-02.
	 */
	countDefault: number | null
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
 * INSPIRE marks many attributes voidable.
 * A voidable property must be present with either a value or a void with a reason.
 *
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
export function readVoidable<T>(value: T | VoidedValue | null): T | null {
	if (value === null || isVoided(value)) return null

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
	// The other JSON-ish formats have a different envelope, so they are left out rather than tried.
	const jsonFormats = ["application/json", "application/geo+json"].filter((format) => outputFormats.includes(format))

	const countDefault = /<(?:\w+:)?Constraint\s+name="CountDefault"[\s\S]{0,240}?<(?:\w+:)?DefaultValue>\s*(\d+)\s*</iu
		.exec(data)
		?.at(1)

	return {
		outputFormats,
		jsonFormat: jsonFormats[0] ?? null,
		jsonFormats,
		countDefault: countDefault === undefined ? null : Number(countDefault),
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
	/**
	 * The `timeStamp` the service dated the page with, or `null` where it stated none.
	 *
	 * The service's own clock rather than the caller's.
	 * A manifest records it to date a page against the service that served it.
	 */
	timeStamp: string | null
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
		/**
		 * The property the service orders the results by, where it honors one.
		 *
		 * A caller that pages without an ordering assumes the service returns the same
		 * features in the same order for every request.
		 * No WFS guarantees that.
		 *
		 * Estonia honors `sortBy=gml_id` and Flanders answers HTTP 504 for its identifier,
		 * so the parameter is the caller's to supply or leave out.
		 */
		sortBy?: string | null
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
			...(options.sortBy ? { sortBy: options.sortBy } : {}),
		},
	})

	assertNoOGCServiceException(data, options.context)

	const payload = tryParsingJSON<{
		features?: GeoJSONFeature[]
		numberMatched?: unknown
		numberReturned?: unknown
		timeStamp?: unknown
	}>(data)

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
		timeStamp: typeof payload.timeStamp === "string" ? payload.timeStamp : null,
	}
}

/**
 * A void reason written as its bare term where a void object would otherwise sit.
 *
 * Estonia writes `"unpopulated"` as the value of an unused component slot.
 * The terms are the local names of the INSPIRE void-reason codelist.
 *
 * Only `unpopulated` was measured.
 * The other two are here because that codelist has three members, so a service
 * writing one of them writes one of these.
 */
const VOID_REASON_TEXT = new Set(["unpopulated", "unknown", "withheld"])

/**
 * A flattened component slot, as GeoServer writes one: `component3_xlink_href`.
 */
const FLATTENED_COMPONENT = /^component\d*_xlink_href$/iu

/**
 * Every `component` reference an address has, as the service wrote them.
 *
 * Two encodings appear across the services measured.
 * Slovakia and Flanders write a `component` array of objects carrying `@href`.
 *
 * Estonia writes one flat property per slot, `component1_xlink_href` through `component6_xlink_href`,
 * and fills an unused slot with the string `unpopulated` rather than with a void object.
 * A read of only the array reported 0 references for every Estonian address.
 * Each address has four.
 *
 * A reference may leave the service: Estonia's first three slots address its Administrative
 * Units theme at `AU_haldusyksused` rather than its Addresses theme.
 * That is a reference this module reads. {@linkcode resolveComponents} reports it as
 * unjoined against Addresses features rather than dropping it.
 */
export function componentReferences(feature: GeoJSONFeature): readonly string[] {
	const properties = feature.properties ?? {}
	const component = properties["component"]
	const entries = Array.isArray(component) ? component : component === undefined ? [] : [component]

	const fromArray = entries.map((entry) =>
		typeof entry === "object" && entry !== null ? String((entry as Record<string, unknown>)["@href"] ?? "") : ""
	)

	const fromSlots = Object.keys(properties)
		.filter((key) => FLATTENED_COMPONENT.test(key))
		.toSorted()
		.map((key) => {
			const value = properties[key]

			return typeof value === "string" ? value : ""
		})

	return [...fromArray, ...fromSlots]
		.map((href) => href.trim())
		.filter((href) => href.length > 0 && !VOID_REASON_TEXT.has(href.toLowerCase()))
}

/**
 * The key a component feature publishes for an address to reference it by.
 *
 * `identifier.value` is the INSPIRE external object identifier.
 * Flanders writes it on both sides of the join.
 *
 * `gml_id` is the fallback for a service that publishes no identifier,
 * and a stored-query reference addresses that id.
 */
export function componentIdentifier(feature: GeoJSONFeature): string | null {
	const identifier = feature.properties?.["identifier"]

	if (typeof identifier === "object" && identifier !== null) {
		const value = (identifier as Record<string, unknown>)["value"]

		if (typeof value === "string" && value.length) return value
	}

	if (typeof identifier === "string" && identifier.length) return identifier

	const gmlID = feature.properties?.["gml_id"] ?? feature.id

	return gmlID === undefined || gmlID === null ? null : String(gmlID)
}

/**
 * What a pass over one service established about its references.
 *
 * `joined` and `unjoined` are counted against the component features the caller supplied,
 * so a caller that paged part of a component type reads `unjoined` as "not among
 * the features read" rather than as "absent from the service".
 * `unjoinedExample` is there to be looked at for that reason: a reference into another register
 * and a reference past the end of a page look identical in the counts and different in the URL.
 */
export interface ComponentResolution {
	/**
	 * References whose key equals an identifier among the component features supplied.
	 */
	joined: number
	/**
	 * References whose key matched no supplied component feature, with one example.
	 */
	unjoined: number
	unjoinedExample: string | null
	/**
	 * References this module could not read a key from at all.
	 */
	unreadable: number
}

/**
 * Joins an address page's component references against the component features supplied.
 */
export function resolveComponents(
	addresses: readonly GeoJSONFeature[],
	components: readonly GeoJSONFeature[]
): ComponentResolution {
	const identifiers = new Set<string>()

	for (const feature of components) {
		const identifier = componentIdentifier(feature)

		if (identifier !== null) {
			identifiers.add(identifier)
		}
	}

	let joined = 0
	let unjoined = 0
	let unreadable = 0
	let unjoinedExample: string | null = null

	for (const address of addresses) {
		for (const href of componentReferences(address)) {
			const key = componentJoinKey(href)

			if (key === null) {
				unreadable++

				continue
			}

			if (identifiers.has(key)) {
				joined++

				continue
			}

			unjoined++
			unjoinedExample ??= href
		}
	}

	return { joined, unjoined, unjoinedExample, unreadable }
}
