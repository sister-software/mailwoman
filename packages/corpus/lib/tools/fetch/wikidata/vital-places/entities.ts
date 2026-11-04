/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The entity leg: `wbgetentities` on the Wikidata API, in batches of {@linkcode DEFAULT_ENTITY_BATCH}
 * ids, for the ranked candidates.
 *
 * The API answers an id list where the query service times out on a world-scale class query
 * (measured 2026-11-03: 5,171 items with no timeout against 27 of 29 per-class `GROUP BY` counts
 * failing after about 135 s each). Each entity's classes, country, coordinate, population, sitelink
 * count and the requested languages' labels and aliases are kept. The class verdict is a later phase's.
 *
 * Records are appended to a JSONL file as each request answers, and a rerun reads the ids already on
 * disk before it asks for the rest. Entity answers therefore skip the HTTP cache: the JSONL file is the
 * resume record, and a cached answer averaged about 100 KB per entity (1.85 GB for 18,600 entities).
 *
 * The requests follow Wikimedia's published limits:
 *
 * - https://wikitech.wikimedia.org/wiki/Robot_policy, "Action API rules": "If unauthenticated, keep the
 *   concurrency of your requests to 1 at a time, and below 5 requests per second overall." "If
 *   authenticated, you can raise the concurrency to 3 overall, and the number of requests per second to
 *   10." "Avoid using expensive API endpoints: if your request takes more than 1 second to serve, please
 *   wait 5 seconds before making another request."
 * - https://www.mediawiki.org/wiki/API:Etiquette: "If your task is not interactive, i.e. a user is not
 *   waiting for the result, you should use the `maxlag` parameter." "Use GZip compression when making API
 *   calls by setting `Accept-Encoding: gzip` to reduce bandwidth usage."
 * - https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits: "limit the number of concurrent requests
 *   to 3 or fewer"; unauthenticated bot requests with a compliant User-Agent, and accounts with few
 *   edits, get 200 requests per minute.
 * - https://www.mediawiki.org/wiki/Manual:Maxlag_parameter: a lagged replica answers `maxlag` requests
 *   with status 200, an `error.code` of `maxlag`, the `lag` in seconds and a `Retry-After` header;
 *   "pause your script for at least 5 seconds before trying again".
 *
 * {@linkcode ACTION_API_LIMITS} holds the concurrency and spacing of each mode, a request that takes
 * more than {@linkcode SLOW_REQUEST_MS} to serve holds its worker for {@linkcode SLOW_REQUEST_WAIT_MS},
 * every entity request sets `maxlag=5`, and the client sends `Accept-Encoding: gzip`.
 */

