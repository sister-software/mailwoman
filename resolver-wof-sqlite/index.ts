/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WofPlacetype } from "./types.js"

export type { AncestorsTable, GeojsonTable, NamesTable, PlaceSearchTable, SprTable, WofDatabase } from "./schema.js"

export { WofSqlitePlaceLookup, type RankingWeights, type WofSqlitePlaceLookupOpts } from "./lookup.js"

export {
	PLACE_SEARCH_TABLE,
	buildPlaceSearchFts,
	placeSearchFtsExists,
	type BuildPlaceSearchFtsOpts,
	type BuildPlaceSearchFtsResult,
} from "./fts.js"
