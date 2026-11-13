// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Ingests WOF GeoJSON files into the admin-gazetteer staging database.
 */

import { availableParallelism } from "@mailwoman/core/utils/system"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"
import { parallelMapWorkers } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { choosePoint, type GeoNamesAnchorLookup, type PointChoice } from "#tools/pipeline/admin/label-point-adjudicator"
import type { ExtractedWOFFeature } from "#tools/pipeline/admin/wof/feature"
import type { WOFFeatureItem, WOFFeatureResult, WOFFeatureWorkerData } from "#tools/pipeline/admin/wof/feature/worker"

const WORKER_URL = new URL(
	import.meta.url.endsWith(".ts") ? "./wof/feature/worker.ts" : "./wof/feature/worker.js",
	import.meta.url
)

/**
 * The records a worker reads and extracts per dispatched batch.
 */
const WORKER_BATCH_SIZE = 64

/**
 * The default admin placetypes to ingest.
 *
 * Postalcode builds pass their own list.
 * Venue placetypes such as `campus` belong to the sub-venue layer.
 */
export const ADMIN_PLACETYPES: ReadonlySet<string> = new Set([
	"country",
	"region",
	"county",
	"locality",
	"localadmin",
	"borough",
	"neighbourhood",
	"macrohood",
	"microhood",
	"macroregion",
	"macrocounty",
])

/**
 * Options for {@link ingestWOF}.
 */
export interface IngestWOFOptions {
	/**
	 * The WOF data root.
	 *
	 * It can be a parent of `whosonfirst-data*` repositories or a single repository.
	 */
	dataDir: PathBuilderLike
	/**
	 * The placetypes to ingest.
	 *
	 * @defaultValue {@linkcode ADMIN_PLACETYPES}
	 */
	placetypes?: ReadonlySet<string>
	/**
	 * The worker threads that read and parse records.
	 *
	 * The main thread keeps the SQLite writes, so it keeps one core.
	 *
	 * @defaultValue one per core, less one
	 */
	workers?: number
	/**
	 * The number of ingested records per write transaction.
	 *
	 * @defaultValue `500`
	 */
	batchCommitSize?: number
	/**
	 * Called after every 25,000 ingested records.
	 *
	 * `found` counts the files the walk has yielded so far, and it grows until the walk finishes.
	 */
	onProgress?: (processed: number, skipped: number, found: number) => void
	/**
	 * The GeoNames anchor lookup for label-point adjudication.
	 */
	anchorLookup?: GeoNamesAnchorLookup
}

/**
 * Counts from one {@link ingestWOF} run.
 */
export interface IngestWOFResult {
	filesFound: number
	placesIngested: number
	skipped: number
	/**
	 * The number of records where GeoNames adjudication chose the geometry point over the label point.
	 */
	labelPointOverrides: number
}

/**
 * Yields worker results in walk order.
 *
 * The pool returns results in completion order.
 * The ingest writes with `INSERT OR REPLACE`, so the walk order decides which record
 * a repeated id keeps, and it has to match a single-threaded walk.
 */
async function* inWalkOrder(results: AsyncIterable<WOFFeatureResult>): AsyncGenerator<WOFFeatureResult> {
	const waiting = new Map<number, WOFFeatureResult>()
	let next = 0

	for await (const result of results) {
		waiting.set(result.index, result)

		while (waiting.has(next)) {
			yield waiting.get(next)!
			waiting.delete(next)

			next++
		}
	}

	if (waiting.size) {
		throw new Error(`ingestWOF: ${waiting.size} records arrived after a gap in the walk order at index ${next}`)
	}
}

/**
 * Chooses a record's stored point and bounding box.
 *
 * A locality with both points takes the point GeoNames adjudication chooses when an anchor lookup is given.
 * A record without a `geom:bbox` takes its final point as its bounding box.
 */
async function placeFeature(
	feature: ExtractedWOFFeature,
	anchorLookup: GeoNamesAnchorLookup | undefined
): Promise<{
	latitude: number
	longitude: number
	bbox: [number, number, number, number]
	pointChoice: PointChoice | null
}> {
	let { latitude, longitude } = feature.point
	let pointChoice: PointChoice | null = null

	if (feature.adjudication && anchorLookup) {
		const { geom, lbl, gnID, country } = feature.adjudication
		const anchor = gnID && country ? await anchorLookup(country, gnID) : null
		const chosen = choosePoint(geom, lbl, anchor)

		latitude = chosen.latitude
		longitude = chosen.longitude
		pointChoice = chosen.choice
	}

	return { latitude, longitude, bbox: feature.bbox ?? [longitude, latitude, longitude, latitude], pointChoice }
}

