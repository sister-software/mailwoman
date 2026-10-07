/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The crisp-polygon database opener the geocoder runtime hands to `@mailwoman/react/map`'s declarative overlays. No
 * code here touches React. The resolved-place geometry math lives in `@mailwoman/react/map/geometry`.
 */

import type { PlaceGeometry } from "@mailwoman/react/map/geometry"

/**
 * Id → simplified admin geometry, backed by the lazily-loaded `wof-polygons.db`;
 * async because each read is range-loaded.
 */
export interface PolygonDB {
	get(id: number): Promise<PlaceGeometry | null>
}

/**
 * Open the crisp-polygon DB for range reads: a single `select geom where id=?` walks one B-tree path,
 * so the browser fetches that path's chunks of the 19 MB file rather than the whole thing.
 */
export async function loadPolygonDB(url: string, sqliteRuntimeBaseURL: string): Promise<PolygonDB> {
	const [{ openRangeDatabase }, { makeRangePolygonLookup }] = await Promise.all([
		import("@mailwoman/resolver-wof-wasm/httpvfs/database"),
		import("@mailwoman/resolver-wof-wasm/httpvfs/resolver"),
	])

	const database = await openRangeDatabase(url, sqliteRuntimeBaseURL)
	const lookup = makeRangePolygonLookup(database)

	return {
		get: (id: number) => lookup.get(id) as Promise<PlaceGeometry | null>,
	}
}
