/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the ranked items' records from the Wikidata Query Service instead of `wbgetentities`.
 *
 *   A `wbgetentities` answer holds every statement and every sitelink of an item, so a batch takes longer than a
 *   second to serve and the Robot policy then asks for a five-second wait before the next request. One query per batch
 *   asks only for the fields a record keeps: the sitelink count, the `P31` classes, the `P17` countries, the Earth
 *   coordinate, the population, and the labels and aliases in the configured languages. The truthy `wdt:` statements are
 *   the best-ranked ones. A record keeps that rank.
 */

import { appendLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { formatQuantity } from "@mailwoman/core/resources/locale"
import type { LatLon } from "@mailwoman/spatial/position"
import type { PathBuilderLike } from "path-ts"

import type { WikidataClient } from "#tools/fetch/wikidata/subvenue"
import {
	DEFAULT_LANGUAGES,
	readEntityRecords,
	type FetchVitalEntitiesResult,
	type VitalEntityRecord,
} from "#tools/fetch/wikidata/vital-places/entities"
import { chunked, entityQID, formatElapsed, type ProgressReporter } from "#tools/fetch/wikidata/vital-places/progress"
import type { QRankRow } from "#tools/fetch/wikidata/vital-places/qrank"

/**
 * The ids one query asks for.
 *
 * The query is a GET, and 200 ids keep its URL well under the service's limit.
 */
export const QUERY_ENTITY_BATCH = 200

/**
 * The queries in flight at once.
 *
 * The query service admits five parallel queries from one client.
 */
export const QUERY_ENTITY_CONCURRENCY = 3

/**
 * The IRI of a Wikidata item.
 */
const ITEM_IRI = /\/entity\/Q\d+$/u

/**
 * The query for one batch: one row per field value, tagged with the field it belongs to.
 */
export function buildEntityFieldsQuery(qids: readonly string[], languages: readonly string[]): string {
	const values = qids.map((qid) => `wd:${qid}`).join(" ")
	const languageList = languages.map((language) => `"${language}"`).join(", ")

	return `SELECT ?item ?field ?value ?language WHERE {
	VALUES ?item { ${values} }
	{ ?item wikibase:sitelinks ?value. BIND("sitelinks" AS ?field) }
	UNION { ?item wdt:P31 ?value. BIND("class" AS ?field) }
	UNION { ?item wdt:P17 ?value. BIND("country" AS ?field) }
	UNION { ?item wdt:P625 ?value. BIND("coordinate" AS ?field) }
	UNION { ?item wdt:P1082 ?value. BIND("population" AS ?field) }
	UNION { ?item rdfs:label ?value. FILTER(LANG(?value) IN (${languageList})) BIND("label" AS ?field) BIND(LANG(?value) AS ?language) }
	UNION { ?item skos:altLabel ?value. FILTER(LANG(?value) IN (${languageList})) BIND("alias" AS ?field) BIND(LANG(?value) AS ?language) }
}`
}

/**
 * An Earth coordinate from a `wdt:P625` literal.
 *
 * Another body's coordinate writes its globe's IRI before the point.
 */
export function readPointLiteral(literal: string): LatLon | null {
	const point = /^Point\(([-\d.eE]+) ([-\d.eE]+)\)$/u.exec(literal.trim())

	return point ? { lat: Number(point[2]), lon: Number(point[1]) } : null
}

/**
 * The records of one batch, built from the query's field rows.
 * An id with no row is recorded as missing.
 */
export function recordsFromFieldRows(
	batch: readonly QRankRow[],
	bindings: ReadonlyArray<Record<string, { value: string; "xml:lang"?: string } | undefined>>
): VitalEntityRecord[] {
	interface Fields {
		seen: boolean
		sitelinks: number
		classes: Set<string>
		countries: Set<string>
		coordinate: LatLon | null
		population: number | null
		labels: Record<string, string>
		aliases: Record<string, string[]>
	}

	const byQID = new Map<string, Fields>(
		batch.map((row) => [
			row.qid,
			{
				seen: false,
				sitelinks: 0,
				classes: new Set(),
				countries: new Set(),
				coordinate: null,
				population: null,
				labels: {},
				aliases: {},
			},
		])
	)

	for (const binding of bindings) {
		const fields = byQID.get(entityQID(binding.item?.value ?? ""))
		const value = binding.value?.value

		if (!fields || value === undefined) continue
		fields.seen = true
		const language = binding.language?.value ?? binding.value?.["xml:lang"] ?? ""

		switch (binding.field?.value) {
			case "sitelinks":
				fields.sitelinks = Number(value)
				break
			// An "unknown value" statement answers with a blank node (`.well-known/genid/...`), which is no item.
			case "class":
				if (ITEM_IRI.test(value)) {
					fields.classes.add(entityQID(value))
				}
				break
			case "country":
				if (ITEM_IRI.test(value)) {
					fields.countries.add(entityQID(value))
				}
				break
			case "coordinate":
				fields.coordinate ??= readPointLiteral(value)
				break
			case "population": {
				const population = Number(value)

				if (Number.isFinite(population)) {
					fields.population = Math.max(fields.population ?? 0, population)
				}

				break
			}
			case "label":
				if (language) {
					fields.labels[language] = value
				}
				break
			case "alias":
				if (language) {
					;(fields.aliases[language] ??= []).push(value)
				}
				break
		}
	}

	return batch.map((row) => {
		const fields = byQID.get(row.qid)!

		if (!fields.seen) return { qid: row.qid, qrank: row.qrank, missing: true }

		return {
			qid: row.qid,
			qrank: row.qrank,
			classes: [...fields.classes],
			countries: [...fields.countries],
			coordinate: fields.coordinate,
			population: fields.population,
			sitelinks: fields.sitelinks,
			labels: fields.labels,
			aliases: fields.aliases,
		}
	})
}

export interface FetchVitalEntitiesFromQueriesOptions {
	entitiesPath: PathBuilderLike
	languages?: readonly string[]
	batchSize?: number
	concurrency?: number
	reportEvery?: number
	report?: ProgressReporter
}

/**
 * Append a record for every ranked id the entities file lacks, one query per batch,
 * with a few queries in flight.
 *
 * An id already on disk is not asked for again, and a failed query is reported and left for a rerun.
 */
export async function fetchVitalEntitiesFromQueries(
	client: Pick<WikidataClient, "query">,
	rows: readonly QRankRow[],
	options: FetchVitalEntitiesFromQueriesOptions
): Promise<FetchVitalEntitiesResult> {
	const { entitiesPath, report, reportEvery = 20 } = options
	const languages = options.languages ?? DEFAULT_LANGUAGES
	const batchSize = options.batchSize ?? QUERY_ENTITY_BATCH
	const concurrency = Math.min(options.concurrency ?? QUERY_ENTITY_CONCURRENCY, 5)
	const present = new Set((await readEntityRecords(entitiesPath)).map((record) => record.qid))

	const batches = chunked(
		rows.filter((row) => !present.has(row.qid)),
		batchSize
	)

	const pending = batches.reduce((sum, batch) => sum + batch.length, 0)
	const result: FetchVitalEntitiesResult = { skipped: rows.length - pending, fetched: 0, failedBatches: [] }
	const startedAt = performance.now()
	let located = 0
	let next = 0
	let completed = 0
	let writes: Promise<void> = Promise.resolve()

	report?.(
		`  entities: ${formatQuantity(result.skipped)} of ${formatQuantity(rows.length)} already on disk, ` +
			`${formatQuantity(batches.length)} queries to go, ${batchSize} ids each, query service, concurrency ${concurrency}`
	)

	const worker = async (): Promise<void> => {
		while (next < batches.length) {
			const index = next++
			const batch = batches[index]!

			try {
				const answer = await client.query(
					buildEntityFieldsQuery(
						batch.map((row) => row.qid),
						languages
					)
				)

				const records = recordsFromFieldRows(batch, answer.results.bindings)

				writes = writes.then(() =>
					appendLocalTextFile(records.map((record) => stringifyJSON(record)).join("\n") + "\n", entitiesPath)
				)

				await writes

				result.fetched += records.length
				located += records.filter((record) => !("missing" in record) && record.coordinate !== null).length
			} catch (error) {
				writes = writes.catch(() => undefined)
				result.failedBatches.push(batch[0]!.qid)

				report?.(
					`  ✗ entities: query ${index + 1} (${batch[0]!.qid}…): ${error instanceof Error ? error.message : String(error)}`
				)
			}

			completed++

			if (completed % reportEvery === 0 || completed === batches.length) {
				const seconds = (performance.now() - startedAt) / 1000

				report?.(
					`  entities: [${formatQuantity(completed)}/${formatQuantity(batches.length)}] ${formatQuantity(result.fetched)} fetched, ` +
						`${formatQuantity(located)} with a coordinate, ${(completed / Math.max(seconds, 0.001)).toFixed(2)} queries/s, ${formatElapsed(startedAt)}`
				)
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(batches.length, 1)) }, worker))

	return result
}
