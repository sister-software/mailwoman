/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Speaking to a geocoder this repo did not build.
 *
 *   The protocol is neither new nor negotiable. `docs/superpowers/plans/2026-08-06-local-pelias-benchmark-rig.md` §4
 *   pre-registered it before any arm had been measured, and spec §6.4 adopts it verbatim: **top-1 result only**, the
 *   **same raw query string** to every arm with no per-arm normalization, and a no-result counted as a **miss at every
 *   threshold**. Most of what this module declines to do follows from that one paragraph — no per-engine query
 *   rewriting, no reading past the first feature when it carries no coordinate, no widening `size` and picking the
 *   closest. A protocol chosen after seeing the numbers is not a protocol.
 *
 *   Three refusals it makes on its own account:
 *
 *   1. **It never starts anything.** An endpoint that is not already up is a refusal with the reason, not a run that
 *      scores every row as a miss. Spec §7's open question 7, resolved the conservative way: this surface gathers
 *      evidence and does not change state anything else reads, and "the benchmark rig was down" is a fact about the
 *      box that must reach the reader instead of arriving disguised as an arm that lost.
 *   2. **It never scores an unpinned public instance.** {@link REFUSED_ENDPOINT_HOSTS} is refused outright, because the
 *      benchmark plan classifies those two as sanity checks that are never a scored arm — and a tool that makes it
 *      easy to score them will eventually score them.
 *   3. **It never scores an arm whose identity the endpoint will not confirm** without the caller saying, in the call,
 *      what they believe is running there. This one is not decoration. Every engine here has a drop-in reimplementation
 *      inside this very repo answering the identical paths with the identical response shape, so a URL and a port are
 *      not evidence of what is behind them; `version` on the arm spec is how a caller puts their claim on the record,
 *      and the result marks it `caller-declared` rather than observed.
 */

import { APIClient, type APIClientConfig, isTransientResourceError } from "@mailwoman/core/api"
import { isRecordLike } from "@mailwoman/core/objects"
import { type GeoFeatureCollection, isPointLiteral, isValidLatitude, isValidLongitude } from "@mailwoman/spatial"

/**
 * The engines this arm can speak to. Each is a drop-in target mailwoman already ships a compatible server for, which is
 * exactly why the identity probe below exists.
 */
export const ExternalEngine = {
	Pelias: "pelias",
	Photon: "photon",
	Nominatim: "nominatim",
} as const

export type ExternalEngine = (typeof ExternalEngine)[keyof typeof ExternalEngine]

/**
 * Hosts that may never be a scored arm, whatever the caller asks for.
 *
 * The benchmark plan names both as **unpinned sanity checks**: they are shared community instances on unknown data
 * vintages under rate limits nobody here controls, so a number measured against one is not reproducible and its
 * operators did not consent to being a benchmark subject. Refused rather than warned — a warning on the cheapest thing
 * to type is a warning that gets typed.
 */
const REFUSED_ENDPOINT_HOSTS = new Set(["photon.komoot.io", "nominatim.openstreetmap.org"])

/**
 * Minimum spacing between two dispatches to an external arm, in milliseconds.
 *
 * A JUDGEMENT, not a measurement, and stated as one: these endpoints are self-hosted, so no upstream publishes a rate
 * for them and there is no limit to honour. What the interval buys is that a 400-row loop cannot saturate a service
 * sharing this box's memory bandwidth with the resident gazetteer — 20 dispatches per second is far above what a
 * sequential comparison reaches anyway, so it costs a well-behaved run nothing and bounds a pathological one.
 *
 * Set through `minRequestIntervalMs` rather than `requestsPerMinute` deliberately: AGENTS.md records that the budget
 * budget alone does not deliver N requests per minute (measured at 100/min for `requestsPerMinute: 10`), and the
 * interval limit is the one that actually holds a rate.
 */
export const EXTERNAL_ARM_MIN_REQUEST_INTERVAL_MS = 50

/**
 * Total attempts, including the first, before one row's query is recorded as a failure.
 *
 * Three, matching the pre-registered rig's own scorer, so a row that fails here would have failed there.
 */
const MAX_ATTEMPTS = 3

/**
 * Base delay for the retry backoff, in milliseconds. Attempt n waits `BASE_RETRY_DELAY_MS * 2^(n-1)` unless the
 * response carried a `Retry-After`, which wins.
 */
const BASE_RETRY_DELAY_MS = 250