import {
	APIClient,
	type APIClientConfig,
	type APIRequestConfig,
	type ClockLike,
	parseRetryAfterMs,
	RequestPacer,
	systemClock,
} from "@mailwoman/core/api"
import { errorMessage } from "@mailwoman/core/errors/schema"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { appendLocalTextFile, toLinesText } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { formatQuantity } from "@mailwoman/core/resources/locale"
import type { LatLon } from "@mailwoman/spatial/position"
import type { PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

import {
	ACTION_API_LIMITS,
	redactCredentials,
	SessionCookies,
	type WikidataBotCredentials,
	WikimediaRequestMode,
} from "#tools/fetch/wikidata/session"
import { type CreateWikidataClientOptions, wikidataClientConfig } from "#tools/fetch/wikidata/subvenue"
import { chunked, entityQID, formatElapsed, type ProgressReporter } from "#tools/fetch/wikidata/vital-places/progress"
import type { QRankRow } from "#tools/fetch/wikidata/vital-places/qrank"

/**
 * The MediaWiki API endpoint of Wikidata.
 */
export const WIKIDATA_API_ENDPOINT = "https://www.wikidata.org/w/api.php"

/**
 * The most ids one `wbgetentities` request accepts without a bot flag.
 */
export const WBGETENTITIES_BATCH = 50

/**
 * The ids one entity request asks for when a caller sets no batch size.
 *
 * Measured 2026-11-04 from the lab host, serially, with this module's `props` and ten languages:
 * 10 ids answered in 607 and 849 ms, 20 in 883 and 961 ms, and 50 in 1,455 and 1,596 ms.
 * Twenty sits within 12% of the 1 s threshold, and a request over it costs a 5 s wait.
 *
 * Twenty ids beat ten only while fewer than about one request in nine runs slow.
 */
export const DEFAULT_ENTITY_BATCH = 10

/**
 * A request that takes longer than this to serve is an expensive one under the robot policy.
 */
export const SLOW_REQUEST_MS = 1000

/**
 * How long a worker waits after an expensive request before its next one.
 */
export const SLOW_REQUEST_WAIT_MS = 5000

/**
 * The replica lag, in seconds, past which the API refuses an entity request.
 */
export const MAXLAG_SECONDS = 5

/**
 * The attempts an entity request gets while the API answers `maxlag`.
 */
const MAXLAG_ATTEMPTS = 12

const MAXLAG_MIN_WAIT_MS = 5000
const MAXLAG_MAX_WAIT_MS = 60_000

/**
 * The first wait before a retry when the answer sets no `Retry-After`.
 *
 * The rate-limit page asks for at least five seconds.
 */
const WIKIDATA_API_RETRY_BASE_DELAY_MS = 5000

/**
 * The languages whose labels and aliases are kept when a caller passes none.
 */
export const DEFAULT_LANGUAGES: readonly string[] = ["en", "fr", "es", "de", "it", "pt", "ru", "ja", "zh", "ar"]

/**
 * The item for Earth, the globe a kept coordinate must sit on.
 */
export const EARTH_QID = "Q2"

const PROPERTY = {
	instanceOf: "P31",
	country: "P17",
	coordinate: "P625",
	population: "P1082",
	isoAlpha2: "P297",
} as const

const WIKIDATA_API_REQUEST_TIMEOUT_MS = 60_000

/**
 * One ranked entity as kept from `wbgetentities`.
 */
export interface VitalEntity {
	qid: string
	qrank: number
	/**
	 * The `P31` class ids.
	 */
	classes: string[]
	/**
	 * The `P17` country item ids.
	 */
	countries: string[]
	/**
	 * The best-ranked `P625` coordinate on Earth, or `null` when the item has none.
	 */
	coordinate: LatLon | null
	/**
	 * The best-ranked `P1082` population, or `null` when the item has none.
	 */
	population: number | null
	/**
	 * The number of sitelinks, every project counted.
	 */
	sitelinks: number
	labels: Record<string, string>
	aliases: Record<string, string[]>
}

/**
 * A ranked id the API reports as missing, such as a deleted item.
 */
export interface MissingEntity {
	qid: string
	qrank: number
	missing: true
}

/**
 * One line of the entities file.
 */
export type VitalEntityRecord = VitalEntity | MissingEntity

/**
 * Whether a record is a kept entity rather than a missing one.
 */
export function isVitalEntity(record: VitalEntityRecord): record is VitalEntity {
	return !("missing" in record)
}

/**
 * The parts of a `wbgetentities` entity this module reads.
 */
export interface WikidataEntityBody {
	id?: string
	missing?: string
	redirects?: { from?: string; to?: string }
	labels?: Record<string, { value?: string }>
	aliases?: Record<string, Array<{ value?: string }>>
	claims?: Record<string, WikidataClaim[]>
	sitelinks?: Record<string, unknown>
}

/**
 * One statement as the API serializes it.
 */
export interface WikidataClaim {
	rank?: "preferred" | "normal" | "deprecated"
	mainsnak?: {
		snaktype?: string
		datavalue?: { type?: string; value?: unknown }
	}
}

/**
 * The `wbgetentities` response envelope.
 */
export interface WikidataEntitiesResponse {
	entities?: Record<string, WikidataEntityBody>
	/**
	 * An Action API error; `lag` is the replica lag in seconds on a `maxlag` error.
	 */
	error?: { code?: string; info?: string; lag?: number }
	warnings?: { result?: { "*"?: string } }
}

/**
 * Whether the API dropped entities from an answer to keep it under its response-size limit.
 */
function isTruncated(body: WikidataEntitiesResponse): boolean {
	return /truncated/iu.test(body.warnings?.result?.["*"] ?? "")
}

/**
 * Options for {@linkcode buildEntitiesURL}.
 */
export interface EntitiesURLOptions {
	/**
	 * Adds `assert=user`, so a request whose session lapsed is refused rather than served anonymously.
	 */
	assertUser?: boolean
}

/**
 * The `wbgetentities` request for a batch of ids, with `maxlag` set.
 */
export function buildEntitiesURL(
	ids: readonly string[],
	languages: readonly string[],
	options: EntitiesURLOptions = {}
): string {
	if (!ids.length || ids.length > WBGETENTITIES_BATCH) {
		throw new RangeError(`wbgetentities takes 1 to ${WBGETENTITIES_BATCH} ids, not ${ids.length}`)
	}

	const url = new URL(WIKIDATA_API_ENDPOINT)

	url.searchParams.set("action", "wbgetentities")
	url.searchParams.set("ids", ids.join("|"))
	url.searchParams.set("props", "labels|aliases|claims|sitelinks")
	url.searchParams.set("languages", languages.join("|"))
	url.searchParams.set("format", "json")
	url.searchParams.set("maxlag", String(MAXLAG_SECONDS))

	if (options.assertUser) {
		url.searchParams.set("assert", "user")
	}

	return url.toString()
}

/**
 * The Action API request for a query module, such as `meta=tokens` or `meta=userinfo`.
 */
function actionQueryURL(params: Record<string, string>): string {
	const url = new URL(WIKIDATA_API_ENDPOINT)

	url.searchParams.set("action", "query")

	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value)
	}

	url.searchParams.set("format", "json")

	return url.toString()
}

