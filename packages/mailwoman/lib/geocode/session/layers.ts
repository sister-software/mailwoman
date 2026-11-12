// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The optional layers a geocode session opens from the data root: the observation
 *   routes over the sealed flood, soil, coastal and zoning layers, and the fork-to-entity
 *   probe over `poi.db`, the rail-station layer and the landmark layer.
 *
 *   Each loader answers an absent layer with `null` or an empty dependency set.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { allKeyed } from "@mailwoman/core/promises"
import { dirname, resolvePath, type PathBuilderLike } from "path-ts"

import type { LayerCatalog } from "#data/catalog"
import type { GeocodeDeps } from "#geocode/core"
import { selectedStreetMorphologyPath } from "#geocode/fst-layers"
import { layerDatabasePath, resolveLayerDatabasePath } from "#geocode/layer-paths"
import { openOSMPlaces } from "#geocode/osm-layers"
import type { CoastalErosionRoute } from "#observations/coastal-route"
import type { AuthorityDesignationRoute } from "#observations/flood-route"
import type { SoilCapabilityRoute } from "#observations/soil-route"
import type { ZoningDesignationRoute } from "#observations/zoning-route"

/**
 * The file name of the rail-station POI layer, built by
 * `gazetteer build poi --source osm --rules stations` into the directory that holds `poi.db`.
 */
export const STATIONS_DATABASE_FILE = "stations.db"

/**
 * The file name of the landmark layer, built by `tools/dev-tools/landmarks/build.run.ts`
 * into the directory that holds `poi.db`.
 */
export const LANDMARK_DATABASE_FILE = "landmarks.db"

/**
 * The fork-to-entity probe's dependencies and the `poi.db` handle to dispose.
 */
export interface ForkEntityProbe {
	deps: Pick<
		GeocodeDeps,
		"poiLookup" | "isStreetGeneric" | "rowFitsVenueHead" | "isVenueCategoryWord" | "landmarks" | "osmPlaces"
	>

	/**
	 * The `poi.db` handle behind `deps.poiLookup`, kept separately because
	 * `POIExecutorLookup` declares no disposal.
	 */
	handle?: Disposable
}

/**
 * The observation routes over the sealed layers, each `null` when its layer is missing or fails to open.
 */
export interface LayerRoutes {
	designation: AuthorityDesignationRoute | null
	soil: SoilCapabilityRoute | null
	coastal: CoastalErosionRoute | null
	zoning: ZoningDesignationRoute | null
}

type LayerDatabasePath = Awaited<ReturnType<typeof resolveLayerDatabasePath>>

/**
 * The route `open` builds over a sealed layer database, or `null` when the
 * database is absent or fails to open.
 */
async function openLayerRoute<Route>(
	databasePath: LayerDatabasePath,
	open: (databasePath: LayerDatabasePath) => Route | Promise<Route>
): Promise<Route | null> {
	if (!(await pathExists(databasePath))) return null

	try {
		return await open(databasePath)
	} catch {
		return null
	}
}

/**
 * The observation routes over the sealed layers in the data root: authority designation
 * from the flood layer, soil capability, coastal erosion from the England coastal layer,
 * and zoning from the Irish zoning layer.
 *
 * The four layer paths resolve before any route opens, so a path that fails to
 * resolve throws with no database handle open.
 * The routes then open in parallel.
 */
