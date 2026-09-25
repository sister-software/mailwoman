/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Fetches CC0 sub-venue concept labels and airport-terminal names from the Wikidata Query Service.
 * The labels are candidates that need curation before any recipe uses them as designators.
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
 * The public SPARQL endpoint of the Wikidata Query Service.
 */
export const WDQS_ENDPOINT = "https://query.wikidata.org/sparql"

/**
 * The descriptive `User-Agent` that Wikidata requires, with the tool name, URL and contact address.
 */
export const WIKIDATA_USER_AGENT =
	"mailwoman/1.0 (https://github.com/sister-software/mailwoman; teffen@sister.software) corpus-subvenue-fetch"

const WDQS_MIN_REQUEST_INTERVAL_MS = 1000

// The timeout exceeds the service's 60-second query limit so that its own error response arrives first.
const WDQS_REQUEST_TIMEOUT_MS = 90_000

const WDQS_MAX_ATTEMPTS = 3

const WDQS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A Wikidata concept whose labels are collected for one sub-venue designator.
 */
export interface SubVenueConcept {
	designatorID: string
	qid: string
	/**
	 * An English description that lets a reviewer confirm the QID.
	 */
	gloss: string
}

/**
 * The concepts whose labels and aliases the fetcher collects.
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

const TERMINAL_CLASS_QID = "Q849706"

/**
 * Builds a query for the labels and aliases of the concepts in every language.
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
 * Builds a query for the labels of instances of the class and its subclasses.
 *
 * The subclass walk returns some unrelated items, which consumers must filter.
 */
export function buildTerminalInstanceQuery(classQID: string = TERMINAL_CLASS_QID): string {
	return `SELECT ?item ?lang ?label WHERE {
  ?item wdt:P31/wdt:P279* wd:${classQID} .
  ?item rdfs:label ?label .
  BIND(LANG(?label) AS ?lang)
}`
}

/**
 * The SPARQL JSON results shape.
 */
export interface SPARQLResults {
	results: {
		bindings: Array<Record<string, { type: string; value: string; "xml:lang"?: string }>>
	}
}

/**
 * Reports whether a value has the SPARQL JSON results shape.
 */
export function isSPARQLResults(value: unknown): value is SPARQLResults {
	return typeof value === "object" && value !== null && Array.isArray((value as SPARQLResults).results?.bindings)
}

/**
 * Options for {@link createWikidataClient}.
 */
export interface CreateWikidataClientOptions {
	/**
	 * The directory of the on-disk response cache.
	 */
	cacheDir: PathBuilderLike
	/**
	 * The clock for pacing and retries, which tests can replace.
	 */
	clock?: ClockLike
	/**
	 * Axios overrides.
	 * Replacement headers must keep the required `User-Agent`.
	 */
	axios?: ConstructorParameters<typeof APIClient>[0]["axios"]
}

/**
 * A paced, cached and retrying Wikidata Query Service client.
 */
export class WikidataClient extends APIClient {
	/**
	 * Runs one SPARQL query.
	 */
	public async query(sparql: string): Promise<SPARQLResults> {
		const url = new URL(WDQS_ENDPOINT)
		url.searchParams.set("query", sparql)

		const response = await this.fetch<SPARQLResults>({ url: url.toString() })

		return response.data
	}
}

/**
 * Creates a Wikidata client with the fetcher's pacing, retry, cache and header defaults.
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
				// The validator checks the cached response body inside the envelope.
				validate: (value) => isSPARQLResults(value.data?.data),
			}),
			ttl: WDQS_CACHE_TTL_MS,
			// The configured TTL overrides the CDN cache headers.
			interpretHeader: false,
		},
		axios: {
			headers: {
				"User-Agent": WIKIDATA_USER_AGENT,
				Accept: "application/sparql-results+json",
			},
			timeout: WDQS_REQUEST_TIMEOUT_MS,
			responseType: "json",
			// Malformed or HTML error bodies throw parse errors instead of passing as JSON.
			transitional: { silentJSONParsing: false },
			...options.axios,
		},
	})
}

/**
 * Options for {@link fetchWikidataSubVenue}.
 */
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
 * Writes a response as JSON and returns its manifest entry.
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
 * Runs the label and terminal queries, saves their raw JSON, and writes a manifest.
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
