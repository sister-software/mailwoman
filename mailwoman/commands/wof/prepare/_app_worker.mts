/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Piscina worker for WOF prepare — reads GeoJSON files, extracts structured
 *   fields via pluckPlacetypeSpec, and upserts into PlacetypeDataSource (SQLite).
 *
 *   Receives a batch of file paths (not one at a time) to reduce IPC overhead.
 *   Opens PlacetypeDataSource handles lazily per (placetype, languageCode) and
 *   keeps them warm across the batch.
 */

import { DataSourceCache, pluckPlacetypeSpec, type PlacetypeRecord, type WOFFeature } from "@mailwoman/core/resources/whosonfirst"
import { readFileSync } from "node:fs"
import { PathBuilder } from "path-ts"

const DATA_DIRECTORY = PathBuilder.from(process.env.WOF_DATA_DIR || "/tmp/wof-placetype-dbs")

const cache = new DataSourceCache()

export interface WorkerInput {
	filePaths: string[]
}

export interface WorkerOutput {
	processed: number
	skipped: number
}

async function processFiles(input: WorkerInput): Promise<WorkerOutput> {
	let processed = 0
	let skipped = 0

	for (const filePath of input.filePaths) {
		const fileContent = readFileSync(filePath, "utf8")
		const feature: WOFFeature = JSON.parse(fileContent)

		const superseded_by = feature.properties["wof:superseded_by"]
		if (superseded_by && superseded_by.length !== 0) {
			skipped++
			continue
		}

		const { localizedPropMap, placetype, ...props } = pluckPlacetypeSpec(feature.properties)

		for (const [languageCode, nameKindMap] of localizedPropMap) {
			const ds = cache.open({ placetype, languageCode, dataDirectory: DATA_DIRECTORY })

			const record: PlacetypeRecord = {
				id: props.id,
				src: props.src,
				parent_id: props.parent_id,
				name: props.name,
				preferred: nameKindMap.get("preferred") ?? null,
				variant: nameKindMap.get("variant") ?? null,
				colloquial: nameKindMap.get("colloquial") ?? null,
				abbr: nameKindMap.get("abbr") ?? null,
				short: nameKindMap.get("short") ?? null,
			}

			await ds.upsert(record)
		}

		// If no localized names at all, still insert the base record with the canonical name
		if (localizedPropMap.size === 0) {
			const ds = cache.open({ placetype, languageCode: "eng", dataDirectory: DATA_DIRECTORY })
			const record: PlacetypeRecord = {
				id: props.id,
				src: props.src,
				parent_id: props.parent_id,
				name: props.name,
				preferred: null,
				variant: null,
				colloquial: null,
				abbr: null,
				short: null,
			}
			await ds.upsert(record)
		}

		processed++
	}

	return { processed, skipped }
}

export default processFiles
