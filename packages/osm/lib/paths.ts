/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the national rooftop databases this package builds and serves live
 *   under the data root's `db/` group, and where each Geofabrik extract they are built from is kept.
 */

import { assertVintage, databaseRootPath, dataRootPath, snapshotSourcesRoot } from "@mailwoman/core/data-root"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * `<dataRoot>/db/osm`.
 */
export function osmDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("osm")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/osm`, read when a path is requested.
 *
 * @see {@link osmDatabaseRoot} for another data root.
 */
export const osmDatabasePath: PathBuilder = osmDatabaseRoot(dataRootPath())

/**
 * The snapshot source that holds every Geofabrik extract.
 */
export const GEOFABRIK_SNAPSHOT_SOURCE = "geofabrik"

/**
 * One segment of a Geofabrik region path, such as `north-america` or `ile-de-france`.
 */
const REGION_SEGMENT = /^[a-z0-9][a-z0-9-]*$/u

/**
 * The segments of a Geofabrik region path, such as `["europe", "germany"]` for `europe/germany`.
 *
 * @throws When the path is empty or a segment is not a lowercase Geofabrik name.
 */
export function splitGeofabrikPath(region: string): string[] {
	const segments = region.replaceAll(/^\/+|\/+$/g, "").split("/")

	if (!segments.every((segment) => REGION_SEGMENT.test(segment))) {
		throw new Error(`"${region}" is not a Geofabrik region path, such as europe/germany`)
	}

	return segments
}

/**
 * The file name a region's extract takes inside a vintage: `germany.osm.pbf` for `europe/germany`.
 */
export function geofabrikExtractFileName(region: string): string {
	return `${splitGeofabrikPath(region).at(-1)}.osm.pbf`
}

/**
 * The directory holding every vintage of one region's extract, `<snapshotRoot>/geofabrik/<region>/`.
 *
 * Each region has its own vintages, because a vintage is written whole and never reopened,
 * and Geofabrik serves the same `Last-Modified` date for two regions fetched in separate runs.
 *
 * @param snapshotRoot The root every snapshot source sits under.
 * @defaultValue `snapshotSourcesRoot()`, `$MAILWOMAN_DATA_ROOT/snapshots/`
 */
export function geofabrikSnapshotDirectory(
	region: string,
	snapshotRoot: PathBuilderLike = snapshotSourcesRoot()
): PathBuilder {
	return PathBuilder.from(snapshotRoot)(GEOFABRIK_SNAPSHOT_SOURCE, ...splitGeofabrikPath(region))
}

/**
 * The extract of `region` in one vintage, such
 * as `$MAILWOMAN_DATA_ROOT/snapshots/geofabrik/europe/germany/2026-10-17/germany.osm.pbf`.
 *
 * Its receipt sits beside it at `<extract>.receipt.json`.
 *
 * @throws When `vintage` is not one path segment a vintage can take.
 */
export function geofabrikExtractPath(
	region: string,
	vintage: string,
	snapshotRoot: PathBuilderLike = snapshotSourcesRoot()
): PathBuilder {
	assertVintage(vintage)

	return geofabrikSnapshotDirectory(region, snapshotRoot)(vintage, geofabrikExtractFileName(region))
}
