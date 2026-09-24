/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where each attached spatial layer lives under the data root. The geocode session opens these paths and
 *   `mailwoman doctor` reports on the same set, so the list has one home: a layer the doctor describes is a layer the
 *   session would attach, and the reverse.
 */

import { coastalDatabaseRoot } from "@mailwoman/coastal/paths"
import { floodDatabaseRoot } from "@mailwoman/flood/paths"
import { poiDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { soilDatabaseRoot } from "@mailwoman/soil/paths"
import { zoningDatabaseRoot } from "@mailwoman/zoning/paths"
import type { PathBuilder, PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * The layer databases the session attaches when present, keyed by the layer's short id.
 *
 * Each names its directory through the owning package's `paths` export
 * and the filename the session opens there.
 */
const LAYER_DATABASES = {
	flood: { label: "Flood zones (EA England)", directory: floodDatabaseRoot, filename: "flood.db" },
	soil: { label: "Soil capability (NRCS SSURGO)", directory: soilDatabaseRoot, filename: "soil.db" },
	coastal: { label: "Coastal erosion (EA NCERM)", directory: coastalDatabaseRoot, filename: "coastal-england.db" },
	zoning: { label: "Zoning (Ireland)", directory: zoningDatabaseRoot, filename: "zoning-ireland.db" },
	poi: { label: "POI layer", directory: poiDatabaseRoot, filename: "poi.db" },
} as const satisfies Record<
	string,
	{ label: string; directory: (dataRoot: PathBuilderLike) => PathBuilder; filename: string }
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
 * Every layer database the session would attach, in a stable order.
 */
export function layerDatabases(dataRoot: PathBuilderLike): LayerDatabaseRef[] {
	return (Object.keys(LAYER_DATABASES) as LayerID[]).map((id) => ({
		id,
		label: LAYER_DATABASES[id].label,
		path: layerDatabasePath(dataRoot, id),
	}))
}

/**
 * The `.db` files in a layer's directory that are not the file the session attaches.
 *
 * A build that wrote the artifact under another name
 * (the Iowa soil pilot's `soil-ia.db` beside an expected `soil.db`).
 *
 * The session attaches nothing in that case, and the doctor reports the alternates
 * so the absence reads as a name mismatch rather than a coverage fact.
 * An absent directory answers an empty list.
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
