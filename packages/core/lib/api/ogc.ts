/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Layer products share three OGC service reads.
 *   They use an API Features bbox probe and a collection's declared extent.
 *   They also use a WFS `resultType=hits` feature count.
 *   Every two-path agreement check re-asks the count through the second distribution channel.
 */

import { decodeXML } from "entities"

import type { APIClient } from "#api/APIClient"
import { rootAttribute } from "#html/document"
import { stringifyJSON } from "#json"

/**
 * The error an OGC `ServiceExceptionReport` becomes.
 *
 * The report arrives on an http 200, so no upstream layer maps it and a caller that
 * does not ask reads the exception body as an empty answer.
 */
export class OGCServiceError extends Error {
	public readonly serviceException: string

	constructor(context: string, serviceException: string) {
		super(`${context}: the service returned a ServiceExceptionReport — ${serviceException}`)

		this.name = "OGCServiceError"
		this.serviceException = serviceException
	}

	/**
	 * Did the service exceed its own query timeout?
	 *
	 * No service publishes the figure, so the message is the only signal.
	 */
	public get timedOut(): boolean {
		return /timed out/iu.test(this.serviceException)
	}
}

/**
 * The opening tag, without its terminator — the prefix `<ServiceExceptionReport …>` unhelpfully shares.
 */
const EXCEPTION_OPEN = "<ServiceException"

/**
 * The inner text of the first real `<ServiceException>` element.
 *
 * Index scans rather than a regex, because the obvious pattern backtracks polynomially
 * on a body whose opening tag has no closing partner.
 * The body comes from a network service.
 *
 * The tag name must end at the match.
 * `<ServiceExceptionReport xmlns="…">` shares the prefix.
 *
 * The entire report would become the message if the parser matched that tag.
 * An unclosed element reads as unreadable rather than as empty.
 */
function exceptionText(body: string): string | undefined {
	let cursor = 0

	for (;;) {
		const start = body.indexOf(EXCEPTION_OPEN, cursor)

		if (start === -1) return undefined

		const after = start + EXCEPTION_OPEN.length

		cursor = after

		// `>` closes a bare tag and whitespace introduces attributes.
		// Any other character continues the tag name.
		// The match then identifies `ServiceExceptionReport` or a sibling instead of the element being read.
		if (!/^[\s>]/u.test(body.slice(after, after + 1))) continue

		const contentStart = body.indexOf(">", after)

		if (contentStart === -1) return undefined

		const end = body.indexOf("</ServiceException>", contentStart)

		if (end === -1) return undefined

		return body.slice(contentStart + 1, end)
	}
}

/**
 * The `<ServiceException>` text inside an OGC exception report, or `undefined` when the body is not one.
 *
 * Split from the request so the detection is testable against captured bodies.
 * The report arrives with an XML declaration and an `xmlns` of `http://www.opengis.net/ogc`.
 */
export function readOGCServiceException(body: string): string | undefined {
	if (!body.includes("ServiceExceptionReport")) return undefined

	// A body remains an exception report when its exception element cannot be read.
	// A successful empty answer would misrepresent this exception report.
	return decodeXML((exceptionText(body) ?? "the report carried no readable ServiceException element").trim())
}

/**
 * Refuse a text body that is an OGC exception report.
 *
 * Every OGC text read a layer product makes goes through this before it parses,
 * because the report shares the http 200 a real answer arrives on.
 */
export function assertNoOGCServiceException(body: string, context: string): void {
	const exception = readOGCServiceException(body)

	if (exception !== undefined) {
		throw new OGCServiceError(context, exception)
	}
}

/**
 * Ordinates in a CRS84 bounding box: `minLon, minLat, maxLon, maxLat`.
 *
 * A shorter array is a 3D extent this reader does not understand rather than
 * a 2D one with something missing.
 */
const BBOX_ORDINATES = 4

