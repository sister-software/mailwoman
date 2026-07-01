/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export type { FindPlaceQuery, GeoBbox, GeoPoint, PlaceCandidate, PlaceLookup, WOFPlacetype } from "./types.js"

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
} from "./schema.js"

export { WOFSqlitePlaceLookup, type RankingWeights, type WOFSqlitePlaceLookupOpts } from "./lookup.js"

export { CANDIDATE_FTS_TABLE, createCandidateFTS } from "./candidate-fts.js"
export { WOFCandidateTableLookup, type WOFCandidateTableLookupOpts } from "./candidate-lookup.js"

export { GEONAMES_ID_BASE, ingestGeonamesAliases, type GeonamesIngestProgress } from "./geonames-aliases.js"

export { ADDRESS_POINT_COLUMNS, createAddressPointIndexes, createAddressPointTable } from "./address-point-schema.js"
export type { AddressPointDatabase, AddressPointTable } from "./address-point-schema.js"
export {
	WOFPostalCityAliasLookup,
	type PostalCityAlias,
	type WOFPostalCityAliasLookupOpts,
} from "./postal-city-alias-lookup.js"
export type { PostalCityAliasDatabase, PostalCityAliasTable } from "./postal-city-alias-schema.js"
export {
	POSTAL_CITY_CANDIDATE_COLUMNS,
	POSTAL_CITY_CANDIDATE_TABLE,
	createPostalCityCandidateTable,
} from "./postal-city-candidate-schema.js"
export type { PostalCityCandidateDatabase, PostalCityCandidateTable } from "./postal-city-candidate-schema.js"

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

export { WOFPostcodeLookup, type PostcodePlace } from "./postcode-point-lookup.js"

export {
	PLACE_BBOX_TABLE,
	PLACE_SEARCH_TABLE,
	buildPlaceSearchFTS,
	placeBboxExists,
	placeSearchFTSExists,
	type BuildPlaceSearchFTSOpts,
	type BuildPlaceSearchFTSResult,
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

export { PLACETYPE_DEPTH, ancestorLineage, placetypeDepth, type AncestorPlaceRow } from "./ancestry.js"

export {
	WOFReverseGeocoder,
	type ContainmentKind,
	type ReverseGeocodeOpts,
	type ReverseGeocodeResult,
	type WOFReverseGeocoderOpts,
} from "./reverse.js"

export { AddressPointInterpolator } from "./address-point-interpolation.js"
export { AddressPointSqliteLookup } from "./address-point.js"
export {
	StreetInterpolator,
	type InterpolatedHit,
	type InterpolationMethod,
	type InterpolationQuery,
} from "./interpolation.js"
export {
	deriveSchemaName,
	pickShardForPlacetype,
	resolveShards,
	type ResolvedShard,
	type ShardConfig,
} from "./sharding.js"
