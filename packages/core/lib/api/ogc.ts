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
		// The report's own element name is left out, because both the OGC 1.x `ServiceExceptionReport`
		// and the WFS 2.0 `ows:ExceptionReport` arrive here and naming one of them misreported the other.
		super(`${context}: the service returned an exception report — ${serviceException}`)

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
 * The element a WFS 2.0 service carries its message in, with an optional namespace prefix.
 *
 * OGC 1.x answers `<ServiceExceptionReport>` holding `<ServiceException>`.
 * WFS 2.0 answers `<ows:ExceptionReport>` holding `<ows:Exception exceptionCode="…">`
 * and `<ows:ExceptionText>`, so a reader that knows only the 1.x spelling passes
 * a 2.0 report through as a valid body.
 *
 * Flanders' `ad:AddressRepresentation` answers HTTP 400 with one of these on every
 * `startIndex`, and that report reached a caller as though it were a feature page.
 *
 * The prefix is optional, because a service may bind the OWS namespace as the default one.
 */
const OWS_EXCEPTION_TEXT_OPEN = /<(?:([\w.-]+):)?ExceptionText(?:\s[^>]*)?>/u

/**
 * The attribute a WFS 2.0 report states its condition in, such as `ows:exceptionCode/NoApplicableCode`.
 */
const OWS_EXCEPTION_CODE = /exceptionCode\s*=\s*"([^"]*)"/u

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
 * The text of an `ExceptionText` element, with or without a namespace prefix.
 *
 * The prefix is captured so the closing tag matches the one the document opened,
 * which keeps a prefixed element from closing on an unprefixed one.
 */
function owsExceptionText(body: string): string | undefined {
	const open = OWS_EXCEPTION_TEXT_OPEN.exec(body)

	if (!open) return undefined

	const prefix = open[1]
	const contentStart = open.index + open[0].length
	const end = body.indexOf(prefix ? `</${prefix}:ExceptionText>` : "</ExceptionText>", contentStart)

	// An unclosed element reads as unreadable rather than as empty, as the 1.x path does.
	if (end === -1) return undefined

	return body.slice(contentStart, end)
}

/**
 * The exception message inside an OGC or OWS exception report, or `undefined` for a body that is neither.
 *
 * Both dialects are read, because a report shares the HTTP status a real answer arrives on
 * and a caller that recognizes one spelling parses the other as data.
 * `ServiceExceptionReport` contains `ExceptionReport`, so one detection serves both.
 *
 * A WFS 2.0 message is prefixed with its `exceptionCode` when the report states one,
 * since `ows:exceptionCode/NoApplicableCode` and `ows:exceptionCode/InvalidParameterValue`
 * are what distinguish a malformed request from a refused one.
 *
 * Split from the request so the detection is testable against captured bodies.
 */
export function readOGCServiceException(body: string): string | undefined {
	if (!body.includes("ExceptionReport")) return undefined

	if (body.includes("ServiceExceptionReport")) {
		// A body remains an exception report when its exception element cannot be read.
		// A successful empty answer would misrepresent this exception report.
		return decodeXML((exceptionText(body) ?? "the report carried no readable ServiceException element").trim())
	}

	const message = owsExceptionText(body)
	const code = OWS_EXCEPTION_CODE.exec(body)?.[1]?.trim()
	const text = decodeXML((message ?? "the report carried no readable ExceptionText element").trim())

	return code ? `${code}: ${text}` : text
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
	 * Features per request — a ceiling rather than a page size when the probe bbox is meters wide.
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
 * Poland (`mapy.geoportal.gov.pl/wss/service/INSPIRE/Addresses`) states three different
 * numbers for one type and none of them is its count, measured 2026-10-01.
 * A bare request answers `numberMatched="1000"`, which is MapServer's default feature cap.
 *
 * The same request at `startIndex=1` answers `1`.
 * A feature page answers `numberMatched="unknown"`.
 * Its type holds 8,625,921 features.
 *
 * The tell is that a page of the same type returns more features than the count admits,
 * so this asks for one page and refuses a count that page contradicts.
 * A service answering this way is counted by paging instead: the count is the largest
 * `startIndex` that still returns a feature, which a doubling search followed by a bisection
 * finds in about 2·log2(n) requests, and a page straddling that index confirms the boundary.
 *
 * A missing `numberMatched` can also be transient.
 * Slovakia's `rageo.minv.sk/geoserver/ad/wfs` answered one request out of nine with
 * no such attribute and the other eight with `1704196`.
 *
 * This reports that response as unusable rather than inventing a count,
 * so a caller that needs the number retries, through `APIClient`'s `retry` configuration
 * or by reading the `numberMatched` a feature page carries.
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

	// A page no larger than the reported count agrees with it whatever the truth is,
	// so agreement alone does not establish that the count describes the type.
	// Asking for one feature at the reported index does: a service holding exactly that many has none there.
	//
	// Poland's address service is why this request exists.
	// It answers `numberMatched="1000"`, which is MapServer's own feature cap, and its pages cap
	// at 1,000 too, so a 10-feature probe agreed with 1,000 while the type held 8,626,951 on 2026-10-02.
	// A caller trusting that would have stored 1,000 features and recorded the type as read whole.
	const { data: beyond } = await client.fetch<string>({
		method: "GET",
		url: options.wfsURL,
		responseType: "text",
		params: {
			service: "WFS",
			version: "2.0.0",
			request: "GetFeature",
			typeNames: options.typeNames,
			count: "1",
			startIndex: String(reported),
		},
	})

	assertNoOGCServiceException(beyond, options.context)

	const beyondReturned = rootAttribute(beyond, "numberReturned", { xml: true })

	if (beyondReturned !== undefined && /^[1-9]\d*$/u.test(beyondReturned)) {
		return {
			reported,
			usable: false,
			because: `the service reported numberMatched=${reported} and then returned a feature at startIndex=${reported}, so the count is a floor rather than the type's size`,
		}
	}

	return {
		reported,
		usable: true,
		because: `a page of ${observed ?? probeSize} features agreed with the reported count, and startIndex=${reported} returned none`,
	}
}

