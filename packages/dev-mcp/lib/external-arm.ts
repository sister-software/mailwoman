/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Queries a running external geocoder and reads only its top result.
 *
 *   The client never starts a service and refuses shared public endpoints. A result without a coordinate
 *   counts as a miss at every distance threshold.
 */

import { APIClient, type APIClientConfig, isTransientResourceError } from "@mailwoman/core/api"
import { stringifyJSON } from "@mailwoman/core/json"
import { isRecordLike } from "@mailwoman/core/objects"
import { type GeoFeatureCollection, isPointLiteral, isValidLatitude, isValidLongitude } from "@mailwoman/spatial"

/**
 * The external geocoder engines this client supports.
 */
export const ExternalEngine = {
	Pelias: "pelias",
	Photon: "photon",
	Nominatim: "nominatim",
} as const

/**
 * One supported external engine name.
 */
export type ExternalEngine = (typeof ExternalEngine)[keyof typeof ExternalEngine]

/**
 * Shared public hosts.
 *
 * Their data vintage and rate limits are outside our control, so they cannot serve as reproducible arms.
 */
const REFUSED_ENDPOINT_HOSTS = new Set(["photon.komoot.io", "nominatim.openstreetmap.org"])

/**
 * The minimum delay between requests to one external arm, in milliseconds.
 */
export const EXTERNAL_ARM_MIN_REQUEST_INTERVAL_MS = 50

/**
 * The maximum attempts per input, including the first request.
 */
const MAX_ATTEMPTS = 3

/**
 * The base exponential retry delay in milliseconds.
 * A `Retry-After` header overrides it.
 */
const BASE_RETRY_DELAY_MS = 250

/**
 * The socket inactivity timeout for one attempt, in milliseconds.
 */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * The query sent to read the endpoint's identity.
 * Its result is not scored.
 */
const IDENTITY_PROBE_QUERY = "Paris"

const TOP_N = 1

/**
 * The top result from an external engine.
 *
 * `noResultReason` explains why a coordinate is missing.
 */
export interface ExternalAnswer {
	lat: number | null
	lon: number | null
	/**
	 * The engine's label for the result.
	 *
	 * It is shown for inspection and never compared across engines.
	 */
	label: string | null
	/**
	 * Place IDs from mailwoman results, finest first.
	 * They are compared only when both arms provide IDs.
	 */
	place_ids?: string[]
	/**
	 * The engine's type or layer for the top result.
	 * It is reported and never compared.
	 */
	resultType: string | null
	noResultReason: string | null
}

/**
 * The identity and provenance of an endpoint.
 * An unavailable field is `null`.
 */
export interface ExternalArmIdentity {
	engine: ExternalEngine
	endpoint: string
	version: string | null
	/**
	 * Where the version came from.
	 *
	 * A `caller-declared` version is the caller's claim, which the endpoint did not confirm.
	 */
	version_source: "endpoint" | "caller-declared" | null
	data_vintage: string | null
	system_scope: string | null
	interpolation_enabled: boolean | null
	response_version: string | null
	/**
	 * The outcomes of the status and search probes.
	 */
	probe: { status_path: string | null; status_http: number | null; search_ok: boolean }
	warnings: string[]
}

/**
 * The request paths and response readers for one engine.
 */
interface EngineProtocol {
	/**
	 * The health or version path, relative to the endpoint.
	 */
	statusPath: string
	searchPath: (query: string) => string
	readTop: (body: unknown) => ExternalAnswer
	readIdentity: (
		statusBody: unknown,
		searchBody: unknown
	) => Pick<ExternalArmIdentity, "version" | "data_vintage" | "response_version">
}

/**
 * Returns the value as a record, or an empty object when it is not one.
 */
function fields(value: unknown): Record<string, unknown> {
	return isRecordLike(value) ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length ? value : null
}

/**
 * Reads a coordinate from a number or a numeric string, as Nominatim returns, and checks its range.
 */
function readCoordinate(value: unknown, isValid: (candidate: number) => boolean): number | null {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN

	return isValid(parsed) ? parsed : null
}

/**
 * Reads the first GeoJSON feature.
 *
 * A top feature without a usable point counts as a miss.
 * The reader never falls back to later features.
 */
