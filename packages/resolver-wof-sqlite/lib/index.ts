/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export type { FindPlaceQuery, GeoBbox, GeoPoint, PlaceCandidate, PlaceLookup, WOFPlacetype } from "#types"

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
} from "#schema"

export { WOFSQLitePlaceLookup, type RankingWeights, type WOFSQLitePlaceLookupOpts } from "#lookup"

export {
	CANDIDATE_ANCESTOR_COLUMNS,
	CANDIDATE_ANCESTOR_TABLE,
	CANDIDATE_INTERVAL_TABLE,
	createCandidateAncestorTable,
	createCandidateIntervalTable,
	intervalContains,
	MAX_ANCESTOR_DEPTH,
} from "#candidate-ancestors-schema"

export type {
	CandidateAncestorsDatabase,
	CandidateAncestorTable,
	CandidateIntervalTable,
	IntervalLabel,
} from "#candidate-ancestors-schema"

export { CANDIDATE_FTS_TABLE, createCandidateFTS } from "#candidate-fts"

export {
	ImportanceIndex,
	IMPORTANCE_JOIN_GATE_KM,
	type ImportanceIndexStats,
	loadImportanceIndex,
} from "#candidate-importance"

export { WOFCandidateTableLookup, type WOFCandidateTableLookupOpts } from "#candidate-lookup"

export {
	COUNTRY_BBOX_TABLE,
	COUNTRY_COVERAGE_TABLE,
	createCountryBBoxTable,
	createCountryCoverageTable,
	readGazetteerCoverageManifest,
	writeGazetteerCoverageManifest,
} from "#coverage-manifest-schema"

export type { CountryBBoxTable, CountryCoverageTable, GazetteerCoverageDatabase } from "#coverage-manifest-schema"
export { SQLiteStreetNameLookup, type SQLiteStreetNameLookupOpts } from "#street/name-lookup"

export {
	GEONAMES_ID_BASE,
	type GeonamesIngestProgress,
	ingestGeonamesAliases,
	purgeGeonamesAliasRange,
} from "#geonames/aliases"

export { GEONAMES_POSTAL_ID_BASE } from "#geonames/postal"

export { ADDRESS_POINT_COLUMNS, createAddressPointIndexes, createAddressPointTable } from "#address/point-schema"
export type { AddressPointDatabase, AddressPointTable } from "#address/point-schema"

export {
	WOFPostalCityAliasLookup,
	type PostalCityAlias,
	type WOFPostalCityAliasLookupOpts,
} from "#postal/city-alias-lookup"

export type { PostalCityAliasDatabase, PostalCityAliasTable } from "#postal/city-alias-schema"

export {
	POSTAL_CITY_CANDIDATE_COLUMNS,
	POSTAL_CITY_CANDIDATE_TABLE,
	createPostalCityCandidateTable,
} from "#postal/city-candidate-schema"

export type { PostalCityCandidateDatabase, PostalCityCandidateTable } from "#postal/city-candidate-schema"

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
} from "#convention/index"

export { SqliteConventionSource } from "#sqlite-convention-source"

export { WOFPostcodeLookup, type PostcodePlace } from "#postcode-point-lookup"

export {
	PLACE_BBOX_TABLE,
	PLACE_SEARCH_TABLE,
	buildPlaceSearchFTS,
	placeBboxExists,
	placeSearchFTSExists,
	type BuildPlaceSearchFTSOpts,
	type BuildPlaceSearchFTSResult,
} from "#fts/index"

export { PLACETYPE_DEPTH, ancestorLineage, placetypeDepth, type AncestorPlaceRow } from "#ancestry/index"

export {
	WOFReverseGeocoder,
	type ContainmentKind,
	type ReverseGeocodeOpts,
	type ReverseGeocodeResult,
	type WOFReverseGeocoderOpts,
} from "#reverse"

export { AddressPointInterpolator } from "#address/point-interpolation"
export { AddressPointSqliteLookup } from "#address/point"

export {
	STREET_CENTROID_COLUMNS,
	createStreetCentroidIndexes,
	createStreetCentroidTable,
} from "#street/centroid-schema"

export type { StreetCentroidDatabase, StreetCentroidTable } from "#street/centroid-schema"
export { StreetCentroidSqliteLookup } from "#street/centroid"

export {
	StreetInterpolator,
	type InterpolatedHit,
	type InterpolationMethod,
	type InterpolationQuery,
} from "#interpolation"

export {
	deriveSchemaName,
	pickExtractForPlacetype,
	resolveExtracts,
	type ResolvedExtract,
	type ExtractConfig,
} from "#extracts"
