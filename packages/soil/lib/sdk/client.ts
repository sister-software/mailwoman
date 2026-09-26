/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient, type APIClientConfig, type ClockLike, assertNoOGCServiceException } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

import { soilDatabasePath } from "#paths"
import { saverestToISODate } from "#sdk/tabular"

/**
 * Addresses the anonymous Soil Data Access tabular query endpoint, which needs no key or account.
 */
export const SDA_POST_REST_URL = "https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest"

/**
 * Sets the minimum spacing between Soil Data Access requests, which is courtesy pacing
 * because NRCS publishes no rate limit for the service.
 */
export const SDA_MIN_REQUEST_INTERVAL_MS = 500

const SDA_CACHE_TTL_MS = 12 * 60 * 60 * 1000

/**
 * One published survey area, as the catalogue reports it.
 */
export interface SurveyAreaCatalogEntry {
	areasymbol: string
	areaname: string

	/**
	 * The version-established date as an ISO date, which the survey area's archive file name embeds.
	 */
	saverest: string
	saversion: number
}

/**
 * A client for Soil Data Access.
 */
export class SoilDataAccessClient extends APIClient<APIClientConfig> {
	/**
	 * Runs one SQL query and returns its rows as strings, with NULL as an empty string.
	 *
	 * @throws {OGCServiceError} When the service answers with an exception report,
	 * including on an HTTP 200, which is how a server-side timeout arrives.
	 */
	public async query(sql: string): Promise<string[][]> {
		const { data } = await this.fetch<string>({
			method: "POST",
			url: SDA_POST_REST_URL,

			responseType: "text",
			headers: { "Content-Type": "application/json" },
			data: { SERVICE: "query", FORMAT: "JSON", QUERY: sql },
		})

		assertNoOGCServiceException(data, `soil data access (query: ${sql.slice(0, 200)})`)

		const parsed = parseJSONStrict<{ Table?: unknown }>(data)

		if (parsed.Table === undefined) return []

		if (!Array.isArray(parsed.Table)) {
			throw new TypeError(
				`soil data access: the service answered with a Table that is not an array (${typeof parsed.Table}) — the response format changed`
			)
		}

		return parsed.Table.map((row) => (row as unknown[]).map((value) => (value === null ? "" : String(value))))
	}

	/**
	 * Returns the published survey areas whose symbol starts with `prefix`,
	 * such as a state code or one whole area symbol.
	 *
	 * @throws {Error} When no survey area matches, because a build over an empty set
	 * would otherwise report success having written no rows.
	 */
	public async readSurveyAreaCatalog(prefix: string): Promise<SurveyAreaCatalogEntry[]> {
		const escaped = prefix.replaceAll("'", "''")

		const rows = await this.query(
			`SELECT areasymbol, areaname, saverest, saversion FROM sacatalog WHERE areasymbol LIKE '${escaped}%' ORDER BY areasymbol`
		)

		if (!rows.length) {
			throw new Error(
				`soil data access: the catalogue holds no survey area whose symbol starts with ${stringifyJSON(prefix)} — a build over an empty set would report success having written nothing`
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
	 * Returns the map unit key the service's own geometry assigns at a point,
	 * or `undefined` where it assigns none.
	 *
	 * It checks a built artifact against the same authority through a different channel
	 * and geometry this package never processed.
	 */
	public async mukeyAtPoint(latitude: number, longitude: number): Promise<string | undefined> {
		const rows = await this.query(
			`SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${longitude} ${latitude})')`
		)

		return rows[0]?.[0] || undefined
	}
}

/**
 * Overrides the clock, the HTTP cache directory and the request spacing used
 * by {@link createSoilDataAccessClient}.
 */
export interface CreateSoilDataAccessClientOptions {
	clock?: ClockLike
	cacheDirectory?: PathBuilderLike
	minRequestIntervalMs?: number
}

/**
 * Creates a {@link SoilDataAccessClient} with retries, a 12-hour disk cache and the default request pacing.
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
				directory: (options.cacheDirectory ?? soilDatabasePath("cache", "http")).toString(),
			}),
		},
	})
}
