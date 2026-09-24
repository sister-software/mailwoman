/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Fetch candidate sub-venue labels and airport-terminal examples from Wikidata Query Service.
 * Class labels require curation. Save the raw CC0 responses and a manifest.
 *
 *   Source : https://query.wikidata.org/sparql (the Wikidata Query Service).
 *   License: CC0. Wikidata's data is public-domain dedicated, so nothing rides on a derived recipe output.
 *            Tier A.
 *
 *   Labels and aliases suggest vocabulary; terminal instances show usage.
 *   Do not use class labels as address designators before curation.
 *
 *   `APIClient` provides pacing, caching, retries, and error mapping.
 *   Wikidata requires a descriptive `User-Agent`; see {@link WIKIDATA_USER_AGENT}.
 *
 *   Run `mailwoman corpus fetch wikidata-subvenue --out-root <path>`.
 */

import { APIClient, type ClockLike } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { prettyJSON } from "@mailwoman/core/json"
import type { PathBuilder, PathBuilderLike } from "path-ts"

import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download/index"
import { writeManifest } from "#tools/fetch/download/index"

const SLUG = "wikidata-subvenue"

/**
 * Public SPARQL endpoint; no credentials required.
 */
export const WDQS_ENDPOINT = "https://query.wikidata.org/sparql"

/**
 * Required descriptive `User-Agent`, including tool name, URL, and contact address.
 */
export const WIKIDATA_USER_AGENT =
	"mailwoman/1.0 (https://github.com/sister-software/mailwoman; teffen@sister.software) corpus-subvenue-fetch"

/**
 * Minimum interval between request dispatches.
 */
const WDQS_MIN_REQUEST_INTERVAL_MS = 1000

/**
 * Per-attempt timeout, longer than WDQS's 60-second query limit so server error responses are preserved.
 */
const WDQS_REQUEST_TIMEOUT_MS = 90_000

/**
 * Maximum attempts, including the first, for transient failures.
 */
const WDQS_MAX_ATTEMPTS = 3

/**
 * Cache lifetime; concept labels and aliases change infrequently.
 */
const WDQS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Wikidata concept whose labels are collected for one sub-venue designator.
 */
export interface SubVenueConcept {
	designatorID: string
	qid: string
	/**
	 * English description used to verify the concept.
	 */
	gloss: string
}

/**
 * Wikidata concepts queried for labels.
 */
export const SUBVENUE_CONCEPTS: readonly SubVenueConcept[] = [
	{ designatorID: "terminal", qid: "Q849706", gloss: "airport terminal — part of an airport" },
	{ designatorID: "gate", qid: "Q247739", gloss: "gate — airport facility for passenger loading/unloading" },
	{ designatorID: "concourse", qid: "Q862212", gloss: "concourse — place where pathways or roads meet" },
	{ designatorID: "campus", qid: "Q209465", gloss: "campus — cluster of buildings used by an educational institution" },
	{ designatorID: "building", qid: "Q41176", gloss: "building — structure with a roof and walls" },
	{ designatorID: "arcade", qid: "Q186637", gloss: "arcade — covered walk enclosed by a line of arches" },
	{ designatorID: "hall", qid: "Q240854", gloss: "hall — large enclosed room" },
	{ designatorID: "satellite", qid: "Q15990706", gloss: "satellite terminal — detached airport building" },
]

/**
 * Wikidata class for airport-terminal instance labels.
 */
const TERMINAL_CLASS_QID = "Q849706"

/**
 * Build a query for concept labels and aliases in all available languages.
 */
export function buildDesignatorLabelQuery(concepts: readonly SubVenueConcept[] = SUBVENUE_CONCEPTS): string {
	const values = concepts.map((c) => `wd:${c.qid}`).join(" ")

	return `SELECT ?item ?lang ?label ?kind WHERE {
  VALUES ?item { ${values} }
  { ?item rdfs:label ?label . BIND("label" AS ?kind) }
  UNION
  { ?item skos:altLabel ?label . BIND("alt" AS ?kind) }
  BIND(LANG(?label) AS ?lang)
}`
}

/**
 * Build a query for airport-terminal instances and subclasses.
 * Consumers filter unrelated results.
 */
export function buildTerminalInstanceQuery(classQID: string = TERMINAL_CLASS_QID): string {
	return `SELECT ?item ?lang ?label WHERE {
  ?item wdt:P31/wdt:P279* wd:${classQID} .
  ?item rdfs:label ?label .
  BIND(LANG(?label) AS ?lang)
}`
}

/**
 * Query response shape.
 */
export interface SPARQLResults {
	results: {
		bindings: Array<Record<string, { type: string; value: string; "xml:lang"?: string }>>
	}
}

/**
 * Check the SPARQL response shape before caching.
 */
