/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the multilingual sub-venue designator vocabulary from Wikidata (#35 wave 1).
 *
 *   Source : https://query.wikidata.org/sparql (the Wikidata Query Service).
 *   License: CC0. Wikidata's data is public-domain dedicated, so nothing rides on a derived shard.
 *            Tier A.
 *
 *   ## The pull is CLASS labels, not instance names — and that inversion is the whole design
 *
 *   The obvious read of "Wikidata for localized designators" is: fetch every airport terminal entity
 *   and read its name in each language. That was tried first and it is the WRONG query. Wikidata
 *   knows 246 items that are `instance of / subclass of*` airport terminal, carrying 775 labels
 *   between them (measured 2026-08-04), and most of those labels are proper names that translate
 *   verbatim — `TWA Flight Center` is spelled `TWA Flight Center` in fifteen languages. The
 *   instance layer is thin and its localization is mostly a no-op.
 *
 *   The DESIGNATOR is the label of the CLASS. `wd:Q849706` ("airport terminal") is labelled `Terminal`
 *   in German, `terminal aéroportuaire` in French, `ターミナルビル` in Japanese, `航站楼` in Chinese —
 *   and `skos:altLabel` adds the aliases (`Abfertigungsgebäude`, `Flughafenterminal`, `aerostazione`).
 *   Eight concept ids yield 877 label+alias rows across 174 languages, which is the vocabulary the
 *   corpus task asked for and the instance query does not contain. {@link SUBVENUE_CONCEPTS} is that
 *   list of ids; {@link buildDesignatorLabelQuery} is that query.
 *
 *   Instance labels are fetched too ({@link buildTerminalInstanceQuery}), for a different job: they
 *   are ATTESTED USAGE — evidence of how a designator combines with a modifier or an identifier in
 *   running text. 775 rows is small, and it is a validation set, not a vocabulary.
 *
 *   ## What a caller must NOT do with the output
 *
 *   A class label is a CONCEPT NAME, not a designator as written in an address. Q849706's Spanish
 *   label is `terminal aeroportuaria` and its French is `terminal d'aéroport`; nobody writes either on
 *   an envelope, they write `Terminal`. Q247739's Spanish is `puerta de embarque` where the addressed
 *   form is `Puerta`. So this fetch produces CANDIDATE SURFACES that need a head-noun/curation pass
 *   before any of them reaches `neural/venue-structure.ts`'s designator vocabulary — the lexicon
 *   builder marks every one `curated: false` and the burden of promotion is on a human. Wiring the raw
 *   pull straight into the span proposer would admit multi-word phrases that match nothing and, worse,
 *   admit `hall` in a language where it names an ordinary room.
 *
 *   ## Why `APIClient` here when the OurAirports sibling uses `downloadToFile`
 *
 *   This is the API-request side of `AGENTS.md`'s split: small JSON bodies, several calls per run, and
 *   a host that publishes a rate policy and enforces it with 429s. Pacing, bounded `Retry-After`-aware
 *   retry, response caching and `ResourceError` mapping all earn their keep, so it extends
 *   {@link APIClient}. `ourairports.ts` is four static file transfers off a CDN and correctly does not.
 *
 *   WDQS also REQUIRES a descriptive `User-Agent` naming the tool and a contact — an anonymous or
 *   library-default agent is blocked outright by the Wikimedia user-agent policy. See
 *   {@link WIKIDATA_USER_AGENT}.
 *
 *   Invoke via `mailwoman corpus fetch wikidata-subvenue --out-root <path>`.
 */

import { mkdirSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { APIClient, type ClockLike } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { sha256File } from "@mailwoman/core/utils"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { writeManifest } from "./download.ts"

const SLUG = "wikidata-subvenue"

/**
 * The SPARQL endpoint. Public, no credential.
 */
export const WDQS_ENDPOINT = "https://query.wikidata.org/sparql"

/**
 * The `User-Agent` every request carries.
 *
 * NOT decoration. The Wikimedia user-agent policy blocks requests whose agent is absent, generic, or a library default,
 * and WDQS enforces it — an unidentified client gets a 403 that no amount of retrying fixes. The policy asks for a tool
 * name, a URL, and a contact address, all three of which are here.
 */
export const WIKIDATA_USER_AGENT =
	"mailwoman/1.0 (https://github.com/sister-software/mailwoman; teffen@sister.software) corpus-subvenue-fetch"

/**
 * Minimum spacing between dispatches, in milliseconds.
 *
 * WDQS's published limit is expressed as processing-time budget rather than a request rate, and this run issues fewer
 * than a dozen queries total, so the number is chosen for politeness rather than to sit against a ceiling: one query
 * per second is far inside anything WDQS objects to, and at this volume the whole fetch still completes in seconds.
 *
 * Set as `minRequestIntervalMs` rather than `requestsPerMinute` deliberately — `AGENTS.md` records that
 * `requestsPerMinute` is a BUDGET model whose cooldown lets N requests go out back to back, so it does not deliver N
 * per minute and is not the gate that holds a rate. The interval is.
 */
const WDQS_MIN_REQUEST_INTERVAL_MS = 1000

/**
 * Per-attempt socket-inactivity timeout. WDQS's own query timeout is 60 seconds and it answers with a 500 when a query
 * exceeds it, so a client timeout below that would turn a server-side timeout into a client-side one and lose the error
 * body that says which query was too expensive.
 */
const WDQS_REQUEST_TIMEOUT_MS = 90_000

/**
 * Total attempts (including the first) before giving up on a 429/5xx.
 */
const WDQS_MAX_ATTEMPTS = 3

/**
 * How long a cached SPARQL response stays fresh. A week: the class labels this pulls change on the timescale at which
 * someone edits a Wikidata concept's German alias, which is to say rarely, and a re-run inside a working session should
 * not re-ask.
 */
const WDQS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * One Wikidata concept whose labels are a designator's multilingual surface set.
 *
 * `designatorID` is the mailwoman-side vocabulary term, matching `neural/venue-structure.ts`'s
 * `VENUE_STRUCTURE_DESIGNATORS` wherever the two overlap. `qid` was resolved by `wbsearchentities` and hand-checked
 * against the entity's English description (recorded below) on 2026-08-04 — a QID picked by search alone is how you end
 * up pulling the labels of a Bronx neighbourhood called Concourse.
 *
 * `wing` is ABSENT and that is a finding, not an oversight: Wikidata has no clean concept for "wing of a building".
 * `wbsearchentities` for "wing" returns a surname, two English villages, a rugby position and a drone company. Since
 * `wing` is the single most valuable designator in the arc — `West Wing` is the one modifier case that already parses,
 * and `East Wing` is the one that does not — its localized surfaces have to come from somewhere else. See the wave-1
 * report.
 */
export interface SubVenueConcept {
	designatorID: string
	qid: string
	/**
	 * The entity's English description, recorded so a future reader can tell at a glance whether the QID still names what
	 * we think it names.
	 */
	gloss: string
}

/**
 * The concept table. Eight ids, each verified against its English description on 2026-08-04.
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
 * The class whose instances are fetched for attested-usage evidence: airport terminal.
 */
const TERMINAL_CLASS_QID = "Q849706"

/**
 * Build the class-label query: `rdfs:label` and `skos:altLabel` for every concept, in every language, tagged with which
 * of the two it came from so the lexicon can rank a label above an alias.
 *
 * `VALUES` rather than a property path over the whole class tree — the concept list is closed and hand-verified, and a
 * `wdt:P279*` walk from `building` would drag in every structure type on earth.
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
 * Build the instance-label query — every item that is an `instance of` (through any `subclass of` chain) an airport
 * terminal, with all of its labels. Measured at 246 items / 775 labels on 2026-08-04, well inside WDQS's 60-second
 * budget.
 *
 * A caveat worth knowing before trusting a row: Wikidata's P31 on these is not clean. `Q1322696` (Kigali International
 * Airport) is typed as an airport terminal, so the result set mixes AIRPORTS in with terminals. The consumer filters;
 * this module fetches what the query returns.
 */
export function buildTerminalInstanceQuery(classQID: string = TERMINAL_CLASS_QID): string {
	return `SELECT ?item ?lang ?label WHERE {
  ?item wdt:P31/wdt:P279* wd:${classQID} .
  ?item rdfs:label ?label .
  BIND(LANG(?label) AS ?lang)
}`
}

/**
 * The SPARQL JSON results shape, narrowed to the two column types these queries produce.
 */
export interface SPARQLResults {
	results: {
		bindings: Array<Record<string, { type: string; value: string; "xml:lang"?: string }>>
	}
}

/**
 * Whether a decoded body is a SPARQL results envelope. Used as the cache's write validator so an HTML error page served
 * under a 200 is never persisted for the next run to destructure into `undefined`.
 */
export function isSPARQLResults(value: unknown): value is SPARQLResults {
	return typeof value === "object" && value !== null && Array.isArray((value as SPARQLResults).results?.bindings)
}

export interface CreateWikidataClientOptions {
	/**
	 * On-disk response-cache root. Defaults to a `http-cache` directory beside the fetch output.
	 */
	cacheDir: string
	/**
	 * Time source powering the pacer and the retry backoff. Defaults to the system clock; tests inject a fake so no suite
	 * ever sleeps a real second.
	 */
	clock?: ClockLike
	/**
	 * Axios overrides, merged over this client's defaults. THE TEST SEAM — pass an `adapter` and no live call is made.
	 * Overriding `headers` wholesale would drop the required `User-Agent`, so don't.
	 */
	axios?: ConstructorParameters<typeof APIClient>[0]["axios"]
}

/**
 * A Wikidata Query Service client: paced, retrying, disk-cached, and correctly identified.
 */
export class WikidataClient extends APIClient {
	/**
	 * Run one SPARQL query and return its results envelope.
	 */
	public async query(sparql: string): Promise<SPARQLResults> {
		const url = new URL(WDQS_ENDPOINT)
		url.searchParams.set("query", sparql)

		const response = await this.fetch<SPARQLResults>({ url: url.toString() })

		return response.data
	}
}

/**
 * Construct a {@link WikidataClient} with every default resolved.
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
				// `value.data` is the cached RESPONSE; `value.data.data` is its body. Passing the response here
				// instead of the body is a silent-failure trap — the predicate returns false for every entry and
				// every run re-fetches while logging "rejected by the configured validate() predicate". Caught
				// on the first live run, 2026-08-04.
				validate: (value) => isSPARQLResults(value.data?.data),
			}),
			ttl: WDQS_CACHE_TTL_MS,
			// The TTL is chosen against Wikidata's edit cadence; letting a CDN header override it would
			// silently replace that reasoning with whatever varnish in front of WDQS happens to send.
			interpretHeader: false,
		},
		axios: {
			headers: {
				"User-Agent": WIKIDATA_USER_AGENT,
				Accept: "application/sparql-results+json",
			},
			timeout: WDQS_REQUEST_TIMEOUT_MS,
			responseType: "json",
			// Axios hands back the RAW STRING when a body fails to parse unless this is off. WDQS serves an
			// HTML error page under some failures, and returning that as `SPARQLResults` would surface as an
			// `undefined` destructure far from the cause.
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
 * Write a JSON payload and return its manifest entry.
 */
async function writePayload(
	destDir: string,
	filename: string,
	query: string,
	results: SPARQLResults
): Promise<WikidataFileEntry> {
	const path = join(destDir, filename)
	const body = JSON.stringify(results, null, 2) + "\n"
	await writeFile(path, body)

	return {
		filename,
		query,
		rows: results.results.bindings.length,
		sha256: await sha256File(path),
		bytes: Buffer.byteLength(body),
	}
}

/**
 * Run both queries and write their raw SPARQL JSON into `<outRoot>/wikidata-subvenue/`, with a `MANIFEST.json` carrying
 * the endpoint, the exact queries, the concept table, row counts and sha256s.
 *
 * The RAW envelope is written rather than a reshaped one on purpose: the lexicon build is a separate, pure step
 * (`sub-venue-lexicon.ts`) and keeping the fetch output byte-faithful to what WDQS served means a lexicon regeneration
 * never needs the network.
 */
export async function fetchWikidataSubVenue(
	options: FetchWikidataSubVenueOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	mkdirSync(destDir, { recursive: true })

	await using client = createWikidataClient({ cacheDir: join(destDir, "http-cache") })

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

	await writeManifest(join(destDir, "MANIFEST.json"), manifest)

	return { fetched, skipped: 0, failed, failedCodes }
}
