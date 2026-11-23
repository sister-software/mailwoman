// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WOFPlacetype } from "#lookup/types"

export type {
	AncestorsTable,
	ConcordancesTable,
	GeojsonTable,
	NamesTable,
	PlaceAbbrTable,
	PlacePopulationTable,
	PlaceSearchTable,
	SprTable,
	WOFDatabase,
} from "#schema"

export { WOFSQLitePlaceLookup, type WOFSQLitePlaceLookupOpts } from "#lookup"
export { type RankingWeights } from "#ranking/weights"

export {
	CANDIDATE_ANCESTOR_COLUMNS,
	CANDIDATE_ANCESTOR_TABLE,
	CANDIDATE_INTERVAL_TABLE,
	createCandidateAncestorTable,
	createCandidateIntervalTable,
	intervalContains,
	MAX_ANCESTOR_DEPTH,
} from "#candidate/ancestors/schema"

export type {
	CandidateAncestorsDatabase,
	CandidateAncestorTable,
	CandidateIntervalTable,
	IntervalLabel,
} from "#candidate/ancestors/schema"

export { CANDIDATE_FTS_TABLE, createCandidateFTS } from "#candidate/fts"

export {
	ImportanceIndex,
	IMPORTANCE_JOIN_RADIUS_KM,
	type ImportanceIndexStats,
	loadImportanceIndex,
} from "#candidate/importance"

export { WOFCandidateTableLookup, type WOFCandidateTableLookupOpts } from "#candidate/lookup"

export {
	COUNTRY_BBOX_TABLE,
	COUNTRY_COVERAGE_TABLE,
	createCountryBBoxTable,
	createCountryCoverageTable,
	readGazetteerCoverageManifest,
	writeGazetteerCoverageManifest,
} from "#candidate/coverage-manifest"

export type { CountryBBoxTable, CountryCoverageTable, GazetteerCoverageDatabase } from "#candidate/coverage-manifest"
export { SQLiteStreetNameLookup, type SQLiteStreetNameLookupOpts } from "#labels/street/name-lookup"

export { type GeonamesIngestProgress, ingestGeonamesAliases, purgeGeonamesAliasRange } from "#geonames/aliases"

export { ADDRESS_POINT_COLUMNS, createAddressPointIndexes, createAddressPointTable } from "#address/point/schema"
export type { AddressPointDatabase, AddressPointTable } from "#address/point/schema"

export {
	WOFPostalCityAliasLookup,
	type PostalCityAlias,
	type WOFPostalCityAliasLookupOpts,
} from "#labels/locality/postal-city/alias/lookup"

export type { PostalCityAliasDatabase, PostalCityAliasTable } from "#labels/locality/postal-city/alias/schema"

export {
	POSTAL_CITY_CANDIDATE_COLUMNS,
	POSTAL_CITY_CANDIDATE_TABLE,
	createPostalCityCandidateTable,
} from "#labels/locality/postal-city/candidate-schema"

export type {
	PostalCityCandidateDatabase,
	PostalCityCandidateTable,
} from "#labels/locality/postal-city/candidate-schema"

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
} from "#convention"

export { SqliteConventionSource } from "#sqlite/convention-source"

export { WOFPostcodeLookup } from "#lookup/postcode-point"

export {
	PLACE_BBOX_TABLE,
	PLACE_SEARCH_TABLE,
	buildPlaceSearchFTS,
	placeBboxExists,
	placeSearchFTSExists,
	type BuildPlaceSearchFTSOpts,
	type BuildPlaceSearchFTSResult,
} from "#fts"

export { PLACETYPE_DEPTH, ancestorLineage, placetypeDepth, type AncestorPlaceRow } from "#ancestry"

export {
	WOFReverseGeocoder,
	type ContainmentKind,
	type ReverseGeocodeOpts,
	type ReverseGeocodeResult,
	type WOFReverseGeocoderOpts,
} from "#lookup/reverse"

export { AddressPointInterpolator } from "#address/point/interpolation"
export { AddressPointSqliteLookup } from "#address/point"
export { openAddressLayerLookup } from "#address/keys/open"
export { readLatestAddressLayerManifest, readLatestAddressLayerManifests } from "#address/keys/layout"

export {
	STREET_CENTROID_COLUMNS,
	createStreetCentroidIndexes,
	createStreetCentroidTable,
} from "#labels/street/centroid/schema"

export type { StreetCentroidDatabase, StreetCentroidTable } from "#labels/street/centroid/schema"
export { StreetCentroidSqliteLookup } from "#labels/street/centroid"

export {
	StreetInterpolator,
	type InterpolatedHit,
	type InterpolationMethod,
	type InterpolationQuery,
} from "#labels/street/interpolation"

export {
	deriveSchemaName,
	pickExtractForPlacetype,
	resolveExtracts,
	type ResolvedExtract,
	type ExtractConfig,
} from "#lookup/extracts"
