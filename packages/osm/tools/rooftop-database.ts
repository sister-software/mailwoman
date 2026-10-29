/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds one country's OSM rooftop address-point database from a Geofabrik `.osm.pbf` extract, on the
 *   shared situs schema (`@mailwoman/resolver-wof-sqlite/address/point/spine-schema`). The existing
 *   `AddressPointSqliteLookup` reads it with zero changes.
 *
 *   The output is an OpenStreetMap Derivative Database under ODbL 1.0, whose rows record
 *   `source = openstreetmap:<cc>`. The build records the extract's URL and SHA-256 in the database's
 *   `layer_manifest`. `README.md` states the licensing boundary.
 *
 *   `build-rooftop-database.ts` runs this from the command line, and the `osm-address-points` recipe runs
 *   it for `mailwoman data build`.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePath } from "@mailwoman/core/fs/writers"
import { writeLayerManifest } from "@mailwoman/core/layers"
import { createAddressPointIndexes } from "@mailwoman/resolver-wof-sqlite/address"
import {
	ADDRESS_POINT_H3_RESOLUTION,
	createSpineAddressPointIndexes,
	createSpineAddressPointTables,
	SPINE_ADDRESS_POINT_COLUMNS,
	type SpineAddressPointDatabase,
} from "@mailwoman/resolver-wof-sqlite/address/point/spine-schema"
import {
	canonicalizeRouteKey,
	normalizeLocalityForKey,
	normalizeStreetForKeyLocale,
	streetLocaleForSurface,
} from "@mailwoman/resolver-wof-sqlite/street"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed/db"
import { latLngToCell } from "h3-js"
import { dirname } from "path-ts"

import { extractAddrPoints } from "#sdk/extract"
import type { ExtractProvenance } from "#sdk/extract/receipt"
import { buildStreetRecoveryIndex } from "#sdk/street/recovery"
import { streetLocaleForCountry } from "#street-locale"
import { osmAddressPointLayerManifest } from "#tools/layer-manifest"
import { streetNameForms } from "#tools/street-names"

/**
 * What one rooftop build reads and writes.
 */
export interface RooftopBuildOptions {
	/**
	 * ISO 3166-1 alpha-2 code, lowercase.
	 */
	country: string
	slug: string
	pbf: string
	release: string
	createdAt: string
	buildSHA: string
	buildCmd: string
	/**
	 * The database path the build swaps its result into.
	 */
	output: string
	provenance: ExtractProvenance
	/**
	 * Recover the street for points with no `addr:street` from the nearest highway with a name.
	 */
	recover: boolean
	recoverRadiusKm: number
	/**
	 * Keeps only the points it accepts, such as the points inside the country's outline.
	 *
	 * Absent, every point of the extract is kept.
	 */
	within?: (lon: number, lat: number) => boolean
	signal?: AbortSignal
	log?: (line: string) => void
}

/**
 * What a rooftop build counted.
 */
export interface RooftopBuildCounts {
	/**
	 * `addr:housenumber` features the extract read.
	 */
	total: number
	/**
	 * Points kept, each written as one row per street-name form.
	 */
	written: number
	recovered: number
	bilingual: number
	/**
	 * Points skipped for having no street.
	 */
	noStreet: number
	badCoord: number
	/**
	 * Points outside {@link RooftopBuildOptions.within}.
	 */
	outside: number
}

/**
 * Build the database, swap it into {@link RooftopBuildOptions.output} and seal it.
 *
 * @throws When the extract cannot be read, the country has no street locale, or `signal` aborts.
 * The output path keeps whatever it held before.
 */