export interface CreateOGCFeaturesBBoxReaderOptions {
	client: Pick<APIClient, "fetch">
	/**
	 * The collection root, e.g. `…/ogc/features/v1/collections/<layer>`.
	 */
	collectionURL: string
	/**
	 * Half-width of the bbox the service is asked for, in degrees.
	 */
	halfWidthDegrees: number
	/**
	 * Features per request — a ceiling rather than a page size when the probe bbox is metres wide.
	 */
	limit: number
}

/**
 * A reader answering an OGC API Features bbox query around a point.
 *
 * The service answers a bbox rather than a point, so this returns what it published nearby
 * and the containment decision belongs to the caller, against the returned rings —
 * comparing a verdict against a bare "the service returned something here" would
 * pass on any polygon within the probe's width.
 */
export function createOGCFeaturesBBoxReader<Feature>(
	options: CreateOGCFeaturesBBoxReaderOptions
): (latitude: number, longitude: number) => Promise<Feature[]> {
	return async (latitude, longitude) => {
		const { data } = await options.client.fetch<{ features?: Feature[] }>({
			method: "GET",
			url: `${options.collectionURL}/items`,
			params: {
				bbox: [
					longitude - options.halfWidthDegrees,
					latitude - options.halfWidthDegrees,
					longitude + options.halfWidthDegrees,
					latitude + options.halfWidthDegrees,
				].join(","),
				limit: options.limit,
				f: "application/json",
			},
		})

		return data.features ?? []
	}
}

/**
 * The extent an OGC API Features collection declares, in CRS84 order.
 *
 * @param options.subject Names the collection in the refusal, where the caller reads more than one.
 */
export async function readOGCCollectionBBox(
	client: Pick<APIClient, "fetch">,
	options: { collectionURL: string; context: string; subject?: string }
): Promise<[number, number, number, number]> {
	const { data } = await client.fetch<{
		extent?: { spatial?: { bbox?: number[][] } }
	}>({
		method: "GET",
		url: options.collectionURL,
		params: { f: "application/json" },
	})

	const bbox = data.extent?.spatial?.bbox?.[0]

	if (!bbox || bbox.length < BBOX_ORDINATES) {
		throw new TypeError(
			`${options.context}: the OGC collection${options.subject === undefined ? "" : ` ${options.subject}`} carried no spatial extent`
		)
	}

	return [bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!]
}

/**
 * Options shared by the two WFS count readers.
 */
export interface ReadWFSFeatureCountOptions {
	wfsURL: string
	typeNames: string
	context: string
	/**
	 * Names the layer in the refusal, where the caller reads more than one.
	 */
	subject?: string
}

/**
 * The `numberMatched` attribute a `resultType=hits` request reported, as the service spelled it.
 *
 * The root element's attribute rather than the first match anywhere in the body.
 * The count describes the collection.
 *
 * A regex cannot distinguish it from the same attribute repeated on a nested member.
 */
async function readReportedNumberMatched(
	client: Pick<APIClient, "fetch">,
	options: ReadWFSFeatureCountOptions & { startIndex?: number }
): Promise<string | undefined> {
	const { data } = await client.fetch<string>({
		method: "GET",
		url: options.wfsURL,
		responseType: "text",
		params: {
			service: "WFS",
			version: "2.0.0",
			request: "GetFeature",
			typeNames: options.typeNames,
			resultType: "hits",
			...(options.startIndex === undefined ? {} : { startIndex: String(options.startIndex), count: "1" }),
		},
	})

	assertNoOGCServiceException(data, options.context)

	return rootAttribute(data, "numberMatched", { xml: true })
}

/**
 * The feature count a WFS reports for one type.
 *
 * `resultType=hits`, which returns the count without a single geometry.
 *
 * This takes the service's word for the count.
 * A caller that cannot check the number against the publisher's own figure reads
 * {@linkcode readCheckedWFSFeatureCount} instead, which asks a second time.
 *
 * @param options.subject Names the layer in the refusal, where the caller reads more than one.
 */
