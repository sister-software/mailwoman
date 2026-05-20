/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export type { FindPlaceQuery, GeoBbox, GeoPoint, PlaceCandidate, PlaceLookup, WofPlacetype } from "./types.js"

export type { AncestorsTable, GeojsonTable, NamesTable, PlaceSearchTable, SprTable, WofDatabase } from "./schema.js"

export { WofSqlitePlaceLookup, type RankingWeights, type WofSqlitePlaceLookupOpts } from "./lookup.js"

export {
	PLACE_BBOX_TABLE,
	PLACE_SEARCH_TABLE,
	buildPlaceSearchFts,
	placeBboxExists,
	placeSearchFtsExists,
	type BuildPlaceSearchFtsOpts,
	type BuildPlaceSearchFtsResult,
} from "./fts.js"

export { bboxAround, haversineKm, type Bbox } from "./geo.js"
