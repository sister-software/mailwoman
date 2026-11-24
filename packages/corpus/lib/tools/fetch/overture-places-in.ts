// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Copies the Indian places of an Overture Maps release, with their first address,
 * into the `overture-places-in/<release>/` snapshot the `overture-places-in` adapter reads.
 *
 * The places theme sits on Overture's public bucket,
 * `s3://overturemaps-us-west-2/release/<release>/theme=places/`, which needs no credential.
 * The query reads only the row groups whose bounding boxes fall in India's
 * (68–98° E, 6–37.5° N) and keeps the rows whose first address has the country `IN`,
 * so the copy reads a few hundred megabytes of the theme rather than all of it.
 *
 * Overture's attribution page lists the places theme's contributors under CDLA Permissive 2.0,
 * Foursquare under Apache 2.0 and AllThePlaces under CC0 1.0.
 * Each row keeps the dataset of its first source, so a count can be split by contributor.
 */

import { sha256File } from "@mailwoman/core/crypto/hash"
import { statPath } from "@mailwoman/core/fs/readers/stat"
import { DEFAULT_RELEASE } from "@mailwoman/gazetteer/tools/pipeline/poi/defaults"
import type { PathBuilder } from "path-ts"

import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { countParquetRows } from "#parquet/readers"
import type { FetchSummary } from "#tools/fetch/download"
import { writeManifest } from "#tools/fetch/download"
import { fetchSnapshot, type SnapshotFetchOptions } from "#tools/fetch/storage"

const SLUG = "overture-places-in"

/**
 * The file the snapshot holds.
 */
const OVERTURE_PLACES_IN_FILE = "places-in.parquet"

export interface FetchOverturePlacesINOptions extends SnapshotFetchOptions {
	/**
	 * The Overture release to copy, such as `2026-09-23.1`.
	 * It is also the snapshot's vintage.
	 */
	release?: string | null
}

/**
 * The places theme's files in one release.
 */
function placesGlob(release: string): string {
	return `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*.parquet`
}

/**
 * Copies the release's Indian places with an address into its snapshot.
 */
export async function fetchOverturePlacesIN(
	options: FetchOverturePlacesINOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	// Without a release from the caller, the one the gazetteer's places build pins.
	const release = options.release || options.snapshots.vintage || DEFAULT_RELEASE

	report?.(`=== ${SLUG} (Overture release ${release})`)

	return fetchSnapshot(options.snapshots, SLUG, release, (directory) => copyPlaces(release, directory, report), report)
}

async function copyPlaces(
	release: string,
	directory: PathBuilder,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const glob = placesGlob(release)
	const dest = directory(OVERTURE_PLACES_IN_FILE)
	const started = Date.now()

	{
		using db = await openDuckDB({ threads: 4 })

		await db.run("INSTALL httpfs; LOAD httpfs;")
		await db.run("SET s3_region='us-west-2';")

		report?.(`  Reading ${glob} ...`)

		await db.run(`COPY (
			SELECT
				id,
				addresses[1].freeform AS freeform,
				addresses[1].locality AS locality,
				addresses[1].region AS region,
				addresses[1].postcode AS postcode,
				sources[1].dataset AS dataset,
				sources[1].record_id AS record_id
			FROM read_parquet('${escapeSQLString(glob)}', hive_partitioning = false)
			WHERE bbox.xmin BETWEEN 68 AND 98 AND bbox.ymin BETWEEN 6 AND 37.5
				AND addresses[1].country = 'IN'
		) TO '${escapeSQLString(dest.toString())}' (FORMAT parquet, COMPRESSION zstd)`)
	}

	const rows = await countParquetRows(dest)
	const bytes = (await statPath(dest)).size
	const sha256 = await sha256File(dest)

	await writeManifest(directory("MANIFEST.json"), {
		source_url: glob,
		downloaded_at: new Date().toISOString(),
		filename: OVERTURE_PLACES_IN_FILE,
		sha256,
		bytes,
		publisher_version: release,
		rows,
	})

	report?.(
		`  ✓ ${rows} places, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s`
	)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