interface LoginTokenResponse {
	query?: { tokens?: { logintoken?: string } }
}

interface LoginResponse {
	login?: { result?: string; reason?: string; lgusername?: string }
	error?: { code?: string; info?: string }
}

interface UserInfoResponse {
	query?: { userinfo?: { id?: number; name?: string; anon?: string } }
}

interface SentRequest<T> {
	body: T
	headers: Record<string, unknown>
	/**
	 * The milliseconds from the request's start, after pacing, to its answer, retries included.
	 */
	servedMs: number
}

/**
 * Options for {@linkcode WikidataAPIClient.getEntities}.
 */
export interface GetEntitiesOptions {
	/**
	 * Whether the answer may come from and go to the HTTP cache.
	 *
	 * Off for the ranked entities, since the entities file already keeps them.
	 * On for the few country lookups.
	 *
	 * @defaultValue `false`
	 */
	cache?: boolean
}

/**
 * The configuration of a {@linkcode WikidataAPIClient}.
 *
 * The shared client's, with the bot credentials it logs in with.
 */
export interface WikidataAPIClientConfig extends APIClientConfig {
	credentials?: WikidataBotCredentials | null
}

/**
 * A paced and retrying client for the Wikidata API, logged in when it holds bot credentials.
 *
 * Session cookies a response sets are kept and sent on every later request.
 * Each request's serve time runs from its start, after pacing, to its answer.
 */
export class WikidataAPIClient extends APIClient<WikidataAPIClientConfig> {
	readonly #clock: ClockLike
	readonly #pacer: RequestPacer | null
	readonly #cookies = new SessionCookies()
	#dispatched = 0
	#user: string | null = null
	#login: Promise<string> | null = null

