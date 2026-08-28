/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Soil Data Access — NRCS's live SQL service, and the two things this layer asks it: which survey areas
 *   exist with what version date, and which map unit covers a point.
 *
 *   THIS IS AN API REQUEST AND IT GOES THROUGH {@linkcode APIClient}. Small bodies, repeated calls, a
 *   third-party host with a server-side query timeout and no published rate limit — the pacing, bounded
 *   retry, response caching and `ResourceError` mapping are exactly what it needs. The survey-area
 *   ARCHIVES are not: they are 13 to 41 MB file transfers, they stream to disk on raw `fetch`, and
 *   `download.ts` says so in place.
 *
 *   FAILURES COME BACK AS XML, INCLUDING ON A TIMEOUT, AND A JSON-ONLY PARSER MIS-READS THEM. A bad column,
 *   a blocked query and a query that exceeded the server's own timeout all return an OGC
 *   `ServiceExceptionReport` document. Measured messages: `Invalid query: Invalid column name
 *   'nosuchcolumn'.` (HTTP 400), `Invalid query - access denied.`, and `Your query timed out.` — and the
 *   last one arrives on an HTTP 200. So every response is read as TEXT and checked for the report before
 *   anything tries to parse it as JSON. A client that branched on the status code alone would read a
 *   timeout as a successful empty answer, which is the exact shape of lie this program keeps writing down.
 *
 *   SCHEMA INTROSPECTION IS REFUSED, SO THE COLUMN NAMES ARE THE PUBLISHED DATA DICTIONARY'S.
 *   `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS` answers `Invalid query - access denied.` The
 *   columns this file names were each verified by querying them successfully.
 *
 *   FRESHNESS IS `sacatalog.saverest` AND NEVER A LENGTH PROBE. The download host answers `HEAD` with HTTP
 *   405 and IGNORES `Range` — a request with `Range: bytes=0-0` returned HTTP 200 and transferred the whole
 *   27,598,377 bytes — so "just check the size" starts a real download. The tabular service answers the
 *   freshness question directly instead, and the version date it returns is what the archive's filename
 *   embeds.
 */

import { APIClient, type APIClientConfig, type ClockLike } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"

import { saverestToISODate } from "./tabular.ts"

// Re-exported so a caller branching on this client's failures needs exactly one import.
export { isTransientResourceError } from "@mailwoman/core/api"
export { ResourceError } from "@mailwoman/core/errors"

/**
 * The tabular endpoint. Anonymous: no key, no account, and no rate-limit header on any observed response.
 */
export const SDA_POST_REST_URL = "https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest"

/**
 * Minimum spacing between Soil Data Access requests, in milliseconds.
 *
 * NRCS publishes no rate limit for this service and returned no rate-limit header on any request, so this is courtesy
 * pacing rather than a published ceiling — stated as such rather than dressed up as a measured limit. It costs an
 * acquisition run nothing: a whole-state build makes one catalogue call, and the verification's per-point calls are
 * measured at 1.8 s each anyway.
 */
export const SDA_MIN_REQUEST_INTERVAL_MS = 500

/**
 * How long a cached Soil Data Access response stays fresh.
 *
 * Twelve hours, chosen against the product's cadence rather than a wall-clock intuition: NRCS performs ONE coordinated
 * Annual Soils Refresh, on October 1. Grouping `sacatalog` by year of `saverest` returns 2016: 1, 2025: 3,323, 2026: 56
 * — 98.3% of survey areas carry a single version date from one refresh rather than a per-area drift. A shorter TTL buys
 * nothing.
 */
const SDA_CACHE_TTL_MS = 12 * 60 * 60 * 1000

/**
 * The error a `ServiceExceptionReport` becomes.
 *
 * Its own class rather than a bare `Error`, because the three failures it carries need different responses from a
 * caller: a timeout is worth narrowing the query for, an invalid column is a schema change, and access denied is a
 * query the service will never run.
 */
export class SoilDataAccessError extends Error {
	public readonly serviceException: string

	constructor(serviceException: string, query: string) {
		super(
			`soil data access: the service returned a ServiceExceptionReport — ${serviceException} (query: ${query.slice(0, 200)})`
		)

		this.name = "SoilDataAccessError"
		this.serviceException = serviceException
	}

	/**
	 * Did the service exceed its own query timeout? There is no published figure for it, so the message is the only
	 * signal — and it arrives on an HTTP 200.
	 */
	public get timedOut(): boolean {
		return /timed out/iu.test(this.serviceException)
	}
}

/**
 * The `<ServiceException>` text inside an OGC exception report, or `undefined` when the body is not one.
 *
 * Split from the request so the detection is testable against captured bodies. Both shapes below were taken from the
 * live service: the report arrives with an XML declaration and an `xmlns` of `http://www.opengis.net/ogc`.
 */
