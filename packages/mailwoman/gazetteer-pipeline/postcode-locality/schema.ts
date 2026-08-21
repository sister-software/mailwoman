/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the `postcode_locality` shards (`postcode-locality-<cc>.db`) — the postcode →
 *   candidate-locality table the resolver's `postcode_area_resolution` strategy attaches.
 *
 *   ONE table, several builds: the European point-in-polygon build and the CJK name/point-match
 *   builds (JP, KR, TW) all emit this shape, which is what lets a single resolver strategy consume
 *   every shard. The DDL therefore lives here rather than in any one builder, so a column added to
 *   the row interface is a compile error against the builder that fills it.
 *
 *   The builders' bulk INSERT stays a POSITIONAL prepared statement for throughput — but its column
 *   list comes from {@link POSTCODE_LOCALITY_COLUMNS} and its table from
 *   {@link createPostcodeLocalityTable}, so the positional order cannot drift from the DDL.
 */

import type { Kysely } from "kysely"

/**
 * One postcode → locality candidate.
 *
 * `is_containing=1` marks the authoritative tier — the locality whose polygon contains the postcode centroid (the
 * polygon builds) or the name-confirmed municipality (the CJK builds). `is_containing=0` rows are the proximity
 * candidates the resolver soft-scores against. `distance_km` is 0 for a containment hit and the haversine distance
 * otherwise. `aliases` is a `|`-joined alt-name list, nullable because the DDL never constrained it.
 */
export interface PostcodeLocalityTable {
	postcode: string
	country: string
	locality_id: number
	locality_name: string
	aliases: string | null
	distance_km: number
	is_containing: number
}

/**
 * Provenance / license / build-statistics key-value pairs. Every shard carries one, and its contents are per-builder.
 */
export interface PostcodeLocalityMetaTable {
	key: string
	value: string | null
}

/**
 * The shard schema for `new DatabaseClient<PostcodeLocalityDatabase>(…)`.
 */
export interface PostcodeLocalityDatabase {
	postcode_locality: PostcodeLocalityTable
	meta: PostcodeLocalityMetaTable
}

/**
 * The slice of a Kysely handle the DDL below touches — the parameter type the builders take.
 */
export type PostcodeLocalitySchemaHandle = Pick<Kysely<PostcodeLocalityDatabase>, "schema">

/**
 * Whether the statement carries `IF NOT EXISTS`.
 *
 * Required, not defaulted: the shards divide into ACCUMULATIVE builds, where one shared database is filled country by
 * country in successive runs and the second run must find the table already there, and single-country REBUILDS, which
 * drop and recreate. Silently defaulting either way turns a mismatched call site into a wrong artifact instead of a
 * compile error.
 */
export interface PostcodeLocalityDDLOptions {
	ifNotExists: boolean
}

/**
 * The `postcode_locality` columns in INSERT order. {@link POSTCODE_LOCALITY_INSERT_SQL} derives its column list and
 * placeholders from this, so a column reordered in the DDL cannot leave the positional INSERT behind.
 */
export const POSTCODE_LOCALITY_COLUMNS = [
	"postcode",
	"country",
	"locality_id",
	"locality_name",
	"aliases",
	"distance_km",
	"is_containing",
] as const satisfies readonly (keyof PostcodeLocalityTable)[]

/**
 * The column tuple's value types, positionally.
 */
type ColumnValues<Columns extends readonly (keyof PostcodeLocalityTable)[]> = {
	-readonly [Index in keyof Columns]: Columns[Index] extends keyof PostcodeLocalityTable
		? PostcodeLocalityTable[Columns[Index]]
		: never
}

/**
 * The positional bind values of one row, in {@link POSTCODE_LOCALITY_COLUMNS} order.
 */
export type PostcodeLocalityInsertValues = ColumnValues<typeof POSTCODE_LOCALITY_COLUMNS>

/**
 * The builders' bulk-load statement — named columns, one placeholder each, both derived from
 * {@link POSTCODE_LOCALITY_COLUMNS}.
 */
export const POSTCODE_LOCALITY_INSERT_SQL = `INSERT INTO postcode_locality (${POSTCODE_LOCALITY_COLUMNS.join(", ")}) VALUES (${POSTCODE_LOCALITY_COLUMNS.map(() => "?").join(", ")})`

/**
 * Create the `postcode_locality` table.
 */
export async function createPostcodeLocalityTable(
	db: PostcodeLocalitySchemaHandle,
	{ ifNotExists }: PostcodeLocalityDDLOptions
): Promise<void> {
	let builder = db.schema.createTable("postcode_locality")

	if (ifNotExists) {
		builder = builder.ifNotExists()
	}

	await builder
		.addColumn("postcode", "text", (c) => c.notNull())
		.addColumn("country", "text", (c) => c.notNull())
		.addColumn("locality_id", "integer", (c) => c.notNull())
		.addColumn("locality_name", "text", (c) => c.notNull())
		.addColumn("aliases", "text")
		.addColumn("distance_km", "real", (c) => c.notNull())
		.addColumn("is_containing", "integer", (c) => c.notNull())
		.execute()
}

/**
 * Create the `(postcode, country)` probe index — the resolver attaches a single shard and country-filters at query
 * time, so both columns lead.
 */
export async function createPostcodeLocalityIndex(
	db: PostcodeLocalitySchemaHandle,
	{ ifNotExists }: PostcodeLocalityDDLOptions
): Promise<void> {
	let builder = db.schema.createIndex("postcode_locality_by_pc")

	if (ifNotExists) {
		builder = builder.ifNotExists()
	}

	await builder.on("postcode_locality").columns(["postcode", "country"]).execute()
}

/**
 * Create the `meta` table.
 */
export async function createPostcodeLocalityMetaTable(
	db: PostcodeLocalitySchemaHandle,
	{ ifNotExists }: PostcodeLocalityDDLOptions
): Promise<void> {
	let builder = db.schema.createTable("meta")

	if (ifNotExists) {
		builder = builder.ifNotExists()
	}

	await builder
		.addColumn("key", "text", (c) => c.primaryKey())
		.addColumn("value", "text")
		.execute()
}
