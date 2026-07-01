/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export { loadSlimWOFDatabase, type LoadSlimOpts } from "./loader.js"
export { WOFWasmPlaceLookup, type WOFWasmPlaceLookupOpts } from "./lookup.js"

// Re-export the shared interface types so callers don't need both packages on the typed path.
export type {
	FindPlaceQuery,
	GeoBbox,
	GeoPoint,
	PlaceCandidate,
	PlaceLookup,
	WOFPlacetype,
} from "@mailwoman/resolver-wof-sqlite"