export function readServiceException(body: string): string | undefined {
	if (!body.includes("ServiceExceptionReport")) return undefined

	// The tag name must END here — `<ServiceException(\s…)?>` and not `<ServiceException[^>]*>`, because the latter also
	// matches the enclosing `<ServiceExceptionReport xmlns="…">` and then captures the whole report body as the message.
	const matched = /<ServiceException(?:\s[^>]*)?>([\s\S]*?)<\/ServiceException>/u.exec(body)

	// A report whose exception element cannot be read is still a report, and reporting it as a successful empty answer
	// is the failure this whole function exists to prevent.
	return decodeXMLEntities((matched?.[1] ?? "the report carried no readable ServiceException element").trim())
}

/**
 * The five predefined XML entities, which is all the service emits (`Invalid column name &#39;x&#39;.`).
 */
function decodeXMLEntities(value: string): string {
	return value
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&")
}

/**
 * One published survey area, as the catalogue reports it.
 */
export interface SurveyAreaCatalogEntry {
	areasymbol: string
	areaname: string
	/**
	 * The version-established date as an ISO date — what the archive's filename embeds.
	 */
	saverest: string
	saversion: number
}

/**
 * A client for Soil Data Access.
 */
export class SoilDataAccessClient extends APIClient<APIClientConfig> {
	/**
	 * Run one query and return its rows.
	 *
	 * @throws {SoilDataAccessError} When the service answers with an exception report — including on an HTTP 200, which
	 *   is what a server-side timeout does.
	 */
	public async query(sql: string): Promise<string[][]> {
		const { data } = await this.fetch<string>({
			method: "POST",
			url: SDA_POST_REST_URL,
			// TEXT, not JSON, and that is the whole trap. A JSON response type hands a failure body to a JSON parser,
			// which either throws something unrelated to what went wrong or — on a 200 — yields nothing at all.
			responseType: "text",
			headers: { "Content-Type": "application/json" },
			data: { SERVICE: "query", FORMAT: "JSON", QUERY: sql },
		})

		const exception = readServiceException(data)

		if (exception) throw new SoilDataAccessError(exception, sql)

		const parsed = parseJSONStrict<{ Table?: unknown }>(data)

		// An answer with NO rows is `{}` rather than `{"Table":[]}`, so an absent `Table` is a real empty result and not a
		// read failure — the exception check above has already separated the two.
		if (parsed.Table === undefined) return []

		if (!Array.isArray(parsed.Table)) {
			throw new TypeError(
				`soil data access: the service answered with a Table that is not an array (${typeof parsed.Table}) — the response format changed`
			)
		}

		return parsed.Table.map((row) => (row as unknown[]).map((value) => (value === null ? "" : String(value))))
	}

	/**
	 * The published survey areas whose symbol starts with `prefix` — a state code for a state-scoped build, or a whole
	 * symbol for the single-area rung.
	 *
	 * @throws {Error} When the catalogue returns nothing. An empty catalogue for a prefix a caller named is either a typo
	 *   or a service change, and building zero survey areas while reporting success is the shape this refuses.
	 */
	public async readSurveyAreaCatalog(prefix: string): Promise<SurveyAreaCatalogEntry[]> {
		const escaped = prefix.replaceAll("'", "''")

		const rows = await this.query(
			`SELECT areasymbol, areaname, saverest, saversion FROM sacatalog WHERE areasymbol LIKE '${escaped}%' ORDER BY areasymbol`
		)

		if (!rows.length) {
			throw new Error(
				`soil data access: the catalogue holds no survey area whose symbol starts with ${JSON.stringify(prefix)} — a build over an empty set would report success having written nothing`
			)
		}

		return rows.map((row) => ({
			areasymbol: row[0]!,
			areaname: row[1]!,
			saverest: saverestToISODate(row[2]!),
			saversion: Number(row[3]),
		}))
	}

	/**
	 * Which map unit the service's OWN geometry assigns at a point, or `undefined` where it assigns none.
	 *
	 * This is the second path the built artifact is checked against: same authority, different distribution channel, and
	 * geometry this package has never touched. Measured at 1.807 s per point, so a few hundred points is minutes.
	 */
	public async mukeyAtPoint(latitude: number, longitude: number): Promise<string | undefined> {
		const rows = await this.query(
			`SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${longitude} ${latitude})')`
		)

		return rows[0]?.[0] || undefined
	}
}

export interface CreateSoilDataAccessClientOptions {
	clock?: ClockLike
	cacheDirectory?: string
	minRequestIntervalMs?: number
}

/**
 * Build a {@link SoilDataAccessClient} with the disk cache and pacing this package's acquisition path expects.
 */
export function createSoilDataAccessClient(options: CreateSoilDataAccessClientOptions = {}): SoilDataAccessClient {
	return new SoilDataAccessClient({
		displayName: "SoilDataAccess",
		minRequestIntervalMs: options.minRequestIntervalMs ?? SDA_MIN_REQUEST_INTERVAL_MS,
		retry: true,
		...(options.clock ? { clock: options.clock } : {}),
		caching: {
			ttl: SDA_CACHE_TTL_MS,
			storage: buildDiskStorage({
				directory: options.cacheDirectory ?? String(dataRootPath("soil", "cache", "http")),
			}),
		},
	})
}