	/**
	 * The client spaces its own requests by `minRequestIntervalMs` before each one starts.
	 *
	 * The base client's adapter would pace inside the request instead.
	 * A request paced before it starts takes its serve time, with no pacing wait inside it.
	 */
	constructor(config: WikidataAPIClientConfig) {
		super({ ...config, minRequestIntervalMs: undefined })

		this.#clock = config.clock ?? systemClock
		this.#pacer = config.minRequestIntervalMs ? new RequestPacer(config.minRequestIntervalMs, this.#clock) : null

		this.axios.interceptors.request.use((requestConfig) => {
			const cookie = this.#cookies.header()

			if (cookie) {
				requestConfig.headers.set("Cookie", cookie)
			}

			return requestConfig
		})

		this.axios.interceptors.response.use((response) => {
			// A replayed answer's cookies are the ones set when it was first cached.
			if ((response as { cached?: boolean }).cached !== true) {
				this.#cookies.absorb(response.headers["set-cookie"], this.#clock.now())
			}

			return response
		})
	}

	/**
	 * The requests this client started, each counted once with its retries.
	 */
	public get requestsDispatched(): number {
		return this.#dispatched
	}

	/**
	 * One paced request, with the milliseconds it took from its start to its answer.
	 */
	async #send<T>(options: APIRequestConfig): Promise<SentRequest<T>> {
		await this.#pacer?.acquire()

		this.#dispatched++

		const startedAt = this.#clock.now()
		const response = await this.fetch<T>(options)

