/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds `<data root>/db/osm/places-osm.db` by scrolling places out of a running Photon index's embedded
 *   OpenSearch.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/landmarks/osm/places.run.ts --vintage <yyyy-mm-dd> [--countries us,vn]
 *   [--opensearch http://127.0.0.1:9201] [--out <path>]
 */

import { dataRootPath, databaseRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { createLayerManifestTable, LayerFreshnessPolicy, LayerTier, writeLayerManifest } from "@mailwoman/core/layers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import {
	createLandmarkTables,
	LANDMARK_NAME_COLUMNS,
	type LandmarkDatabase,
} from "@mailwoman/resolver-wof-sqlite/landmark"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed/build"
import { resolvePath } from "path-ts"

import { OSM_PLACES_DATABASE_FILE } from "#geocode/osm-layers"
import {
	OSM_PLACE_H3_RESOLUTION,
	osmPlaceQuery,
	osmPlaceRows,
	type PhotonPlaceDocument,
} from "#tools/dev-tools/landmarks/osm/places"

const { values } = parseArguments({
	options: {
		vintage: { type: "string" },
		countries: { type: "string" },
		opensearch: { type: "string" },
		out: { type: "string" },
	},
})

if (!values.vintage) throw new Error("--vintage is the Photon dump's OSM date, and it is required")

const base = values.opensearch ?? "http://127.0.0.1:9201"
const out = values.out ? resolvePath(values.out) : databaseRootPath(dataRootPath())("osm", OSM_PLACES_DATABASE_FILE)
const countries = values.countries?.split(",").map((code) => code.trim().toUpperCase())

const query = countries
	? { bool: { must: [osmPlaceQuery()], filter: [{ terms: { countrycode: countries } }] } }
	: osmPlaceQuery()

interface ScrollPage {
	_scroll_id: string
	hits: { total: { value: number }; hits: Array<{ _source: PhotonPlaceDocument }> }
}

async function post(path: string, body: unknown): Promise<ScrollPage> {
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: stringifyJSON(body),
	})

	if (!response.ok) throw new Error(`OpenSearch ${path} answered ${response.status}: ${await response.text()}`)

	return (await response.json()) as ScrollPage
}

const counts = await buildSealedArtifact<
	LandmarkDatabase,
	{ documents: number; rows: number },
	{ documents: number; rows: number }
>({
	out,
	createTables: async (database) => {
		await createLandmarkTables(database)
		await createLayerManifestTable(database)
	},
	ingest: async (database) => {
		const insert = database.prepare(
			`INSERT OR REPLACE INTO landmark_name VALUES (${LANDMARK_NAME_COLUMNS.map(() => "?").join(", ")})`
		)

		const tally = { documents: 0, rows: 0 }

		let page = await post("/photon/_search?scroll=5m", {
			size: 5000,
			query,
			_source: ["osm_type", "osm_id", "name", "coordinate", "countrycode", "importance"],
		})

		const expected = page.hits.total.value

		while (page.hits.hits.length) {
			database.exec("BEGIN")

			for (const hit of page.hits.hits) {
				tally.documents++

				for (const row of osmPlaceRows(hit._source)) {
					tally.rows++
					insert.run(...LANDMARK_NAME_COLUMNS.map((column) => row[column]))
				}
			}

			database.exec("COMMIT")
			page = await post("/_search/scroll", { scroll: "5m", scroll_id: page._scroll_id })
		}

		// A short scroll would read as places the world lacks.
		if (tally.documents !== expected) {
			throw new Error(`The scroll read ${tally.documents} of ${expected} documents`)
		}

		return tally
	},
	finish: async (database, tally) => {
		await writeLayerManifest(database, {
			name: "osm-places",
			version: values.vintage!,
			schemaVersion: 1,
			tier: LayerTier.BuildLocal,
			license: "ODbL-1.0",
			attribution: "© OpenStreetMap contributors",
			source: "photon-dump",
			sourceVintage: values.vintage!,
			buildCmd: "node packages/mailwoman/tools/dev-tools/landmarks/osm/places.run.ts",
			buildSHA: "unrecorded",
			freshnessPolicy: LayerFreshnessPolicy.Sealed,
			spineKeys: { h3: { column: "h3_cell", resolution: OSM_PLACE_H3_RESOLUTION } },
			createdAt: new Date().toISOString(),
			sourceRecords: { "photon-dump": tally.documents },
		})

		return tally
	},
})

console.log(`wrote ${out.toString()}: ${counts.documents} documents, ${counts.rows} name rows`)
