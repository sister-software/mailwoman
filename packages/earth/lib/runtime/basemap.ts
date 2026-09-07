/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The crisp-polygon database opener the geocoder runtime hands to `@mailwoman/react/map`'s declarative overlays.
 *   Nothing here touches React; the resolved-place geometry math lives in `@mailwoman/react/map/geometry`.
 */

/**
 * A GeoJSON Polygon / MultiPolygon: what the polygon DB stores and the map draws as the place outline.
 */
export type PlaceGeometry =
	| { type: "Polygon"; coordinates: number[][][] }
	| { type: "MultiPolygon"; coordinates: number[][][][] }

/**
 * Id → simplified admin geometry, backed by the lazily-loaded `wof-polygons.db`. Async (range-loaded).
 */
export interface PolygonDB {
	get(id: number): Promise<PlaceGeometry | null>
}

/**
 * Open the crisp-polygon DB via sql.js-httpvfs: a single `SELECT geom WHERE id=?` touches about one page, so the
 * browser fetches a few KB of the 19 MB file rather than the whole thing. The same range-load path as the resolver DB.
 */
export async function loadPolygonDB(url: string, sqljsBaseURL: string): Promise<PolygonDB> {
	const { loadHTTPVFSDatabase, makeHTTPVFSPolygonLookup } =
		await import("@mailwoman/resolver-wof-wasm/httpvfs/resolver")

	const worker = await loadHTTPVFSDatabase(url, sqljsBaseURL)
	const lookup = makeHTTPVFSPolygonLookup(worker)

	return {
		get: (id: number) => lookup.get(id) as Promise<PlaceGeometry | null>,
	}
}