		return {
			body: response.data,
			headers: response.headers as Record<string, unknown>,
			servedMs: this.#clock.now() - startedAt,
		}
	}

	/**
	 * The account the client is logged in as, or `null`.
	 */
	public get loggedInAs(): string | null {
		return this.#user
	}

	/**
	 * Whether requests go out logged in.
	 */
	public get mode(): WikimediaRequestMode {
		return this.#user ? WikimediaRequestMode.loggedIn : WikimediaRequestMode.anonymous
	}

	/**
	 * Log in with the bot credentials and confirm the session through `meta=userinfo`.
	 *
	 * The steps are those of https://www.mediawiki.org/wiki/API:Login: a login token from
	 * `meta=tokens`, then `action=login` with `lgname`, `lgpassword` and `lgtoken` in a POST body.
	 * Concurrent callers share one login.
	 *
	 * @returns The account the API reports.
	 * @throws With the credential values redacted, when a step fails or the session reads as anonymous.
	 */
	public logIn(): Promise<string> {
		this.#login ??= this.#logIn().finally(() => {
			this.#login = null
		})

		return this.#login
	}

	async #logIn(): Promise<string> {
		const { credentials } = this.config

		if (!credentials) throw new Error("Wikidata login: the client holds no bot credentials")

		try {
			const tokens = await this.#send<LoginTokenResponse>({
				url: actionQueryURL({ meta: "tokens", type: "login" }),
				cache: false,
			})

			const token = tokens.body.query?.tokens?.logintoken

			if (!token) throw new Error("the meta=tokens answer has no login token")

			const form = new URLSearchParams({
				action: "login",
				lgname: credentials.username,
				lgpassword: credentials.password,
				lgtoken: token,
				format: "json",
			})

			const login = await this.#send<LoginResponse>({
				url: WIKIDATA_API_ENDPOINT,
				method: "POST",
				data: form.toString(),
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				cache: false,
			})

			const result = login.body.login

			if (result?.result !== "Success") {
				const reason = result?.reason ?? login.body.error?.info ?? "no reason given"

				throw new Error(`action=login answered ${result?.result ?? login.body.error?.code ?? "no result"}: ${reason}`)
			}

			const info = await this.#send<UserInfoResponse>({ url: actionQueryURL({ meta: "userinfo" }), cache: false })
			const user = info.body.query?.userinfo

			if (!user || "anon" in user || !user.id || !user.name) {
				throw new Error("meta=userinfo reads the session as anonymous after a successful login")
			}

			this.#user = user.name

			return user.name
		} catch (error) {
			// A fresh error without a cause: an Axios error's config holds the POST body.
			throw new Error(`Wikidata login: ${redactCredentials(errorMessage(error), credentials)}`)
		}
	}

	/**
	 * One entity request, honoring `maxlag` and the expensive-request wait.
	 *
	 * A request that took more than {@linkcode SLOW_REQUEST_MS} to serve holds its caller for
	 * {@linkcode SLOW_REQUEST_WAIT_MS} before it returns, so the caller's next request waits.
	 * A `maxlag` answer waits the larger of its `Retry-After`, its lag and five seconds, then asks again.
	 *
	 * An `assertuserfailed` answer, a lapsed session, logs in again once.
	 */
	async #requestEntities(
		ids: readonly string[],
		languages: readonly string[],
		cache: boolean
	): Promise<WikidataEntitiesResponse> {
		let loggedInAgain = false

		for (let attempt = 1; ; attempt++) {
			const url = buildEntitiesURL(ids, languages, { assertUser: this.#user !== null })

			const { body, headers, servedMs } = await this.#send<WikidataEntitiesResponse>({
				url,
				...(cache ? {} : { cache: false }),
			})

			if (servedMs > SLOW_REQUEST_MS) {
				await this.#clock.sleep(SLOW_REQUEST_WAIT_MS)
			}

			const code = body.error?.code

			if (code === "maxlag" && attempt < MAXLAG_ATTEMPTS) {
				await this.#clock.sleep(maxlagWaitMs(headers["retry-after"], body.error?.lag))

				continue
			}

			if (code === "assertuserfailed" && this.config.credentials && !loggedInAgain) {
				loggedInAgain = true
				this.#user = null
				await this.logIn()

				continue
			}

			return body
		}
	}

	/**
	 * Fetch a batch of entities, keyed by the id each was requested under.
	 *
	 * The API files a redirected item under its target id with a `redirects.from` field,
	 * so the answer is re-keyed by the requested id.
	 * An id the answer files in neither way is an error in the answer and is refused
	 * rather than read as missing.
	 */
	public async getEntities(
		ids: readonly string[],
		languages: readonly string[] = DEFAULT_LANGUAGES,
		options: GetEntitiesOptions = {}
	): Promise<Map<string, WikidataEntityBody>> {
		const body = await this.#requestEntities(ids, languages, options.cache === true)

		if (body.error) throw new Error(`wbgetentities: ${body.error.code ?? "error"}: ${body.error.info ?? ""}`)

		if (!body.entities) throw new Error("wbgetentities: the answer has no entities field")

		const byRequestedID = new Map<string, WikidataEntityBody>()

		for (const [key, entity] of Object.entries(body.entities)) {
			byRequestedID.set(entity.redirects?.from ?? entity.id ?? key, entity)
		}

		const missing = ids.filter((id) => !byRequestedID.has(id))

		if (!missing.length) return byRequestedID

		// The API drops the entities past its response-size limit and reports the
		// truncation in `warnings.result`.
		// A batch of countries exceeds it, because each country's claim list is long.
		// The dropped ids are requested again in two halves until each answer fits.
		if (!isTruncated(body) || ids.length === 1) {
			throw new Error(`wbgetentities: the answer holds no entity for ${missing[0]}`)
		}

		const half = Math.ceil(missing.length / 2)

		for (const part of [missing.slice(0, half), missing.slice(half)]) {
			if (!part.length) continue

			for (const [id, entity] of await this.getEntities(part, languages, options)) {
				byRequestedID.set(id, entity)
			}
		}

		return byRequestedID
	}
}

/**
 * The wait before asking again after a `maxlag` answer, in milliseconds.
 */
export function maxlagWaitMs(retryAfter: unknown, lagSeconds: unknown): number {
	const headerMs =
		typeof retryAfter === "string" || typeof retryAfter === "number" ? parseRetryAfterMs(String(retryAfter)) : null

	const lagMs = typeof lagSeconds === "number" && Number.isFinite(lagSeconds) ? lagSeconds * 1000 : 0

	return Math.min(Math.max(headerMs ?? 0, lagMs, MAXLAG_MIN_WAIT_MS), MAXLAG_MAX_WAIT_MS)
}

/**
 * Whether a body has the `wbgetentities` envelope.
 */
export function isEntitiesResponse(value: unknown): value is WikidataEntitiesResponse {
	return typeof value === "object" && value !== null && typeof (value as WikidataEntitiesResponse).entities === "object"
}

/**
 * Options for {@linkcode createWikidataAPIClient}.
 */
