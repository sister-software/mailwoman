/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where each attached spatial layer lives under the data root, one list shared by the geocode session and
 *   `mailwoman doctor` so a layer the doctor describes is a layer the session would attach.
 */

import { coastalDatabaseRoot } from "@mailwoman/coastal/paths"
import { databaseRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { ServingRole } from "@mailwoman/core/layers"
import { floodDatabaseRoot } from "@mailwoman/flood/paths"
import { poiDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { soilDatabaseRoot } from "@mailwoman/soil/paths"
import { zoningDatabaseRoot } from "@mailwoman/zoning/paths"
import type { PathBuilder, PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { LayerCatalog } from "#data/catalog"

/**
 * The layer databases the session attaches when present, keyed by the layer's short id
 * and each naming its directory through the owning package's `paths` export.
 */
const LAYER_DATABASES = {
	flood: {
		label: "Flood zones (EA England)",
		directory: floodDatabaseRoot,
		filename: "flood.db",
		role: ServingRole.FloodOverlay,
	},
	soil: {
		label: "Soil capability (NRCS SSURGO)",
		directory: soilDatabaseRoot,
		filename: "soil.db",
		role: ServingRole.SoilOverlay,
	},
	coastal: {
		label: "Coastal erosion (EA NCERM)",
		directory: coastalDatabaseRoot,
		filename: "coastal-england.db",
		role: ServingRole.CoastalErosionOverlay,
	},
	zoning: {
		label: "Zoning (Ireland)",
		directory: zoningDatabaseRoot,
		filename: "zoning-ireland.db",
		role: ServingRole.ZoningOverlay,
	},
	poi: { label: "POI layer", directory: poiDatabaseRoot, filename: "poi.db", role: ServingRole.POI },
} as const satisfies Record<
	string,
	{ label: string; directory: (dataRoot: PathBuilderLike) => PathBuilder; filename: string; role: ServingRole }
>

export type LayerID = keyof typeof LAYER_DATABASES

/**
 * A layer database as the doctor enumerates it.
 */
export interface LayerDatabaseRef {
	id: LayerID
	label: string
	path: string
}

/**
 * The absolute path of one layer database under `dataRoot`.
 */
export function layerDatabasePath(dataRoot: PathBuilderLike, id: LayerID): string {
	const { directory, filename } = LAYER_DATABASES[id]

	return directory(dataRoot)(filename).toString()
}

/**
 * The layer database a reader opens: the one the active selection lists for the
 * layer's role, else its conventional path.
 *
 * Each layer has a serving role of its own, read unscoped.
 * A data root without a selection entry for the role reads the conventional path, as before.
 *
 * @throws {@link UnreadableArtifactError} when the selection or the selected file cannot be read.
 */
export async function resolveLayerDatabasePath(
	dataRoot: PathBuilderLike,
	id: LayerID,
	catalog?: LayerCatalog
): Promise<string> {
	const snapshot = catalog ?? (await LayerCatalog.read(dataRoot))
	const selected = await snapshot.firstPath(LAYER_DATABASES[id].role, { country: null, subdivision: null })

	return selected ?? layerDatabasePath(dataRoot, id)
}

/**
 * Every layer database the session would attach, in a stable order, at the path the session
 * reads: the selected file when the active selection lists one, else the conventional path.
 */
export async function layerDatabases(dataRoot: PathBuilderLike): Promise<LayerDatabaseRef[]> {
	const catalog = await LayerCatalog.read(dataRoot)
	const ids = Object.keys(LAYER_DATABASES) as LayerID[]

	return Promise.all(
		ids.map(async (id) => ({
			id,
			label: LAYER_DATABASES[id].label,
			path: await resolveLayerDatabasePath(dataRoot, id, catalog),
		}))
	)
}

/**
 * The `.db` files in a layer's directory that are not the file the session attaches,
 * so the doctor reads an alternate name as a name mismatch rather than a coverage fact.
 */
export async function layerDatabaseAlternates(dataRoot: PathBuilderLike, id: LayerID): Promise<string[]> {
	const { directory, filename: canonical } = LAYER_DATABASES[id]

	try {
		return (
			await Globerator.files("db", {
				cwd: directory(dataRoot),
				absolute: false,
				recursive: false,
			}).toSorted()
		).filter((name) => name !== canonical)
	} catch {
		return []
	}
}

/**
 * A per-country address-point database the doctor enumerates from disk.
 */
export interface AddressPointDatabaseRef {
	/**
	 * `address-points-<cc>-<slug>`, the file's basename without its extension.
	 */
	id: string
	label: string
	path: string
}

/**
 * Every `address-points-*.db` under `<dataRoot>/db/osm`, sorted by name.
 *
 * The directory holds one database per country, written by `@mailwoman/osm`'s builder
 * from an OpenStreetMap extract or by the G-NAF rooftop build.
 * Each records its own license in its `layer_manifest`, so the doctor reports the
 * file's recorded terms rather than assuming them from the directory.
 *
 * The location comes from core's `databaseRootPath` because `@mailwoman/osm`,
 * which owns the directory, is an optional peer this package cannot import statically.
 *
 * An absent directory yields an empty list: the operator has built no address-point database.
 */
export async function addressPointDatabases(dataRoot: PathBuilderLike): Promise<AddressPointDatabaseRef[]> {
	const directory = databaseRootPath(dataRoot)("osm")

	if (!(await pathExists(directory))) return []

	const names = await Globerator.files("db", { cwd: directory, absolute: false, recursive: false }).toSorted()

	return names
		.filter((name) => name.startsWith("address-points-"))
		.map((name) => {
			const id = name.replace(/\.db$/, "")

			return { id, label: `Address points (${id})`, path: directory(name).toString() }
		})
}
