/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export type { FindPlaceQuery, GeoBbox, GeoPoint, PlaceCandidate, PlaceLookup, WOFPlacetype } from "./types.ts"

export type {
	AncestorsTable,
	CoincidentRolesTable,
	ConcordancesTable,
	GeojsonTable,
	NamesTable,
	PlaceAbbrTable,
	PlacePopulationTable,
	PlaceSearchTable,
	SprTable,
	WOFDatabase,
} from "./schema.ts"

export { WOFSqlitePlaceLookup, type RankingWeights, type WOFSqlitePlaceLookupOpts } from "./lookup.ts"

export { CANDIDATE_FTS_TABLE, createCandidateFTS } from "./candidate-fts.ts"
export { WOFCandidateTableLookup, type WOFCandidateTableLookupOpts } from "./candidate-lookup.ts"

export { GEONAMES_ID_BASE, ingestGeonamesAliases, type GeonamesIngestProgress } from "./geonames-aliases.ts"

export { ADDRESS_POINT_COLUMNS, createAddressPointIndexes, createAddressPointTable } from "./address-point-schema.ts"
export type { AddressPointDatabase, AddressPointTable } from "./address-point-schema.ts"
export {
	WOFPostalCityAliasLookup,
	type PostalCityAlias,
	type WOFPostalCityAliasLookupOpts,
} from "./postal-city-alias-lookup.ts"
export type { PostalCityAliasDatabase, PostalCityAliasTable } from "./postal-city-alias-schema.ts"
export {
	POSTAL_CITY_CANDIDATE_COLUMNS,
	POSTAL_CITY_CANDIDATE_TABLE,
	createPostalCityCandidateTable,
} from "./postal-city-candidate-schema.ts"
export type { PostalCityCandidateDatabase, PostalCityCandidateTable } from "./postal-city-candidate-schema.ts"

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
} from "./convention.ts"

export { SqliteConventionSource } from "./sqlite-convention-source.ts"

export { WOFPostcodeLookup, type PostcodePlace } from "./postcode-point-lookup.ts"

export {
	PLACE_BBOX_TABLE,
	PLACE_SEARCH_TABLE,
	buildPlaceSearchFTS,
	placeBboxExists,
	placeSearchFTSExists,
	type BuildPlaceSearchFTSOpts,
	type BuildPlaceSearchFTSResult,
} from "./fts.ts"

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
} from "./geo.ts"

export { PLACETYPE_DEPTH, ancestorLineage, placetypeDepth, type AncestorPlaceRow } from "./ancestry.ts"

export {
	WOFReverseGeocoder,
	type ContainmentKind,
	type ReverseGeocodeOpts,
	type ReverseGeocodeResult,
	type WOFReverseGeocoderOpts,
} from "./reverse.ts"

export { AddressPointInterpolator } from "./address-point-interpolation.ts"
export { AddressPointSqliteLookup } from "./address-point.ts"
export {
	STREET_CENTROID_COLUMNS,
	createStreetCentroidIndexes,
	createStreetCentroidTable,
} from "./street-centroid-schema.ts"
export type { StreetCentroidDatabase, StreetCentroidTable } from "./street-centroid-schema.ts"
export { StreetCentroidSqliteLookup } from "./street-centroid.ts"
export {
	StreetInterpolator,
	type InterpolatedHit,
	type InterpolationMethod,
	type InterpolationQuery,
} from "./interpolation.ts"
export {
	deriveSchemaName,
	pickShardForPlacetype,
	resolveShards,
	type ResolvedShard,
	type ShardConfig,
} from "./sharding.ts"
