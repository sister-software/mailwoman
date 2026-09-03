/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OGC service reads the layer products share: an API Features bbox probe, a collection's declared extent,
 *   and a WFS `resultType=hits` feature count — the second distribution channel every two-path agreement
 *   check re-asks.
 */

import { decodeXML } from "entities"

import type { APIClient } from "#api/APIClient"
import { rootAttribute } from "#html/document"

/**
 * The error an OGC `ServiceExceptionReport` becomes. The report arrives on an HTTP 200, so nothing upstream maps it: a
 * caller that does not ask reads the exception body as an empty answer.
 */
export class OGCServiceError extends Error {
	public readonly serviceException: string

	constructor(context: string, serviceException: string) {
		super(`${context}: the service returned a ServiceExceptionReport — ${serviceException}`)

		this.name = "OGCServiceError"
		this.serviceException = serviceException
	}

	/**
	 * Did the service exceed its own query timeout? No service publishes the figure, so the message is the only signal.
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
 * The inner text of the first real `<ServiceException>` element. INDEX SCANS RATHER THAN A REGEX. The obvious form —
 * `/<ServiceException(?:\s[^>]*)?>([\s\S]*?)<\/ServiceException>/` — backtracks polynomially on a body whose opening
 * tag has no closing partner, and this body is whatever a network service returned. Two more things it has to get
 * right, both of which cost nothing here: the tag name must END at the match, because `<ServiceExceptionReport
 * xmlns="…">` shares the prefix and taking it captures the entire report as the message; and an unclosed element reads
 * as unreadable rather than as empty.
 */
function exceptionText(body: string): string | undefined {
	let cursor = 0

	for (;;) {
		const start = body.indexOf(EXCEPTION_OPEN, cursor)

		if (start === -1) return undefined

		const after = start + EXCEPTION_OPEN.length

		cursor = after

		// `>` closes a bare tag; whitespace introduces attributes. Anything else continues the tag NAME, which means this
		// is `ServiceExceptionReport` or a sibling and not the element being read.
		if (!/^[\s>]/u.test(body.slice(after, after + 1))) continue

		const contentStart = body.indexOf(">", after)

		if (contentStart === -1) return undefined

		const end = body.indexOf("</ServiceException>", contentStart)

		if (end === -1) return undefined

		return body.slice(contentStart + 1, end)
	}
}

/**
 * The `<ServiceException>` text inside an OGC exception report, or `undefined` when the body is not one. Split from the
 * request so the detection is testable against captured bodies. Both shapes were taken from live services: the report
 * arrives with an XML declaration and an `xmlns` of `http://www.opengis.net/ogc`.
 */
export function readOGCServiceException(body: string): string | undefined {
	if (!body.includes("ServiceExceptionReport")) return undefined

	// A report whose exception element cannot be read is still a report, and reporting it as a successful empty answer
	// is the failure this whole function exists to prevent.
	return decodeXML((exceptionText(body) ?? "the report carried no readable ServiceException element").trim())
}

/**
 * Refuse a text body that is an OGC exception report. Every OGC text read a layer product makes goes through this
 * before it parses, because the report shares the HTTP 200 a real answer arrives on.
 */
export function assertNoOGCServiceException(body: string, context: string): void {
	const exception = readOGCServiceException(body)

	if (exception !== undefined) {
		throw new OGCServiceError(context, exception)
	}
}

/**
 * Ordinates in a CRS84 bounding box: `minLon, minLat, maxLon, maxLat`. A shorter array is a 3D extent this reader does
 * not understand, not a 2D one with something missing.
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
 * The service answers a BBOX, not a point, so this returns what it published nearby and the containment decision
 * belongs to the caller, against the returned rings — comparing a verdict against a bare "the service returned
 * something here" would pass on any polygon within the probe's width.
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
 * The feature count a WFS reports for one type — `resultType=hits`, which returns the count without a single geometry.
 *
 * @param options.subject Names the layer in the refusal, where the caller reads more than one.
 */
export async function readWFSFeatureCount(
	client: Pick<APIClient, "fetch">,
	options: { wfsURL: string; typeNames: string; context: string; subject?: string }
): Promise<number> {
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
		},
	})

	assertNoOGCServiceException(data, options.context)

	// The ROOT element's attribute, not the first match anywhere in the body: the count describes the collection,
	// and a regex cannot tell that apart from the same attribute repeated on a nested member.
	const numberMatched = rootAttribute(data, "numberMatched", { xml: true })
	const subject = options.subject === undefined ? "" : ` for ${options.subject}`

	if (numberMatched === undefined) {
		throw new Error(`${options.context}: the WFS hits response${subject} carried no numberMatched attribute`)
	}

	// WFS 2.0 permits `numberMatched="unknown"`, which is the server declining to count rather than a count of
	// zero. Reporting it as "no attribute" would name the wrong fact, and returning 0 would invent one.
	if (!/^\d+$/u.test(numberMatched)) {
		throw new Error(
			`${options.context}: the WFS hits response${subject} reported numberMatched=${JSON.stringify(numberMatched)} rather than a count — the server declined to count the matches, which is not the same as matching none`
		)
	}

	return Number(numberMatched)
}
