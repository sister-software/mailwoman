/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export type { FindPlaceQuery, GeoBbox, GeoPoint, PlaceCandidate, PlaceLookup, WofPlacetype } from "./types.js"

export type { AncestorsTable, GeojsonTable, NamesTable, PlaceSearchTable, SprTable, WofDatabase } from "./schema.js"

export { WofSqlitePlaceLookup, type RankingWeights, type WofSqlitePlaceLookupOpts } from "./lookup.js"

export {
	ADDRESS_CONVENTION_TABLE,
	BUILTIN_STRATEGY_NAMES,
	SeedConventionSource,
	WORLD_DEFAULT,
	mergeConventions,
	resolveConvention,
	type Convention,
	type ConventionSource,
	type ResolvedConvention,
	type ScoringWeights,
	type Strategy,
} from "./convention.js"

export { SqliteConventionSource } from "./sqlite-convention-source.js"

export { WofPostcodeLookup, type PostcodePlace } from "./postcode-point-lookup.js"

export {
	PLACE_BBOX_TABLE,
	PLACE_SEARCH_TABLE,
	buildPlaceSearchFts,
	placeBboxExists,
	placeSearchFtsExists,
	type BuildPlaceSearchFtsOpts,
	type BuildPlaceSearchFtsResult,
} from "./fts.js"

export {
	bboxAround,
	geometryContains,
	haversineKm,
	pointInPolygonRings,
	pointInRing,
	type Bbox,
	type GeojsonGeometry,
	type GeojsonMultiPolygon,
	type GeojsonPolygon,
	type GeojsonPosition,
} from "./geo.js"

export { ancestorLineage, PLACETYPE_DEPTH, placetypeDepth, type AncestorPlaceRow } from "./ancestry.js"

export {
	WofReverseGeocoder,
	type ContainmentKind,
	type ReverseGeocodeOpts,
	type ReverseGeocodeResult,
	type WofReverseGeocoderOpts,
} from "./reverse.js"

export {
	deriveSchemaName,
	pickShardForPlacetype,
	resolveShards,
	type ResolvedShard,
	type ShardConfig,
} from "./sharding.js"
export { AddressPointSqliteLookup } from "./address-point.js"
