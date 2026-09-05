/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where each attached spatial layer lives under the data root. The geocode session opens these paths and
 *   `mailwoman doctor` reports on the same set, so the list has one home: a layer the doctor describes is a layer the
 *   session would attach, and the reverse.
 */

import { readDirectory } from "@mailwoman/core/fs/readers"
import { resolvePath, type PathBuilderLike } from "path-ts"

/**
 * The layer databases the session attaches when present, keyed by the layer's short id, each as the path segments under
 * the data root.
 */
const LAYER_DATABASES = {
	flood: { label: "Flood zones (EA England)", segments: ["flood", "flood.db"] },
	soil: { label: "Soil capability (NRCS SSURGO)", segments: ["soil", "soil.db"] },
	coastal: { label: "Coastal erosion (EA NCERM)", segments: ["coastal", "coastal-england.db"] },
	zoning: { label: "Zoning (Ireland)", segments: ["zoning", "zoning-ireland.db"] },
	poi: { label: "POI layer", segments: ["poi", "poi.db"] },
} as const satisfies Record<string, { label: string; segments: readonly [string, string] }>

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
	return resolvePath(dataRoot, ...LAYER_DATABASES[id].segments)
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
 * The `.db` files in a layer's directory that are NOT the file the session attaches — a build that wrote the artifact
 * under another name (the Iowa soil pilot's `soil-ia.db` beside an expected `soil.db`). The session attaches nothing in
 * that case, and the doctor reports the alternates so the absence reads as a name mismatch rather than a coverage fact.
 * An absent directory answers an empty list.
 */
export async function layerDatabaseAlternates(dataRoot: PathBuilderLike, id: LayerID): Promise<string[]> {
	const [directory, canonical] = LAYER_DATABASES[id].segments

	try {
		return (await readDirectory(resolvePath(dataRoot, directory)))
			.filter((name) => name.endsWith(".db") && name !== canonical)
			.toSorted()
	} catch {
		return []
	}
}