function readGeoJSONTop(body: unknown, typeKey: string): ExternalAnswer {
	const features = (body as Partial<GeoFeatureCollection<unknown, Record<string, unknown>>> | null)?.features

	if (!Array.isArray(features)) {
		return { lat: null, lon: null, label: null, resultType: null, noResultReason: "response carried no feature array" }
	}

	if (!features.length) {
		return { lat: null, lon: null, label: null, resultType: null, noResultReason: "the endpoint returned no features" }
	}

	const feature = features[0]
	const properties = fields(feature?.properties)
	const label = readString(properties["name"]) ?? readString(properties["label"])
	const resultType = readString(properties[typeKey])

	if (!isPointLiteral(feature?.geometry)) {
		return { lat: null, lon: null, label, resultType, noResultReason: "the top feature carried no point geometry" }
	}

	// GeoJSON positions are ordered longitude, latitude.
	const [lon, lat] = feature.geometry.coordinates

	if (!isValidLatitude(lat) || !isValidLongitude(lon)) {
		return { lat: null, lon: null, label, resultType, noResultReason: "the top feature's position was out of range" }
	}

	return { lat, lon, label, resultType, noResultReason: null }
}

const ENGINE_PROTOCOLS: Record<ExternalEngine, EngineProtocol> = {
	[ExternalEngine.Pelias]: {
		statusPath: "/status",
		searchPath: (query) => `/v1/search?text=${encodeURIComponent(query)}&size=${TOP_N}`,
		readTop: (body) => readGeoJSONTop(body, "layer"),
		readIdentity: (_statusBody, searchBody) => {
			const geocoding = fields(fields(searchBody)["geocoding"])

			return {
				version: readString(fields(geocoding["engine"])["version"]),
				data_vintage: null,
				response_version: readString(geocoding["version"]),
			}
		},
	},
	[ExternalEngine.Photon]: {
		statusPath: "/status",
		searchPath: (query) => `/api?q=${encodeURIComponent(query)}&limit=${TOP_N}`,
		readTop: (body) => readGeoJSONTop(body, "type"),
		readIdentity: (statusBody) => {
			const status = fields(statusBody)

			return {
				version: readString(status["version"]),
				data_vintage: readString(status["import_date"]),
				response_version: null,
			}
		},
	},
	[ExternalEngine.Nominatim]: {
		statusPath: "/status?format=json",
		searchPath: (query) => `/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=${TOP_N}`,
		readTop: (body) => {
			if (!Array.isArray(body)) {
				return { lat: null, lon: null, label: null, resultType: null, noResultReason: "response was not an array" }
			}

			if (!body.length) {
				return {
					lat: null,
					lon: null,
					label: null,
					resultType: null,
					noResultReason: "the endpoint returned no places",
				}
			}

			const top = fields(body[0])
			const lat = readCoordinate(top["lat"], isValidLatitude)
			const lon = readCoordinate(top["lon"], isValidLongitude)
			const label = readString(top["display_name"])
			const resultType = readString(top["addresstype"]) ?? readString(top["type"])

			if (lat === null || lon === null) {
				return { lat: null, lon: null, label, resultType, noResultReason: "the top place carried no readable lat/lon" }
			}

			return { lat, lon, label, resultType, noResultReason: null }
		},
		readIdentity: (statusBody) => {
			const status = fields(statusBody)

			return {
				version: readString(status["software_version"]),
				data_vintage: readString(status["data_updated"]),
				response_version: readString(status["database_version"]),
			}
		},
	},
}

/**
 * Validates an HTTP or HTTPS endpoint and returns it without a trailing slash.
 *
 * @throws For a malformed URL, another protocol or a refused public host.
 */
export function assertScorableEndpoint(endpoint: string): string {
	let url: URL

	try {
		url = new URL(endpoint)
	} catch {
		throw new Error(
			`External arm endpoint ${stringifyJSON(endpoint)} is not a URL. Pass an origin, e.g. http://127.0.0.1:4000.`
		)
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`External arm endpoint ${stringifyJSON(endpoint)} must be http or https.`)
	}

	if (REFUSED_ENDPOINT_HOSTS.has(url.hostname)) {
		throw new Error(
			`${url.hostname} is refused as a scored arm. The benchmark protocol classifies the shared community ` +
				`instances as unpinned sanity checks — unknown data vintage, rate limits nobody here controls, and no ` +
				`consent from their operators to be a benchmark subject. Point this at a local rig instead.`
		)
	}

	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

/**
 * A paced client that requests one result per query from an external geocoder.
 *
 * The client does not cache responses.
 */
export class ExternalGeocoderClient extends APIClient {
	readonly engine: ExternalEngine
	readonly endpoint: string
	readonly #protocol: EngineProtocol

	constructor(engine: ExternalEngine, endpoint: string, overrides: Partial<APIClientConfig> = {}) {
		super({
			displayName: `external:${engine}`,
			minRequestIntervalMs: EXTERNAL_ARM_MIN_REQUEST_INTERVAL_MS,
			retry: { maxAttempts: MAX_ATTEMPTS, baseDelayMs: BASE_RETRY_DELAY_MS },
			...overrides,
			axios: {
				timeout: REQUEST_TIMEOUT_MS,
				headers: { "User-Agent": "mailwoman-dev-mcp" },
				...overrides.axios,
			},
		})

		this.engine = engine
		this.endpoint = assertScorableEndpoint(endpoint)
		this.#protocol = ENGINE_PROTOCOLS[engine]
	}

