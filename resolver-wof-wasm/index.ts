/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export { loadSlimWofDatabase, type LoadSlimOpts } from "./loader.js"
export { WofWasmPlaceLookup, type WofWasmPlaceLookupOpts } from "./lookup.js"

// Re-export the shared interface types so callers don't need both packages on the typed path.
export type {
	FindPlaceQuery,
	GeoBbox,
	GeoPoint,
	PlaceCandidate,
	PlaceLookup,
	WofPlacetype,
} from "@mailwoman/resolver-wof-sqlite"