/**
 * Per-attempt socket-inactivity timeout for one geocode query, in milliseconds. Matches the rig scorer's 20 s, which is
 * generous for a loopback service and is really a bound on "the process is up but wedged".
 */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * The query the identity probe sends. Never scored, and never mixed with the input set — its only job is to make the
 * search path answer once so the response envelope can be read for a version. A short, unambiguous, universally-indexed
 * place name, so an endpoint holding any data at all responds to it.
 */
const IDENTITY_PROBE_QUERY = "Paris"

/**
 * How many results to ask for. One, always: the protocol scores top-1, and asking for more invites a later reader to
 * quietly pick a better one.
 */
const TOP_N = 1

/**
 * What one arm answered for one input.
 *
 * `noResultReason` is the whole point of the shape. A geocoder that returns an empty array has said something specific
 * — it does not hold this address — and that is not the same fact as a query that failed, nor a score of zero. Both
 * still count as a miss at every threshold under the pre-registered protocol, but the result reports which happened.
 */
export interface ExternalAnswer {
	lat: number | null
	lon: number | null
	/**
	 * The engine's own label for what it matched, verbatim. Not compared across engines — it is here so a human reading a
	 * changed row can see that one arm answered with a country and the other with a rooftop.
	 */
	label: string | null
	/**
	 * The answer's place-identity chain (mailwoman arms only — the resolved hierarchy's placeIDs, finest first). A
	 * coordinate diff is blind to a wrong-INSTANCE win under a nearly-right coordinate (the Astoria class: the correct
	 * Queens point under the Oregon placeID), and the 2026-08-18 band-injection battery needed a hand-written probe for
	 * exactly this. ABSENT when the arm cannot state identity — external engines, oracles, and runs recorded before this
	 * field existed — and an identity comparison only runs when BOTH sides carry one.
	 */
	place_ids?: string[]
	/**
	 * The engine's own type/layer for the top result (Pelias `layer`, Photon `type`, Nominatim `addresstype`). Reported,
	 * never thresholded: these vocabularies are not the same vocabulary.
	 */
	resultType: string | null
	noResultReason: string | null
}

/**
 * What an endpoint says about itself, with `null` everywhere it says nothing.
 *
 * The columns are the ones the benchmark plan's §7 already specifies for a scored arm. Reporting them as `null` rather
 * than omitting them is the meaning-of-zero rule applied to provenance: "this endpoint does not expose its data
 * vintage" is a fact a reader needs, and a missing key reads as nobody having looked.
 */
export interface ExternalArmIdentity {
	engine: ExternalEngine
	endpoint: string
	version: string | null
	/**
	 * Where {@link ExternalArmIdentity.version} came from. `caller-declared` means the endpoint would not confirm it and
	 * the caller asserted it — a claim on the record, not an observation.
	 */
	version_source: "endpoint" | "caller-declared" | null
	data_vintage: string | null
	system_scope: string | null
	interpolation_enabled: boolean | null
	response_version: string | null
	/**
	 * Which path answered the reachability probe, and what the search path said. Present so a failure to identify the arm
	 * can be read rather than guessed at.
	 */
	probe: { status_path: string | null; status_http: number | null; search_ok: boolean }
	warnings: string[]
}

/**
 * Per-engine wire protocol. One record per engine rather than a switch at each call site, so adding an engine is a
 * table entry and cannot half-land.
 */
interface EngineProtocol {
	/**
	 * The engine's own health/version path, relative to the endpoint root.
	 */
	statusPath: string
	searchPath: (query: string) => string
	readTop: (body: unknown) => ExternalAnswer
	/**
	 * Identity fields, read from the status body and the identity probe's search body.
	 */
	readIdentity: (
		statusBody: unknown,
		searchBody: unknown
	) => Pick<ExternalArmIdentity, "version" | "data_vintage" | "response_version">
}

/**
 * Index into an unknown JSON body.
 *
 * `isRecordLike` (`@mailwoman/core/objects`) is the shared predicate and does the actual test; this only adapts its
 * `input is object` narrowing into something indexable, and answers `{}` for a non-record so a reader can chain without
 * a guard at every step.
 */
function fields(value: unknown): Record<string, unknown> {
	return isRecordLike(value) ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length ? value : null
}

/**
 * A coordinate from either a JSON number or the decimal STRING Nominatim answers with, range-checked by
 * `@mailwoman/spatial`'s own bounds.
 *
 * Two traps, both closed by the validator rather than by a finiteness test. `Number("")` is 0, so an empty string would
 * otherwise become a point in the Gulf of Guinea; and a latitude past ±90 is what a transposed pair looks like, which a
 * finite-number check waves through and a distance metric then reports as an ordinary miss.
 */
function readCoordinate(value: unknown, isValid: (candidate: number) => boolean): number | null {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN

	return isValid(parsed) ? parsed : null
}

