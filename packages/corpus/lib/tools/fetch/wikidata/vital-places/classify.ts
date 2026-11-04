/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The class leg: which of the kept entities' `P31` classes descend from a place root, and which from a
 * root that excludes an item.
 *
 * The query service cannot walk `P279*` over every item of a class at world scale (every per-class count
 * timed out on 2026-11-03), but it answers the walk for a batch of about 150 class ids within its limit,
 * and the kept entities use a few thousand distinct classes. Each class's roots are cached in a JSON file,
 * so a rerun asks only about classes it has not seen.
 */

import { errorMessage } from "@mailwoman/core/errors/schema"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { formatQuantity } from "@mailwoman/core/resources/locale"
import type { PathBuilderLike } from "path-ts"

import type { SPARQLResults, WikidataClient } from "#tools/fetch/wikidata/subvenue"
import { chunked, entityQID, formatElapsed, type ProgressReporter } from "#tools/fetch/wikidata/vital-places/progress"

/**
 * A class under one of these roots makes its instances places: geographic location,
 * geographical feature and architectural structure.
 */
export const PLACE_ROOTS: readonly string[] = ["Q2221906", "Q618123", "Q811979"]

/**
 * A class under one of these roots excludes its instances: occurrence
 * (an event such as a battle, placed at the coordinate where it happened)
 * and historical country (a polity no address names).
 */
export const EXCLUDED_ROOTS: readonly string[] = ["Q1190554", "Q3024240"]

/**
 * The most class ids one descent query names.
 *
 * Measured on 2026-11-03: a batch of 150 answers within the service's 60-second limit.
 */
export const CLASS_QUERY_BATCH = 150

/**
 * The roots each class descends from, `[]` for a class under none of them.
 */
export type ClassRoots = Record<string, string[]>

/**
 * What the class roots decide for one item.
 */
export const PLACE_VERDICTS = {
	place: "place",
	excluded: "excluded",
	unclassified: "unclassified",
} as const

export type PlaceVerdict = (typeof PLACE_VERDICTS)[keyof typeof PLACE_VERDICTS]

/**
 * The SPARQL that names, for each class in the batch, every root it descends from.
 *
 * `wdt:P279*` includes the zero-length path, so a class that is itself a root descends from it.
 */
export function buildClassDescentQuery(
	classQIDs: readonly string[],
	roots: readonly string[] = [...PLACE_ROOTS, ...EXCLUDED_ROOTS]
): string {
	if (!classQIDs.length || classQIDs.length > CLASS_QUERY_BATCH) {
		throw new RangeError(`a class descent query names 1 to ${CLASS_QUERY_BATCH} classes, not ${classQIDs.length}`)
	}

	return `SELECT DISTINCT ?class ?root WHERE {
  VALUES ?class { ${classQIDs.map((qid) => `wd:${qid}`).join(" ")} }
  VALUES ?root { ${roots.map((qid) => `wd:${qid}`).join(" ")} }
  ?class wdt:P279* ?root .
}`
}

/**
 * The roots of every class in the batch from the descent query's answer:
 * a class the answer never names descends from none.
 *
 * A binding missing either column is refused rather than read as an unclassified class.
 */
export function readClassRoots(classQIDs: readonly string[], results: SPARQLResults): ClassRoots {
	const roots: ClassRoots = Object.fromEntries(classQIDs.map((qid) => [qid, []]))

	for (const binding of results.results.bindings) {
		const cls = binding["class"]?.value
		const root = binding["root"]?.value

		if (typeof cls !== "string" || typeof root !== "string") {
			throw new TypeError("class descent query: a binding lacks its class or root column")
		}

		roots[entityQID(cls)]?.push(entityQID(root))
	}

	return roots
}

/**
 * The verdict for an item from its classes' roots.
 *
 * An excluded root wins over a place root, so a battle fought at a fortress stays out.
 * A class with no cached roots leaves the item unclassified.
 */
export function placeVerdict(classes: readonly string[], roots: Readonly<ClassRoots>): PlaceVerdict {
	let place = false

	for (const cls of classes) {
		for (const root of roots[cls] ?? []) {
			if (EXCLUDED_ROOTS.includes(root)) return PLACE_VERDICTS.excluded

			if (PLACE_ROOTS.includes(root)) {
				place = true
			}
		}
	}

	return place ? PLACE_VERDICTS.place : PLACE_VERDICTS.unclassified
}

/**
 * Read the cached class roots, `{}` when no file exists yet.
 */
export async function readClassRootsCache(path: PathBuilderLike): Promise<ClassRoots> {
	return (await pathExists(path)) ? readLocalJSONFile<ClassRoots>(path) : {}
}

export interface ClassifyClassesOptions {
	/**
	 * The JSON file the roots are cached in.
	 */
	cachePath: PathBuilderLike
	report?: ProgressReporter
}

export interface ClassifyClassesResult {
	roots: ClassRoots
	/**
	 * Classes whose query failed after the client's retries.
	 * They stay out of the cache.
	 */
	failedClasses: string[]
}

/**
 * Query the roots of every class the cache lacks, about 150 classes per query.
 *
 * The cache is rewritten after each answered batch, so an interrupted run keeps what it learned.
 */
export async function classifyClasses(
	client: Pick<WikidataClient, "query">,
	classQIDs: readonly string[],
	options: ClassifyClassesOptions
): Promise<ClassifyClassesResult> {
	const { cachePath, report } = options
	const roots = await readClassRootsCache(cachePath)
	const distinct = [...new Set(classQIDs)]
	const pending = distinct.filter((qid) => !(qid in roots))
	const batches = chunked(pending, CLASS_QUERY_BATCH)
	const queries = batches.length
	const failedClasses: string[] = []

	report?.(
		`  classes: ${formatQuantity(distinct.length)} distinct, ${formatQuantity(pending.length)} uncached, ` +
			`${formatQuantity(queries)} queries`
	)

	for (const [index, batch] of batches.entries()) {
		const query = index + 1
		const startedAt = performance.now()

		try {
			const answered = readClassRoots(batch, await client.query(buildClassDescentQuery(batch)))
			let place = 0
			let excluded = 0

			for (const [qid, classRoots] of Object.entries(answered)) {
				roots[qid] = classRoots

				if (classRoots.some((root) => EXCLUDED_ROOTS.includes(root))) {
					excluded++
				} else if (classRoots.some((root) => PLACE_ROOTS.includes(root))) {
					place++
				}
			}

			await writeLocalJSONFile(roots, cachePath)

			report?.(
				`  classes: [${query}/${queries}] ${batch.length} classes: ${place} place, ${excluded} excluded, ` +
					formatElapsed(startedAt)
			)
		} catch (error) {
			failedClasses.push(...batch)
			report?.(`  ✗ classes: query ${query} (${batch[0]}…): ${errorMessage(error)}`)
		}
	}

	return { roots, failedClasses }
}
