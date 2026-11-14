// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Ingests WOF records into the admin-gazetteer staging database from the WOF record store.
 */

import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { choosePoint, type GeoNamesAnchorLookup, type PointChoice } from "#tools/pipeline/admin/label-point-adjudicator"
import { type ExtractedWOFFeature, extractParsedWOFFeature } from "#tools/pipeline/admin/wof/feature"
import type { WOFFeature } from "#whosonfirst"
import {
	refreshWOFRecordStore,
	storedWOFRecords,
	wofRecordStorePathFor,
	wofRepositories,
	type WOFRecordStoreDatabase,
	type WOFRepoRefresh,
} from "#whosonfirst/record-store"

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
	 * The WOF record store to refresh and read.
	 *
	 * @defaultValue {@linkcode wofRecordStorePathFor} of `dataDir`
	 */
	recordStore?: PathBuilderLike
	/**
	 * Called once per repository the store refresh reused or reduced again.
	 */
	onRepo?: (refresh: WOFRepoRefresh) => void
	/**
	 * The number of ingested records per write transaction.
	 *
	 * @defaultValue `500`
	 */
	batchCommitSize?: number
	/**
	 * Called after every 25,000 ingested records.
	 *
	 * `found` counts the stored records under a `data/` directory read so far.
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
 * A stored record's path lies under a `data/` directory, the only part of a checkout the ingest reads.
 */
const DATA_PATH = /(?:^|\/)data\//u

/**
 * Ingests the WOF records under `opts.dataDir` into an open staging database,
 * read from the WOF record store.
 *
 * The store is refreshed first, so a repository whose commit and working tree are
 * unchanged is read without parsing its GeoJSON.
 * Records are written in WOF-id order, in batched transactions, with locality points adjudicated on the way.
 *
 * Postalcode repositories are skipped unless `placetypes` includes `postalcode`.
 */
export async function ingestWOF(db: DatabaseClient<WOFDatabase>, opts: IngestWOFOptions): Promise<IngestWOFResult> {
	const placetypes = opts.placetypes ?? ADMIN_PLACETYPES
	const batchCommitSize = opts.batchCommitSize ?? 500
	const storePath = opts.recordStore ?? wofRecordStorePathFor(opts.dataDir)

	await refreshWOFRecordStore(storePath, opts.dataDir, { onRepo: opts.onRepo })

	const repos = (await wofRepositories(opts.dataDir))
		.map((repo) => repo.basename())
		.filter((repo) => placetypes.has("postalcode") || !repo.startsWith("whosonfirst-data-postalcode-"))

	using store = new DatabaseClient<WOFRecordStoreDatabase>(storePath, { readOnly: true })
	let filesFound = 0

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

	for (const stored of storedWOFRecords<WOFFeature>(store, { repos, placetypes })) {
		if (!DATA_PATH.test(stored.path)) continue

		filesFound++
		const feature = extractParsedWOFFeature(stored.feature, placetypes)

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
