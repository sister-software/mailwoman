/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The entity leg: `wbgetentities` on the Wikidata API, fifty ids per request, for the ranked candidates.
 *
 * The API answers an id list in well under a second where the query service times out on a world-scale
 * class query (measured 2026-11-03: 5,171 items with no timeout against 27 of 29 per-class `GROUP BY`
 * counts failing after about 135 s each). Each entity's classes, country, coordinate, population, sitelink
 * count and the requested languages' labels and aliases are kept. The class verdict is a later phase's.
 *
 * Records are appended to a JSONL file as each request answers, and a rerun reads the ids already on
 * disk before it asks for the rest.
 */

import { APIClient } from "@mailwoman/core/api"
import { errorMessage } from "@mailwoman/core/errors/schema"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { appendLocalTextFile, toLinesText } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { formatQuantity } from "@mailwoman/core/resources/locale"
import type { LatLon } from "@mailwoman/spatial/position"
import type { PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

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
 * The languages whose labels and aliases are kept when a caller names none.
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

const WIKIDATA_API_MIN_REQUEST_INTERVAL_MS = 500
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
	error?: { code?: string; info?: string }
}

/**
 * The `wbgetentities` request for a batch of ids.
 */
export function buildEntitiesURL(ids: readonly string[], languages: readonly string[]): string {
	if (!ids.length || ids.length > WBGETENTITIES_BATCH) {
		throw new RangeError(`wbgetentities takes 1 to ${WBGETENTITIES_BATCH} ids, not ${ids.length}`)
	}

	const url = new URL(WIKIDATA_API_ENDPOINT)

	url.searchParams.set("action", "wbgetentities")
	url.searchParams.set("ids", ids.join("|"))
	url.searchParams.set("props", "labels|aliases|claims|sitelinks")
	url.searchParams.set("languages", languages.join("|"))
	url.searchParams.set("format", "json")

	return url.toString()
}

/**
 * A paced, cached and retrying client for the Wikidata API.
 */
export class WikidataAPIClient extends APIClient {
	/**
	 * Fetch a batch of entities, keyed by the id each was requested under.
	 *
	 * The API files a redirected item under its target id with a `redirects.from` field,
	 * so the answer is re-keyed by the requested id.
	 * An id the API names in neither way is an error in the answer and is refused
	 * rather than read as missing.
	 */
	public async getEntities(
		ids: readonly string[],
		languages: readonly string[] = DEFAULT_LANGUAGES
	): Promise<Map<string, WikidataEntityBody>> {
		const url = buildEntitiesURL(ids, languages)
		const response = await this.fetch<WikidataEntitiesResponse>({ url })
		const body = response.data

		if (body.error) throw new Error(`wbgetentities: ${body.error.code ?? "error"}: ${body.error.info ?? ""}`)

		if (!body.entities) throw new Error("wbgetentities: the answer has no entities field")

		const byRequestedID = new Map<string, WikidataEntityBody>()

		for (const [key, entity] of Object.entries(body.entities)) {
			byRequestedID.set(entity.redirects?.from ?? entity.id ?? key, entity)
		}

		for (const id of ids) {
			if (!byRequestedID.has(id)) throw new Error(`wbgetentities: the answer names no entity for ${id}`)
		}

		return byRequestedID
	}
}

/**
 * Whether a body has the `wbgetentities` envelope.
 */
export function isEntitiesResponse(value: unknown): value is WikidataEntitiesResponse {
	return typeof value === "object" && value !== null && typeof (value as WikidataEntitiesResponse).entities === "object"
}

/**
 * Creates a Wikidata API client with the shared pacing, retry, cache and header defaults.
 */
export function createWikidataAPIClient(options: CreateWikidataClientOptions): WikidataAPIClient {
	return new WikidataAPIClient(
		wikidataClientConfig(
			{
				displayName: "Wikidata API",
				minRequestIntervalMs: WIKIDATA_API_MIN_REQUEST_INTERVAL_MS,
				timeoutMs: WIKIDATA_API_REQUEST_TIMEOUT_MS,
				accept: "application/json",
				validate: isEntitiesResponse,
			},
			options
		)
	)
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
 * A coordinate on another globe, such as a Martian crater's, is not a place an address names.
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
	 * The number of requests between progress lines.
	 */
	reportEvery?: number
	report?: ProgressReporter
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
 * Append a record for every ranked id the entities file lacks, fifty ids per request.
 *
 * An id already on disk is not requested again.
 * A request that fails after the client's retries is reported and skipped,
 * so a rerun asks for its ids again.
 */
export async function fetchVitalEntities(
	client: Pick<WikidataAPIClient, "getEntities">,
	rows: readonly QRankRow[],
	options: FetchVitalEntitiesOptions
): Promise<FetchVitalEntitiesResult> {
	const { entitiesPath, report, reportEvery = 20 } = options
	const languages = options.languages ?? DEFAULT_LANGUAGES
	const present = new Set((await readEntityRecords(entitiesPath)).map((record) => record.qid))

	const batches = chunked(
		rows.filter((row) => !present.has(row.qid)),
		WBGETENTITIES_BATCH
	)

	const requests = batches.length
	const pending = batches.reduce((sum, batch) => sum + batch.length, 0)
	const result: FetchVitalEntitiesResult = { skipped: rows.length - pending, fetched: 0, failedBatches: [] }
	const startedAt = performance.now()
	let located = 0

	report?.(
		`  entities: ${formatQuantity(result.skipped)} of ${formatQuantity(rows.length)} already on disk, ` +
			`${formatQuantity(requests)} requests to go`
	)

	for (const [index, batch] of batches.entries()) {
		const request = index + 1

		try {
			const entities = await client.getEntities(
				batch.map((row) => row.qid),
				languages
			)

			const records = batch.map((row) => readVitalEntity(row, entities.get(row.qid)!, languages))

			await appendLocalTextFile(toLinesText(records.map((record) => stringifyJSON(record))), entitiesPath)

			result.fetched += records.length
			located += records.filter((record) => isVitalEntity(record) && record.coordinate !== null).length
		} catch (error) {
			result.failedBatches.push(batch[0]!.qid)
			report?.(`  ✗ entities: request ${request} (${batch[0]!.qid}…): ${errorMessage(error)}`)
		}

		if (request % reportEvery === 0 || request === requests) {
			report?.(
				`  entities: [${formatQuantity(request)}/${formatQuantity(requests)}] ${formatQuantity(result.fetched)} fetched, ` +
					`${formatQuantity(located)} with a coordinate, ${formatElapsed(startedAt)}`
			)
		}
	}

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
		WBGETENTITIES_BATCH
	)

	report?.(
		`  countries: ${formatQuantity(countryIDs.length)} distinct P17 items, ` +
			`${formatQuantity(countryIDs.length - Object.keys(known).length)} unknown, ${formatQuantity(batches.length)} requests`
	)

	for (const batch of batches) {
		const entities = await client.getEntities(batch, ["en"])

		for (const id of batch) {
			codes[id] = readISOAlpha2(entities.get(id)!)
		}
	}

	return codes
}