/**
 * A feature count measured by paging, with the work it took.
 */
export interface PagedWFSFeatureCount {
	count: number
	/**
	 * Requests this measurement sent, which is the cost a caller is choosing to pay.
	 */
	requests: number
	/**
	 * Whether a page straddling the last index returned the features the count implies.
	 */
	confirmed: boolean
}

/**
 * The ceiling the doubling search refuses to pass.
 *
 * A service that answers every `startIndex` with a feature is ignoring the parameter,
 * and the search would otherwise double until it overflowed.
 * No address type reaches this size.
 */
const PAGING_COUNT_CEILING = 2 ** 34

/**
 * The feature count a type holds, measured by asking which indices hold a feature.
 *
 * For a service whose own `resultType=hits` cannot be trusted, which
 * {@linkcode readCheckedWFSFeatureCount} reports as `usable: false`.
 * What such a service still answers truthfully is whether a feature exists at a given
 * `startIndex`, so the count is the largest index that returns one, plus one.
 *
 * The search doubles upward until a request returns a page of zero features, then bisects.
 * It costs about 2·log2(n) requests: 51 for Poland's 8,625,921 features.
 *
 * A page straddling the last index then confirms the boundary.
 * `confirmed` carries that answer to the caller, because a service that caps a
 * page would make the bisection stop early.
 *
 * The measurement means something only where paging works.
 * A service that ignores `startIndex` answers every page with the first.
 *
 * A search over such a service measures its page cap.
 * This therefore refuses a service whose first two pages return the same leading feature.
 *
 * @param options.identify Reads a feature page's leading feature id, for the paging check.
 * A caller whose service writes a shape this module cannot parse supplies its own.
 */
export async function countWFSFeaturesByPaging(
	client: Pick<APIClient, "fetch">,
	options: ReadWFSFeatureCountOptions & {
		outputFormat: string
		identify?: (body: string) => string | null
	}
): Promise<PagedWFSFeatureCount> {
	let requests = 0

	const read = async (startIndex: number, count: number): Promise<{ returned: number | null; body: string }> => {
		requests++

		const { data } = await client.fetch<string>({
			method: "GET",
			url: options.wfsURL,
			responseType: "text",
			params: {
				service: "WFS",
				version: "2.0.0",
				request: "GetFeature",
				typeNames: options.typeNames,
				outputFormat: options.outputFormat,
				count: String(count),
				startIndex: String(startIndex),
			},
		})

		assertNoOGCServiceException(data, options.context)

		const returned = rootAttribute(data, "numberReturned", { xml: true })

		return { returned: returned !== undefined && /^\d+$/u.test(returned) ? Number(returned) : null, body: data }
	}

	const leading = options.identify ?? ((body: string) => /gml:id="([^"]+)"/u.exec(body)?.[1] ?? null)

	const first = await read(0, 2)

	// An empty type needs no paging check and no search, so it costs the one request already spent.
	if (first.returned === 0) return { count: 0, requests, confirmed: true }

	const second = await read(2, 2)

	if (leading(first.body) !== null && leading(first.body) === leading(second.body)) {
		throw new Error(
			`${options.context}: the service answered startIndex 0 and startIndex 2 with the same leading feature, so it is ignoring startIndex and a count measured by paging it would be this service's page cap rather than its feature count`
		)
	}

	const exists = async (index: number): Promise<boolean> => (await read(index, 1)).returned !== 0

	let low = 0
	let high = 1

	while (await exists(high)) {
		low = high
		high *= 2

		if (high > PAGING_COUNT_CEILING) {
			throw new Error(
				`${options.context}: a feature was returned at every index up to ${low}, past the ceiling this search accepts, so the service is answering any index rather than reporting its extent`
			)
		}
	}

	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2)

		if (await exists(middle)) {
			low = middle
		} else {
			high = middle
		}
	}

	const count = low + 1
	const straddleStart = Math.max(0, count - 2)
	const straddle = await read(straddleStart, 5)

	return { count, requests, confirmed: straddle.returned === count - straddleStart }
}