export function isSPARQLResults(value: unknown): value is SPARQLResults {
	return typeof value === "object" && value !== null && Array.isArray((value as SPARQLResults).results?.bindings)
}

export interface CreateWikidataClientOptions {
	/**
	 * On-disk response-cache directory.
	 */
	cacheDir: PathBuilderLike
	/**
	 * Clock for pacing and retries; tests may inject a fake.
	 */
	clock?: ClockLike
	/**
	 * Axios overrides; retain the required `User-Agent` when replacing headers.
	 */
	axios?: ConstructorParameters<typeof APIClient>[0]["axios"]
}

/**
 * Paced and cached Wikidata Query Service client.
 */
export class WikidataClient extends APIClient {
	/**
	 * Run one SPARQL query.
	 */
	public async query(sparql: string): Promise<SPARQLResults> {
		const url = new URL(WDQS_ENDPOINT)
		url.searchParams.set("query", sparql)

		const response = await this.fetch<SPARQLResults>({ url: url.toString() })

		return response.data
	}
}

/**
 * Create a Wikidata client with the fetcher's defaults.
 */
export function createWikidataClient(options: CreateWikidataClientOptions): WikidataClient {
	return new WikidataClient({
		displayName: "Wikidata Query Service",
		minRequestIntervalMs: WDQS_MIN_REQUEST_INTERVAL_MS,
		retry: { maxAttempts: WDQS_MAX_ATTEMPTS },
		clock: options.clock,
		caching: {
			storage: buildDiskStorage({
				directory: options.cacheDir,
				// Validate the cached response body, not the response envelope.
				validate: (value) => isSPARQLResults(value.data?.data),
			}),
			ttl: WDQS_CACHE_TTL_MS,
			// Use the configured TTL rather than a CDN cache header.
			interpretHeader: false,
		},
		axios: {
			headers: {
				"User-Agent": WIKIDATA_USER_AGENT,
				Accept: "application/sparql-results+json",
			},
			timeout: WDQS_REQUEST_TIMEOUT_MS,
			responseType: "json",
			// Surface malformed or HTML error bodies as parse failures, not typed JSON responses.
			transitional: { silentJSONParsing: false },
			...options.axios,
		},
	})
}

export type FetchWikidataSubVenueOptions = BaseFetchOptions

interface WikidataFileEntry {
	filename: string
	query: string
	rows: number
	sha256: string
	bytes: number
}

interface WikidataManifest {
	source: string
	endpoint: string
	license: string
	user_agent: string
	downloaded_at: string
	concepts: readonly SubVenueConcept[]
	files: WikidataFileEntry[]
}

/**
 * Write a response and return its checksum and size.
 */
async function writePayload(
	destDir: PathBuilder,
	filename: string,
	query: string,
	results: SPARQLResults
): Promise<WikidataFileEntry> {
	const path = destDir(filename)
	const body = prettyJSON(results)
	await writeLocalFile(body, path)

	return {
		filename,
		query,
		rows: results.results.bindings.length,
		sha256: await sha256File(path),
		bytes: Buffer.byteLength(body),
	}
}

/**
 * Fetch both queries, save their raw JSON, and write a provenance manifest.
 */
export async function fetchWikidataSubVenue(
	options: FetchWikidataSubVenueOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = options.outRoot(SLUG)
	await makeDirectories(destDir)

	await using client = createWikidataClient({ cacheDir: destDir("http-cache") })

	const jobs: Array<{ filename: string; query: string }> = [
		{ filename: "designator-labels.json", query: buildDesignatorLabelQuery() },
		{ filename: "terminal-instance-labels.json", query: buildTerminalInstanceQuery() },
	]

	const files: WikidataFileEntry[] = []
	const failedCodes: string[] = []
	let fetched = 0
	let failed = 0

	for (const job of jobs) {
		report?.(`=== ${SLUG} / ${job.filename}`)

		try {
			const results = await client.query(job.query)
			const entry = await writePayload(destDir, job.filename, job.query, results)
			report?.(`  ${entry.rows} rows, ${entry.bytes} bytes`)
			files.push(entry)

			fetched++
		} catch (error) {
			report?.(`✗ ${job.filename}: ${error instanceof Error ? error.message : String(error)}`)
			failedCodes.push(job.filename)

			failed++
		}
	}

	const manifest: WikidataManifest = {
		source: "Wikidata Query Service",
		endpoint: WDQS_ENDPOINT,
		license: "CC0",
		user_agent: WIKIDATA_USER_AGENT,
		downloaded_at: new Date().toISOString(),
		concepts: SUBVENUE_CONCEPTS,
		files,
	}

	await writeManifest(destDir("MANIFEST.json"), manifest)

	return { fetched, skipped: 0, failed, failedCodes }
}
