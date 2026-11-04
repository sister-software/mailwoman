/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Fetches the vital places inventory (#2911): the most-viewed Wikidata items that are places, with their
 * classes, country, coordinate, population, sitelink count, and labels and aliases in a language list.
 * Every input is CC0: QRank ranks the candidates, the Wikidata API describes them, and the query service
 * classifies their classes.
 *
 * Four phases run in order under `<outRoot>/wikidata-vital-places/`, each resuming from its own file:
 *
 * 1. `qrank.csv.gz` and `qrank.json`: the ranked list and its receipt ({@linkcode downloadQRank}).
 * 2. `entities.jsonl`: one record per ranked id, appended as each request answers ({@linkcode fetchVitalEntities}).
 *    These requests skip the HTTP cache, and go out logged in when `WIKIDATA_BOT_USERNAME` and
 *    `WIKIDATA_BOT_PASSWORD` are set.
 * 3. `countries.json` and `class-roots.v3.json`: the country codes and the class verdicts, cached
 *    ({@linkcode readCountryCodes}, {@linkcode classifyClasses}).
 * 4. `places.jsonl`, `counts.json` and `MANIFEST.json`: the inventory, rewritten from the files above.
 *
 * A world-scale selection by class through the query service is not possible: on 2026-11-03, 27 of 29
 * per-class `GROUP BY` counts timed out after about 135 s each, as did the per-country selection queries,
 * while `wbgetentities` described 5,171 items without a timeout.
 */

import { APIClient } from "@mailwoman/core/api"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists, statPath } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { formatQuantity } from "@mailwoman/core/resources/locale"
import type { PathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { $private } from "#env"
import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download"
import { writeManifest } from "#tools/fetch/download"
import { botCredentialsFrom, type WikidataBotCredentials } from "#tools/fetch/wikidata/session"
import { createWikidataClient, WDQS_ENDPOINT, WIKIDATA_USER_AGENT } from "#tools/fetch/wikidata/subvenue"
import {
	CLASS_QUERY_BATCH,
	classifyClasses,
	EXCLUDED_ROOTS,
	PLACE_ROOTS,
} from "#tools/fetch/wikidata/vital-places/classify"
import {
	createWikidataAPIClient,
	DEFAULT_LANGUAGES,
	isVitalEntity,
	readCountryCodes,
	readEntityRecords,
	WIKIDATA_API_ENDPOINT,
} from "#tools/fetch/wikidata/vital-places/entities"
import { buildInventory, type VitalPlaceCounts, writeInventory } from "#tools/fetch/wikidata/vital-places/inventory"
import { formatElapsed, type ProgressReporter } from "#tools/fetch/wikidata/vital-places/progress"
import {
	downloadQRank,
	QRANK_DOWNLOAD_URL,
	QRANK_LICENSE,
	type QRankRow,
	readTopQRank,
} from "#tools/fetch/wikidata/vital-places/qrank"
import { fetchVitalEntitiesFromQueries } from "#tools/fetch/wikidata/vital-places/query-entities"

/**
 * The source id, and the directory under the fetch root.
 */
export const VITAL_PLACES_SLUG = "wikidata-vital-places"

/**
 * The number of ranked items read when a caller sets no count.
 */
export const DEFAULT_TOP = 50_000

/**
 * The files a run writes under its directory.
 */
export const VITAL_PLACES_FILES = {
	entities: "entities.jsonl",
	countries: "countries.json",
	// The name changes with `DESCENT_ROOTS`: an entry cached under fewer roots would
	// read as descending from none of the roots it was never asked about.
	classRoots: "class-roots.v3.json",
	places: "places.jsonl",
	counts: "counts.json",
	manifest: "MANIFEST.json",
	httpCache: "http-cache",
} as const

/**
 * Options for {@linkcode fetchWikidataVitalPlaces}.
 */
export interface FetchWikidataVitalPlacesOptions extends BaseFetchOptions {
	/**
	 * The number of ranked items to describe, from the top of the list.
	 * @defaultValue {@linkcode DEFAULT_TOP}
	 */
	top?: number
	/**
	 * The languages whose labels and aliases are kept.
	 * @defaultValue {@linkcode DEFAULT_LANGUAGES}
	 */
	languages?: readonly string[] | null
	/**
	 * The ids one entity request asks for.
	 * @defaultValue {@linkcode DEFAULT_ENTITY_BATCH}
	 */
	batchSize?: number | null
	/**
	 * The entity requests in flight at once, capped at 1 anonymously and 3 logged in.
	 * @defaultValue the mode's cap
	 */
	concurrency?: number | null
	/**
	 * The bot login.
	 *
	 * Absent reads `WIKIDATA_BOT_USERNAME` and `WIKIDATA_BOT_PASSWORD`.
	 * `null` fetches anonymously.
	 */
	credentials?: WikidataBotCredentials | null
}

interface VitalPlacesFile {
	filename: string
	bytes: number
	sha256: string
}

/**
 * The manifest a run writes, with the inputs' licenses and every file's digest.
 */
export interface VitalPlacesManifest {
	source: string
	downloaded_at: string
	user_agent: string
	inputs: Array<{ name: string; url: string; license: string }>
	top: number
	languages: readonly string[]
	place_roots: readonly string[]
	excluded_roots: readonly string[]
	qrank_version: string
	counts: VitalPlaceCounts
	files: VitalPlacesFile[]
}

/**
 * The directory the inventory is written under a fetch root.
 */
export function vitalPlacesPath(outRoot: PathBuilder): PathBuilder {
	return outRoot(VITAL_PLACES_SLUG)
}

/**
 * Run the four phases and write the inventory under `<outRoot>/wikidata-vital-places/`.
 *
 * The registry entry point.
 * `fetched` counts the places written, `skipped` the ranked ids already described
 * before this run, and `failed` the requests that failed after their retries.
 * A rerun repeats those.
 */
export async function fetchWikidataVitalPlaces(
	options: FetchWikidataVitalPlacesOptions,
	report?: ProgressReporter
): Promise<FetchSummary> {
	const destDir = vitalPlacesPath(options.outRoot)
	const top = options.top ?? DEFAULT_TOP
	const languages = options.languages?.length ? options.languages : DEFAULT_LANGUAGES
	const startedAt = performance.now()

	await makeDirectories(destDir)

	report?.(`=== ${VITAL_PLACES_SLUG} (top ${formatQuantity(top)}, languages ${languages.join(",")})`)

	await using downloads = new APIClient({ displayName: "QRank", retry: true })
	const receipt = await downloadQRank(downloads, { destDir, retryDelayMs: options.retryDelayMs, report })

	const rows: QRankRow[] = []
	const readStartedAt = performance.now()

	for await (const row of readTopQRank(destDir(receipt.filename), top)) {
		rows.push(row)
	}

	report?.(`  qrank: read ${formatQuantity(rows.length)} ranked items in ${formatElapsed(readStartedAt)}`)

	const credentials =
		options.credentials === undefined
			? botCredentialsFrom($private.WIKIDATA_BOT_USERNAME, $private.WIKIDATA_BOT_PASSWORD)
			: options.credentials

	const cacheDir = destDir(VITAL_PLACES_FILES.httpCache)
	await using api = createWikidataAPIClient({ cacheDir, credentials })

	if (credentials) {
		report?.(`  login: logged in as ${await api.logIn()}`)
	} else {
		report?.("  login: no WIKIDATA_BOT_USERNAME and WIKIDATA_BOT_PASSWORD, requests go out anonymously")
	}

	const entitiesPath = destDir(VITAL_PLACES_FILES.entities)
	await using wdqs = createWikidataClient({ cacheDir })

	// The query service returns only the fields a record keeps.
	// A `wbgetentities` batch holds every statement and sitelink, so the Robot policy
	// asks for a five-second wait after each answer.
	const entities = await fetchVitalEntitiesFromQueries(wdqs, rows, {
		entitiesPath,
		languages,
		concurrency: options.concurrency ?? undefined,
		report,
	})

	const ranked = new Set(rows.map((row) => row.qid))
	const records = (await readEntityRecords(entitiesPath)).filter((record) => ranked.has(record.qid))
	const located = records.filter((record) => isVitalEntity(record) && record.coordinate !== null)

	const countriesPath = destDir(VITAL_PLACES_FILES.countries)

	const knownCodes = (await pathExists(countriesPath))
		? await readLocalJSONFile<Record<string, string | null>>(countriesPath)
		: {}

	// Records the query service wrote before blank-node values were dropped can hold a `genid` IRI in place of an item.
	const isItemID = (id: string) => /^Q\d+$/u.test(id)

	const countryIDs = [...new Set(located.flatMap((record) => (isVitalEntity(record) ? record.countries : [])))].filter(
		isItemID
	)

	const countryCodes = await readCountryCodes(api, countryIDs, knownCodes, report)
	await writeLocalJSONFile(countryCodes, countriesPath)

	const classIDs = [...new Set(located.flatMap((record) => (isVitalEntity(record) ? record.classes : [])))].filter(
		isItemID
	)

	const classes = await classifyClasses(wdqs, classIDs, { cachePath: destDir(VITAL_PLACES_FILES.classRoots), report })

	const inventory = buildInventory(records, classes.roots, countryCodes)
	await writeInventory(inventory, destDir(VITAL_PLACES_FILES.places), destDir(VITAL_PLACES_FILES.counts))

	const { counts } = inventory

	report?.(
		`  inventory: ${formatQuantity(counts.places)} places of ${formatQuantity(counts.records)} records; ` +
			`${formatQuantity(counts.excluded["no-coordinate"])} without a coordinate, ` +
			`${formatQuantity(counts.excluded.excluded)} excluded, ${formatQuantity(counts.excluded.unclassified)} unclassified, ` +
			`${formatQuantity(counts.excluded.missing)} missing; ${formatQuantity(Object.keys(counts.byCountry).length)} countries`
	)

	const files: VitalPlacesFile[] = []

	for (const filename of (
		await Globerator.from("*.{json,jsonl,csv.gz}", { cwd: destDir.toString() }).toArray()
	).toSorted()) {
		if (filename === VITAL_PLACES_FILES.manifest) continue

		const path = destDir(filename)

		files.push({ filename, bytes: (await statPath(path)).size, sha256: await sha256File(path) })
	}

	const manifest: VitalPlacesManifest = {
		source: VITAL_PLACES_SLUG,
		downloaded_at: new Date().toISOString(),
		user_agent: WIKIDATA_USER_AGENT,
		inputs: [
			{ name: "QRank", url: QRANK_DOWNLOAD_URL, license: QRANK_LICENSE },
			{ name: "Wikidata API", url: WIKIDATA_API_ENDPOINT, license: "CC0-1.0" },
			{ name: "Wikidata Query Service", url: WDQS_ENDPOINT, license: "CC0-1.0" },
		],
		top,
		languages,
		place_roots: PLACE_ROOTS,
		excluded_roots: EXCLUDED_ROOTS,
		qrank_version: receipt.version,
		counts,
		files,
	}

	await writeManifest(destDir(VITAL_PLACES_FILES.manifest), manifest)

	report?.(
		`  MANIFEST written to ${destDir(VITAL_PLACES_FILES.manifest).toString()}, ${formatElapsed(startedAt)} in all`
	)

	// A failed class query is counted once, under the first class in its batch.
	const failedQueries = classes.failedClasses.filter((_, index) => index % CLASS_QUERY_BATCH === 0)

	return {
		fetched: counts.places,
		skipped: entities.skipped,
		failed: entities.failedBatches.length + failedQueries.length,
		failedCodes: [...entities.failedBatches, ...failedQueries],
	}
}