/**
 * Top-1 out of a GeoJSON FeatureCollection — the shape Pelias and Photon share.
 *
 * Typed and validated through `@mailwoman/spatial` (`GeoFeatureCollection`, `isPointLiteral`) rather than through
 * either drop-in's own schema. `@mailwoman/photon` and `@mailwoman/nominatim` do define the response shapes, and
 * reusing one here would have been the obvious economy — but this client exists to measure an upstream engine, and
 * parsing its answer through our reimplementation's idea of the format would make it blind to exactly the divergences
 * the comparison is for. RFC 7946 is shared ground; a drop-in's schema is a claim under test.
 *
 * A feature whose geometry is not a point is a no-result WITH a reason, not a skip to the second feature: the protocol
 * scores position one, and an engine that answered with an unplaceable feature has said something different from an
 * engine that answered with nothing.
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

	// GeoJSON orders a position [lon, lat]. Reading it the other way round is the classic silent failure: it lands
	// every result in the wrong hemisphere and still produces a plausible distance for anything near the equator.
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
 * Validate an endpoint and strip it to an origin plus path prefix.
 *
 * @throws When the URL is unparseable, is not HTTP(S), or names a host that may never be scored.
 */
export function assertScorableEndpoint(endpoint: string): string {
	let url: URL

	try {
		url = new URL(endpoint)
	} catch {
		throw new Error(
			`External arm endpoint ${JSON.stringify(endpoint)} is not a URL. Pass an origin, e.g. http://127.0.0.1:4000.`
		)
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`External arm endpoint ${JSON.stringify(endpoint)} must be http or https.`)
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
 * One external geocoder, paced and bounded-retried, answering the pre-registered protocol and nothing else.
 *
 * Response caching is deliberately OFF. Every other client in this repo caches because it is re-reading a slow remote
 * index; here the endpoint's answer IS the measurement, and a cached one would be scored against an identity probe
 * taken now — reporting a vintage the number did not come from.
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
				// Nominatim's usage policy requires a caller to identify itself, and a local rig inherits the upstream
				// default configuration that enforces it. Sent to all three: no engine minds being told who is asking.
				headers: { "User-Agent": "mailwoman-dev-mcp" },
				...overrides.axios,
			},
		})

		this.engine = engine
		this.endpoint = assertScorableEndpoint(endpoint)
		this.#protocol = ENGINE_PROTOCOLS[engine]
	}

	/**
	 * Top-1 for one raw query string.
	 *
	 * @throws On a transport or HTTP failure that survived the retry ceiling. Throwing rather than returning a no-result
	 *   is what lets the caller separate "this endpoint does not hold this address" from "this endpoint is gone" — the
	 *   second must not be able to accumulate silently into a row of misses.
	 */
	async search(query: string): Promise<ExternalAnswer> {
		const response = await this.fetch<unknown>({ url: `${this.endpoint}${this.#protocol.searchPath(query)}` })

		return this.#protocol.readTop(response.data)
	}

	/**
	 * Ask the endpoint what it is, without scoring anything.
	 *
	 * Two requests: the engine's own status path, then one throwaway search. Both are needed. The status path is where
	 * Nominatim keeps its data vintage and upstream Photon its import date; the search envelope is where Pelias keeps its
	 * version. An endpoint that 404s the status path is not thereby broken — a compatible drop-in need not implement it —
	 * but it is thereby unidentified, which the caller is told rather than left to assume.
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
			// A status path that answers 404 is a fact about the implementation, not about reachability, so the probe
			// continues to the search path. Only a transport-class failure means "not up", and the search attempt below
			// is what settles that.
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
				`Version ${JSON.stringify(declaredVersion)} is CALLER-DECLARED — the endpoint did not confirm it. Recorded ` +
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
			// Neither is exposed by any of these APIs. Carried as explicit nulls because the benchmark plan's §7 names
			// them as arm columns, and an absent key reads as unexamined rather than as unavailable.
			system_scope: null,
			interpolation_enabled: null,
			response_version: read.response_version,
			// Always true by the time this is reached: a search path that did not answer threw above, because a search
			// path that does not answer is the definition of an arm that cannot be scored.
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
		". This server does not start or stop external services — it gathers evidence and changes nothing another " +
		"process reads. Bring the rig up yourself and re-run. " +
		(transient
			? "The failure looks transport-class, so the likeliest cause is that nothing is listening on that port."
			: "The failure is not transport-class, so the port is answering but not with this engine's API — check that " +
				"the endpoint and the declared engine match.")
	)
}