export async function loadLayerRoutes(
	options: { dataRoot: PathBuilderLike },
	catalog?: LayerCatalog
): Promise<LayerRoutes> {
	const paths = await allKeyed({
		flood: resolveLayerDatabasePath(options.dataRoot, "flood", catalog),
		soil: resolveLayerDatabasePath(options.dataRoot, "soil", catalog),
		coastal: resolveLayerDatabasePath(options.dataRoot, "coastal", catalog),
		zoning: resolveLayerDatabasePath(options.dataRoot, "zoning", catalog),
	})

	return allKeyed({
		designation: openLayerRoute(paths.flood, async (databasePath) =>
			(await import("#observations/flood-route")).createAuthorityDesignationRoute({ databasePath })
		),
		soil: openLayerRoute(paths.soil, async (databasePath) =>
			(await import("#observations/soil-route")).createSoilCapabilityRoute({ databasePath })
		),
		coastal: openLayerRoute(paths.coastal, async (databasePath) =>
			(await import("#observations/coastal-route")).createCoastalErosionRoute({ databasePath })
		),
		zoning: openLayerRoute(paths.zoning, async (databasePath) =>
			(await import("#observations/zoning-route")).createZoningDesignationRoute({ databasePath })
		),
	})
}

/**
 * Loads the fork-to-entity probe's POI lookup and street-generic test, neither
 * when `poi.db` is absent or the probe is disabled, because the probe needs the
 * street-generic test to keep street queries from matching venues.
 */
export async function loadForkEntityDeps(
	options: { dataRoot: PathBuilderLike; forkEntity: boolean },
	catalog?: LayerCatalog
): Promise<ForkEntityProbe> {
	const poiDBPath = await resolveLayerDatabasePath(options.dataRoot, "poi", catalog)
	// The rail-station layer sits beside the conventional poi.db as its own sealed database,
	// because it is built from OSM under a different license and tier than the Overture places in poi.db.
	// It has no registry entry, so it stays at that path when the selection lists a POI database elsewhere.
	const stationsDBPath = resolvePath(dirname(layerDatabasePath(options.dataRoot, "poi")), STATIONS_DATABASE_FILE)
	const paths = []

	for (const path of [poiDBPath, stationsDBPath]) {
		if (await pathExists(path)) {
			paths.push(path)
		}
	}

	if (options.forkEntity === false) return { deps: {} }

	// The landmark layer sits beside `poi.db` under the same convention as the stations layer, and answers without it.
	const landmarkDBPath = resolvePath(dirname(layerDatabasePath(options.dataRoot, "poi")), LANDMARK_DATABASE_FILE)

	const landmarkLayer = (await pathExists(landmarkDBPath))
		? new (await import("@mailwoman/resolver-wof-sqlite/landmark")).LandmarkSqliteLookup(landmarkDBPath)
		: null

	const osmPlaces = await openOSMPlaces(options.dataRoot)

	const landmarkDeps = { ...(landmarkLayer ? { landmarks: landmarkLayer } : {}), ...(osmPlaces ? { osmPlaces } : {}) }

	const landmarks = {
		[Symbol.dispose]: () => {
			landmarkLayer?.[Symbol.dispose]()
			osmPlaces?.[Symbol.dispose]()
		},
	}

	if (!paths.length) {
		return { deps: landmarkDeps, handle: landmarks }
	}

	const [{ POILookup }, { loadStreetMorphologyFST }, { isVenueCategoryWord, rowFitsVenueHead }] = await Promise.all([
		import("@mailwoman/resolver-wof-sqlite/poi"),
		import("@mailwoman/resolver-wof-sqlite/street"),
		import("#poi/venue-head-fit"),
	])

	// The street-morphology FST the active selection lists, else the loader's own data-root default.
	const streetMorphologyPath = await selectedStreetMorphologyPath(options.dataRoot, catalog)
	const morphology = await loadStreetMorphologyFST(streetMorphologyPath ? { artifactPath: streetMorphologyPath } : {})
	const lookups = paths.map((databasePath) => new POILookup({ databasePath }))

	return {
		deps: {
			poiLookup: { search: (query) => lookups.flatMap((lookup) => lookup.search(query)) },
			isStreetGeneric: (token: string) => morphology.matcher.walk([token]) !== null,
			rowFitsVenueHead,
			isVenueCategoryWord,
			...landmarkDeps,
		},
		handle: {
			[Symbol.dispose]: () => {
				for (const lookup of lookups) {
					lookup[Symbol.dispose]()
				}

				landmarks[Symbol.dispose]()
			},
		},
	}
}