export interface CreateWikidataAPIClientOptions extends CreateWikidataClientOptions {
	/**
	 * The bot credentials to log in with; `null` or absent sends every request anonymously.
	 */
	credentials?: WikidataBotCredentials | null
}

/**
 * Creates a Wikidata API client with the shared retry, cache and header defaults, spaced for its mode.
 *
 * A client given credentials is spaced for the logged-in mode.
 * It logs in when {@linkcode WikidataAPIClient.logIn} is called.
 */
export function createWikidataAPIClient(options: CreateWikidataAPIClientOptions): WikidataAPIClient {
	const mode = options.credentials ? WikimediaRequestMode.loggedIn : WikimediaRequestMode.anonymous

	return new WikidataAPIClient({
		...wikidataClientConfig(
			{
				displayName: "Wikidata API",
				minRequestIntervalMs: ACTION_API_LIMITS[mode].minRequestIntervalMs,
				timeoutMs: WIKIDATA_API_REQUEST_TIMEOUT_MS,
				retryBaseDelayMs: WIKIDATA_API_RETRY_BASE_DELAY_MS,
				accept: "application/json",
				validate: isEntitiesResponse,
			},
			options
		),
		credentials: options.credentials ?? null,
	})
}

/**
 * The statements of one property that state a value, best rank first and deprecated ones left out.
 */
export function rankedClaims(entity: WikidataEntityBody, property: string): WikidataClaim[] {
	const order = (claim: WikidataClaim): number => (claim.rank === "preferred" ? 0 : 1)

	return (entity.claims?.[property] ?? [])
		.filter((claim) => claim.rank !== "deprecated" && claim.mainsnak?.snaktype === "value")
		.toSorted((left, right) => order(left) - order(right))
}

/**
 * The item ids a property's statements point at.
 */
export function claimItemIDs(entity: WikidataEntityBody, property: string): string[] {
	const ids: string[] = []

	for (const claim of rankedClaims(entity, property)) {
		const value = claim.mainsnak?.datavalue?.value as { id?: unknown } | undefined

		if (typeof value?.id === "string" && !ids.includes(value.id)) {
			ids.push(value.id)
		}
	}

	return ids
}

/**
 * The best-ranked coordinate on Earth, or `null`.
 *
 * A coordinate on another globe, such as a Martian crater's, is not a place an address refers to.
 */
export function readEarthCoordinate(entity: WikidataEntityBody): LatLon | null {
	for (const claim of rankedClaims(entity, PROPERTY.coordinate)) {
		const value = claim.mainsnak?.datavalue?.value as
			| { latitude?: unknown; longitude?: unknown; globe?: unknown }
			| undefined

		const globe = typeof value?.globe === "string" ? entityQID(value.globe) : EARTH_QID

		if (globe !== EARTH_QID) continue

		if (typeof value?.latitude === "number" && typeof value.longitude === "number") {
			return { lat: value.latitude, lon: value.longitude }
		}
	}

	return null
}

/**
 * The best-ranked population, or `null`.
 */
export function readPopulation(entity: WikidataEntityBody): number | null {
	for (const claim of rankedClaims(entity, PROPERTY.population)) {
		const value = claim.mainsnak?.datavalue?.value as { amount?: unknown } | undefined
		const amount = typeof value?.amount === "string" ? Number(value.amount) : Number.NaN

		if (Number.isFinite(amount)) return amount
	}

	return null
}

/**
 * The best-ranked ISO 3166-1 alpha-2 code, or `null` for an item that has none.
 */
export function readISOAlpha2(entity: WikidataEntityBody): string | null {
	for (const claim of rankedClaims(entity, PROPERTY.isoAlpha2)) {
		const value = claim.mainsnak?.datavalue?.value

		if (typeof value === "string" && /^[A-Z]{2}$/u.test(value)) return value
	}

	return null
}

/**
 * The record kept for one ranked id from the API's entity.
 */