	/**
	 * Returns the top result for one raw query.
	 *
	 * @throws When the endpoint stays unavailable after retries.
	 */
	async search(query: string): Promise<ExternalAnswer> {
		const response = await this.fetch<unknown>({ url: `${this.endpoint}${this.#protocol.searchPath(query)}` })

		return this.#protocol.readTop(response.data)
	}

	/**
	 * Reads the endpoint's identity from its status and search responses.
	 *
	 * Every engine here has a compatible drop-in inside this repository, so an endpoint
	 * that reports no version could be mailwoman itself.
	 * In that case the caller must pass `declaredVersion`.
	 *
	 * @throws When the search probe fails, or when neither the endpoint nor the caller supplies a version.
	 */
	async probeIdentity(declaredVersion?: string): Promise<ExternalArmIdentity> {
		let statusBody: unknown
		let statusHTTP: number | null
		let statusPath: string | null = null

		try {
			const status = await this.fetch<unknown>({ url: `${this.endpoint}${this.#protocol.statusPath}` })

			statusBody = status.data
			statusHTTP = status.status
			statusPath = this.#protocol.statusPath
		} catch (error) {
			// The status path is optional, so the search probe still runs.
			statusHTTP = readErrorStatus(error)
		}

		let searchBody: unknown

		try {
			const search = await this.fetch<unknown>({
				url: `${this.endpoint}${this.#protocol.searchPath(IDENTITY_PROBE_QUERY)}`,
			})

			searchBody = search.data
		} catch (error) {
			throw new Error(unreachableMessage(this.engine, this.endpoint, statusHTTP, error))
		}

		const read = this.#protocol.readIdentity(statusBody, searchBody)
		const warnings: string[] = []

		if (statusPath === null) {
			warnings.push(
				`GET ${this.#protocol.statusPath} did not answer (HTTP ${statusHTTP ?? "no response"}), so this endpoint's ` +
					`identity could not be observed. Every engine here has a compatible drop-in inside this repo answering ` +
					`the same paths with the same shape, so the port alone does not say what is running.`
			)
		}

		if (read.data_vintage === null) {
			warnings.push(
				"This endpoint reports no data vintage, so the index behind the numbers is undated. A coverage difference " +
					"between arms cannot be dated to a build from this result."
			)
		}

		const version = read.version ?? declaredVersion ?? null

		if (read.version === null && declaredVersion) {
			warnings.push(
				`Version ${stringifyJSON(declaredVersion)} is CALLER-DECLARED — the endpoint did not confirm it. Recorded ` +
					"as the caller's claim about what is running, not as an observation."
			)
		}

		if (version === null) {
			throw new Error(
				`External arm ${this.engine} at ${this.endpoint} will not say what it is: ` +
					`GET ${this.#protocol.statusPath} answered ${statusHTTP ?? "nothing"} and the search response carries no ` +
					`version. This repo ships a compatible drop-in for every engine here, answering these exact paths with ` +
					`this exact shape, so an unidentified endpoint may be mailwoman scored against itself. Pass \`version\` ` +
					"on the arm to record what you believe is running there; the result will mark it caller-declared."
			)
		}

		return {
			engine: this.engine,
			endpoint: this.endpoint,
			version,
			version_source: read.version === null ? "caller-declared" : "endpoint",
			data_vintage: read.data_vintage,
			// None of the supported engines reports these two fields.
			system_scope: null,
			interpolation_enabled: null,
			response_version: read.response_version,
			// A failed search probe throws above, so `search_ok` is always true here.
			probe: { status_path: statusPath, status_http: statusHTTP, search_ok: true },
			warnings,
		}
	}
}

function readErrorStatus(error: unknown): number | null {
	const status = (error as { status?: unknown }).status

	return typeof status === "number" ? status : null
}

function unreachableMessage(
	engine: ExternalEngine,
	endpoint: string,
	statusHTTP: number | null,
	error: unknown
): string {
	const reason = error instanceof Error ? error.message : String(error)
	const transient = isTransientResourceError(error)

	return (
		`External arm ${engine} at ${endpoint} did not answer its search path: ${reason}` +
		(statusHTTP === null ? "" : ` (its status path answered HTTP ${statusHTTP})`) +
		". This server does not start external services. Start the rig and retry. " +
		(transient
			? "The failure looks transport-class, so the likeliest cause is that nothing is listening on that port."
			: "The failure is not transport-class, so the port is answering but not with this engine's API — check that " +
				"the endpoint and the declared engine match.")
	)
}