export async function readWFSFeatureCount(
	client: Pick<APIClient, "fetch">,
	options: ReadWFSFeatureCountOptions
): Promise<number> {
	const numberMatched = await readReportedNumberMatched(client, options)
	const subject = options.subject === undefined ? "" : ` for ${options.subject}`

	if (numberMatched === undefined) {
		throw new Error(`${options.context}: the WFS hits response${subject} carried no numberMatched attribute`)
	}

	// WFS 2.0 permits `numberMatched="unknown"`, which is the server declining to count
	// rather than a count of zero.
	// The message must say that the attribute could not be read.
	// The value 0 would invent a count.
	if (!/^\d+$/u.test(numberMatched)) {
		throw new Error(
			`${options.context}: the WFS hits response${subject} reported numberMatched=${stringifyJSON(numberMatched)} rather than a count — the server declined to count the matches, which is not the same as matching none`
		)
	}

	return Number(numberMatched)
}

/**
 * How much a service's own feature count is worth.
 *
 * `reported` is the number the service stated, and `usable` says whether a second read agreed with it.
 * A caller records the count only where `usable` is true and records `because` otherwise,
 * so that a service which cannot count is told apart from one that counted a small number.
 */
export interface CheckedWFSFeatureCount {
	reported: number | null
	usable: boolean
	because: string
}

/**
 * Features per page in the request that checks a reported count.
 *
 * Small enough to cost one page and large enough that a service capping its own
 * count at 1 returns more features than the count admits.
 */
const COUNT_PROBE_SIZE = 10

/**
 * The feature count a WFS reports for one type, checked against a page of that type.
 *
 * Two INSPIRE Addresses services measured on 2026-09-30 answer a bare `resultType=hits`
 * request wrongly, in opposite directions, and the number alone tells a reader neither.
 *
 * Flanders (`geo.api.vlaanderen.be/ad/wfs`) answers `numberMatched="10000"` without a `startIndex`
 * and `4563062` with one, so the first request meets a per-request cap rather than counting the type.
 * This asks past index 0 for that reason.
 *
 * Poland (`mapy.geoportal.gov.pl/wss/service/INSPIRE/Addresses`) answers `numberMatched="1"`
 * at every `startIndex`, for a national address register.
 * A reader that takes the number records one address for a country.
 *
 * The tell is that a page of the same type returns more features than the count admits,
 * so this asks for one page and refuses a count that page contradicts.
 *
 * @param options.subject Names the layer in the reason, where the caller reads more than one.
 */
export async function readCheckedWFSFeatureCount(
	client: Pick<APIClient, "fetch">,
	options: ReadWFSFeatureCountOptions & { probeSize?: number }
): Promise<CheckedWFSFeatureCount> {
	const probeSize = options.probeSize ?? COUNT_PROBE_SIZE
	const numberMatched = await readReportedNumberMatched(client, { ...options, startIndex: 1 })

	if (numberMatched === undefined) {
		return { reported: null, usable: false, because: "the hits response carried no numberMatched attribute" }
	}

	if (!/^\d+$/u.test(numberMatched)) {
		// WFS 2.0 permits `unknown`, which declines to count rather than counting none.
		return {
			reported: null,
			usable: false,
			because: `the service answered numberMatched=${stringifyJSON(numberMatched)}, declining to count its matches`,
		}
	}

	const reported = Number(numberMatched)

	// A page of the same type settles whether the count describes the type or the request.
	const { data: probe } = await client.fetch<string>({
		method: "GET",
		url: options.wfsURL,
		responseType: "text",
		params: {
			service: "WFS",
			version: "2.0.0",
			request: "GetFeature",
			typeNames: options.typeNames,
			count: String(probeSize),
		},
	})

	assertNoOGCServiceException(probe, options.context)

	const returned = rootAttribute(probe, "numberReturned", { xml: true })
	const observed = returned !== undefined && /^\d+$/u.test(returned) ? Number(returned) : null

	if (observed !== null && observed > reported) {
		return {
			reported,
			usable: false,
			because: `the service reported numberMatched=${reported} and then returned ${observed} features of the same type, so the count describes its own response rather than the type`,
		}
	}

	return {
		reported,
		usable: true,
		because: `a page of ${observed ?? probeSize} features agreed with the reported count`,
	}
}