export function readVitalEntity(
	row: QRankRow,
	entity: WikidataEntityBody,
	languages: readonly string[]
): VitalEntityRecord {
	if ("missing" in entity) return { qid: row.qid, qrank: row.qrank, missing: true }

	const labels: Record<string, string> = {}
	const aliases: Record<string, string[]> = {}

	for (const language of languages) {
		const label = entity.labels?.[language]?.value

		if (typeof label === "string" && label) {
			labels[language] = label
		}

		const names = (entity.aliases?.[language] ?? [])
			.map((alias) => alias.value)
			.filter((value): value is string => typeof value === "string" && value.length > 0)

		if (names.length) {
			aliases[language] = names
		}
	}

	return {
		qid: row.qid,
		qrank: row.qrank,
		classes: claimItemIDs(entity, PROPERTY.instanceOf),
		countries: claimItemIDs(entity, PROPERTY.country),
		coordinate: readEarthCoordinate(entity),
		population: readPopulation(entity),
		sitelinks: Object.keys(entity.sitelinks ?? {}).length,
		labels,
		aliases,
	}
}

/**
 * Every record already in the entities file, in file order.
 */
export async function readEntityRecords(path: PathBuilderLike): Promise<VitalEntityRecord[]> {
	if (!(await pathExists(path))) return []

	return JSONSpliterator.fromAsync<VitalEntityRecord>(path).toArray()
}

export interface FetchVitalEntitiesOptions {
	/**
	 * The JSONL file records are appended to.
	 */
	entitiesPath: PathBuilderLike
	languages?: readonly string[]
	/**
	 * The ids one request asks for, from 1 to {@linkcode WBGETENTITIES_BATCH}.
	 *
	 * @defaultValue {@linkcode DEFAULT_ENTITY_BATCH}
	 */
	batchSize?: number
	/**
	 * The requests in flight at once, capped by the client's mode in {@linkcode ACTION_API_LIMITS}.
	 *
	 * @defaultValue the mode's cap
	 */
	concurrency?: number
	/**
	 * The number of requests between progress lines.
	 */
	reportEvery?: number
	report?: ProgressReporter
}

/**
 * The concurrency a run uses: the one asked for, capped by the mode.
 *
 * @throws When the request is not a positive integer.
 */
export function resolveConcurrency(mode: WikimediaRequestMode, requested?: number | null): number {
	const cap = ACTION_API_LIMITS[mode].concurrency

	if (requested == null) return cap

	if (!Number.isInteger(requested) || requested < 1) {
		throw new RangeError(`a concurrency is a positive integer, not ${requested}`)
	}

	return Math.min(requested, cap)
}

export interface FetchVitalEntitiesResult {
	/**
	 * Ranked ids whose record was already on disk.
	 */
	skipped: number
	/**
	 * Records appended by this run.
	 */
	fetched: number
	/**
	 * Requests that failed after the client's retries, with the first id of each.
	 */
	failedBatches: string[]
}

/**
 * The mode a progress line reports: the account when logged in.
 */
function describeMode(client: Pick<WikidataAPIClient, "loggedInAs">): string {
	return client.loggedInAs ? `logged in as ${client.loggedInAs}` : "anonymous"
}

/**
 * Append a record for every ranked id the entities file lacks, one batch per request,
 * with up to the mode's concurrency of workers taking the remaining batches in turn.
 *
 * An id already on disk is not requested again.
 * Each worker's records are appended through one write queue, a batch's lines together,
 * so the file holds whole lines in the order the batches finished.
 *
 * A request that fails after the client's retries is reported and skipped,
 * so a rerun asks for its ids again.
 */