export async function buildRooftopDatabase(options: RooftopBuildOptions): Promise<RooftopBuildCounts> {
	const log = options.log ?? (() => {})
	const locale = streetLocaleForCountry(options.country)
	const source = `openstreetmap:${options.country}`
	const recoverSource = `${source}#recovered`
	const recoveryIndex = options.recover ? await buildStreetRecoveryIndex(options.pbf) : null

	if (recoveryIndex) {
		log(
			`recovery index: ${recoveryIndex.size.toLocaleString()} highway vertices (radius ${options.recoverRadiusKm * 1000}m)`
		)
	}

	const tmp = `${options.output}.tmp-${process.pid}`

	await makeDirectories(dirname(options.output))

	if (await pathExists(tmp)) {
		await removePath(tmp)
	}

	const counts: RooftopBuildCounts = {
		total: 0,
		written: 0,
		recovered: 0,
		bilingual: 0,
		noStreet: 0,
		badCoord: 0,
		outside: 0,
	}

	try {
		using kdb = new DatabaseClient<SpineAddressPointDatabase>(tmp)
		kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")
		await createSpineAddressPointTables(kdb)

		const insert = kdb.prepare(
			`INSERT INTO address_point VALUES (${SPINE_ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`
		)

		const BATCH = 50_000

		log(`building ${options.country}/${options.slug} rooftop extract from ${options.pbf}`)

		kdb.exec("BEGIN")

		for await (const rec of extractAddrPoints(options.pbf)) {
			options.signal?.throwIfAborted()

			counts.total++

			if (!Number.isFinite(rec.lat) || !Number.isFinite(rec.lon)) {
				counts.badCoord++

				continue
			}

			if (options.within && !options.within(rec.lon, rec.lat)) {
				counts.outside++

				continue
			}

			let street = rec.street
			let rowSource = source

			if (!street) {
				const hit = recoveryIndex?.nearest(rec.lon, rec.lat, options.recoverRadiusKm)

				if (!hit) {
					counts.noStreet++

					continue
				}

				street = hit.name
				rowSource = recoverSource

				counts.recovered++
			}

			// Per-surface locale routing.
			// A French-lead surface folds under the fr rules regardless of the country default,
			// and the probe side routes with the same shared function.
			const streetNorms = [
				...new Set(
					streetNameForms(street)
						.map((form) => normalizeStreetForKeyLocale(form, streetLocaleForSurface(form, locale)))
						.filter((norm) => norm.length > 0)
				),
			]

			const number = rec.housenumber.trim().toLowerCase()

			if (!streetNorms.length || !number) {
				counts.noStreet++

				continue
			}

			const h3Cell = shortCellToInt(latLngToCell(rec.lat, rec.lon, ADDRESS_POINT_H3_RESOLUTION) as H3Cell)
			const locality = rec.suburb ?? rec.city

			// A bilingual street gets one row per language form, each keyed on that form,
			// so a query in either language reaches the same rooftop.
			// `street_raw` keeps the mapped value on every row.
			for (const streetNorm of streetNorms) {
				// Positional, in SPINE_ADDRESS_POINT_COLUMNS order: the shared address columns, then h3_cell.
				insert.run(
					streetNorm,
					canonicalizeRouteKey(streetNorm),
					number,
					null,
					rec.postcode?.trim() || null,
					locality ? normalizeLocalityForKey(locality) : null,
					street,
					rec.lat,
					rec.lon,
					rowSource,
					options.release,
					// OSM states no commune key and no certification flag.
					null,
					null,
					h3Cell
				)
			}

			if (streetNorms.length > 1) {
				counts.bilingual++
			}

			counts.written++

			if (counts.written % BATCH === 0) {
				kdb.exec("COMMIT")
				kdb.exec("BEGIN")

				if (counts.written % 500_000 === 0) {
					log(`  ${counts.written.toLocaleString()} written…`)
				}
			}
		}

		kdb.exec("COMMIT")

		log("indexing…")

		await createAddressPointIndexes(kdb)
		await createSpineAddressPointIndexes(kdb)

		await writeLayerManifest(
			kdb,
			osmAddressPointLayerManifest({
				country: options.country,
				slug: options.slug,
				release: options.release,
				createdAt: options.createdAt,
				buildSHA: options.buildSHA,
				buildCmd: options.buildCmd,
				provenance: options.provenance,
			})
		)

		kdb.exec("ANALYZE")
	} catch (error) {
		await removePath(tmp).catch(() => {})

		throw error
	}

	// Build-on-copy.
	// The freshly-built extract is swapped into place only after the build completes.
	await swapDatabaseIntoPlace(tmp, options.output)
	await sealDatabase(options.output)

	return counts
}