/**
 * Ingests WOF GeoJSON into an open staging database.
 *
 * Worker threads read and parse the records.
 * The main thread adjudicates locality points and writes the records serially,
 * in walk order, in batched transactions.
 *
 * Postalcode repositories are skipped unless `placetypes` includes `postalcode`.
 */
export async function ingestWOF(db: DatabaseClient<WOFDatabase>, opts: IngestWOFOptions): Promise<IngestWOFResult> {
	const placetypes = opts.placetypes ?? ADMIN_PLACETYPES
	const workers = opts.workers ?? Math.max(1, availableParallelism() - 1)
	const batchCommitSize = opts.batchCommitSize ?? 500

	const exclude = ["**/*-alt-*"]

	if (!placetypes.has("postalcode")) {
		exclude.push("**/whosonfirst-data-postalcode-*/**")
	}

	let filesFound = 0

	// The walk streams into the pool, so the paths of the millions of records are never held at once.
	const items = Globerator.from("**/data/**/*.geojson", {
		cwd: opts.dataDir,
		absolute: true,
		exclude,
		// A data root can expose one checkout both directly and through a symlink.
		// The ingester reads each record once when it skips symlinks.
		followSymlinks: false,
	}).map((path): WOFFeatureItem => ({ index: filesFound++, path }))

	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)

	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, privateuse, official, lastmodified, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'wof')`
	)

	const concordancesInsert = db.prepare(
		`INSERT INTO concordances (id, other_id, other_source, lastmodified, source) VALUES (?, ?, ?, ?, 'wof')`
	)

	const populationInsert = db.prepare(`INSERT OR REPLACE INTO place_population (id, population) VALUES (?, ?)`)

	let processed = 0
	let skipped = 0
	let labelPointOverrides = 0
	let inTransaction = false

	const beginIfNeeded = () => {
		if (!inTransaction) {
			db.exec("BEGIN TRANSACTION")
			inTransaction = true
		}
	}

	const commitIfNeeded = (force = false) => {
		if (inTransaction && (force || processed % batchCommitSize === 0)) {
			db.exec("COMMIT")
			inTransaction = false
		}
	}

	const workerData: WOFFeatureWorkerData = { placetypes: [...placetypes] }

	const results = parallelMapWorkers<WOFFeatureItem, WOFFeatureResult>(items, {
		worker: WORKER_URL,
		concurrency: workers,
		batchSize: WORKER_BATCH_SIZE,
		workerData,
	})

	for await (const { feature } of inWalkOrder(results)) {
		if (!feature) {
			skipped++

			continue
		}

		const { latitude, longitude, bbox, pointChoice } = await placeFeature(feature, opts.anchorLookup)
		const [minLongitude, minLatitude, maxLongitude, maxLatitude] = bbox

		if (pointChoice === "geom-by-anchor") {
			labelPointOverrides++
		}

		beginIfNeeded()

		sprInsert.run(
			feature.id,
			feature.parent_id,
			feature.name,
			feature.placetype,
			feature.country,
			latitude,
			longitude,
			minLatitude,
			minLongitude,
			maxLatitude,
			maxLongitude,
			feature.isCurrent,
			feature.isDeprecated,
			feature.isCeased,
			feature.isSuperseded,
			feature.isSuperseding,
			feature.lastmodified
		)

		for (const n of feature.names) {
			namesInsert.run(
				feature.id,
				n.name,
				feature.placetype,
				feature.country,
				n.language,
				n.privateuse,
				n.official,
				feature.lastmodified
			)
		}

		for (const [source, value] of Object.entries(feature.concordances)) {
			concordancesInsert.run(feature.id, String(value), source, feature.lastmodified)
		}

		if (feature.population > 0) {
			populationInsert.run(feature.id, feature.population)
		}

		processed++
		commitIfNeeded()

		if (processed % 25_000 === 0) {
			opts.onProgress?.(processed, skipped, filesFound)
		}
	}

	commitIfNeeded(true)

	return { filesFound, placesIngested: processed, skipped, labelPointOverrides }
}
