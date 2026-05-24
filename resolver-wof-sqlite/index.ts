// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

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

export {
	deriveSchemaName,
	pickShardForPlacetype,
	resolveShards,
	type ResolvedShard,
	type ShardConfig,
} from "./sharding.js"