export async function fetchVitalEntities(
	client: Pick<WikidataAPIClient, "getEntities" | "mode" | "loggedInAs" | "requestsDispatched">,
	rows: readonly QRankRow[],
	options: FetchVitalEntitiesOptions
): Promise<FetchVitalEntitiesResult> {
	const { entitiesPath, report, reportEvery = 20, batchSize = DEFAULT_ENTITY_BATCH } = options
	const languages = options.languages ?? DEFAULT_LANGUAGES
	const concurrency = resolveConcurrency(client.mode, options.concurrency)
	const present = new Set((await readEntityRecords(entitiesPath)).map((record) => record.qid))

	if (batchSize > WBGETENTITIES_BATCH) {
		throw new RangeError(`wbgetentities takes at most ${WBGETENTITIES_BATCH} ids, not ${batchSize}`)
	}

	const batches = chunked(
		rows.filter((row) => !present.has(row.qid)),
		batchSize
	)

	const requests = batches.length
	const pending = batches.reduce((sum, batch) => sum + batch.length, 0)
	const result: FetchVitalEntitiesResult = { skipped: rows.length - pending, fetched: 0, failedBatches: [] }
	const startedAt = performance.now()
	const dispatchedAtStart = client.requestsDispatched
	let located = 0
	let next = 0
	let completed = 0
	let writes: Promise<void> = Promise.resolve()

	if (options.concurrency != null && options.concurrency > concurrency) {
		report?.(`  entities: concurrency ${options.concurrency} capped at ${concurrency} while ${client.mode}`)
	}

	report?.(
		`  entities: ${formatQuantity(result.skipped)} of ${formatQuantity(rows.length)} already on disk, ` +
			`${formatQuantity(requests)} requests to go, ${batchSize} ids each, ${describeMode(client)}, concurrency ${concurrency}`
	)

	const append = (text: string): Promise<void> => {
		writes = writes.then(() => appendLocalTextFile(text, entitiesPath))

		return writes
	}

	const worker = async (): Promise<void> => {
		while (next < batches.length) {
			const index = next++
			const batch = batches[index]!

			try {
				const entities = await client.getEntities(
					batch.map((row) => row.qid),
					languages
				)

				const records = batch.map((row) => readVitalEntity(row, entities.get(row.qid)!, languages))

				await append(toLinesText(records.map((record) => stringifyJSON(record))))

				result.fetched += records.length
				located += records.filter((record) => isVitalEntity(record) && record.coordinate !== null).length
			} catch (error) {
				// A failed append leaves the queue rejected, so the next one runs from a settled tail.
				writes = writes.catch(() => undefined)
				result.failedBatches.push(batch[0]!.qid)
				report?.(`  ✗ entities: request ${index + 1} (${batch[0]!.qid}…): ${errorMessage(error)}`)
			}

			completed++

			if (completed % reportEvery === 0 || completed === requests) {
				const seconds = (performance.now() - startedAt) / 1000
				const rate = seconds > 0 ? (client.requestsDispatched - dispatchedAtStart) / seconds : 0

				report?.(
					`  entities: [${formatQuantity(completed)}/${formatQuantity(requests)}] ${formatQuantity(result.fetched)} fetched, ` +
						`${formatQuantity(located)} with a coordinate, ${describeMode(client)}, concurrency ${concurrency}, ` +
						`${rate.toFixed(2)} requests/s, ${formatElapsed(startedAt)}`
				)
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(requests, 1)) }, worker))

	return result
}

/**
 * The ISO 3166-1 alpha-2 code of each country item, `null` where the item states none.
 *
 * Codes already known are not requested again.
 */
export async function readCountryCodes(
	client: Pick<WikidataAPIClient, "getEntities">,
	countryIDs: readonly string[],
	known: Readonly<Record<string, string | null>> = {},
	report?: ProgressReporter
): Promise<Record<string, string | null>> {
	const codes: Record<string, string | null> = { ...known }

	const batches = chunked(
		countryIDs.filter((id) => !(id in codes)),
		DEFAULT_ENTITY_BATCH
	)

	report?.(
		`  countries: ${formatQuantity(countryIDs.length)} distinct P17 items, ` +
			`${formatQuantity(countryIDs.length - Object.keys(known).length)} unknown, ${formatQuantity(batches.length)} requests`
	)

	for (const batch of batches) {
		// The few country answers stay in the HTTP cache, unlike the ranked entities.
		const entities = await client.getEntities(batch, ["en"], { cache: true })

		for (const id of batch) {
			codes[id] = readISOAlpha2(entities.get(id)!)
		}
	}

	return codes
}
