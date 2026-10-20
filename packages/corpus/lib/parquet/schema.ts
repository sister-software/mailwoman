/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The corpus parquet schema defines its columns and logical types. It also defines the projection from a `LabeledRow`.
 *
 *   Every file in this family agrees on this one definition. A column added here and nowhere else fails to compile
 *   against {@linkcode ParquetRow}, which keeps the writer, the reader and the manifest's `schema` key from drifting
 *   apart.
 *
 *   Compression is `snappy` throughout. PyArrow uses it by default. It is also the standard ML-corpus codec. A reader
 *   outside this repository therefore opens the files without configuration.
 */

import type { LabeledRow } from "#types"

/**
 * Row groups are written at this cadence within a parquet file.
 */
export const ROW_GROUP_SIZE = 50_000

/**
 * Rows per parquet file when a writer's caller names no limit.
 *
 * A file is closed here rather than grown, because `writeParquetFile` materializes
 * one Arrow table and Arrow's list builder raises before a whole source fits:
 * 4,228,212 rows raised where 1,603,143 wrote.
 * The manifest records the value in force as `rows_per_slice`.
 */
export const ROWS_PER_FILE = 1_000_000

/**
 * Snappy is the codec selected for corpus parquet files.
 */
export const PARQUET_COMPRESSION = "SNAPPY"

export interface ParquetFieldDefinition {
	// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- Parquet logical type name.
	type: "UTF8" | "INT32"
	compression: typeof PARQUET_COMPRESSION
	repeated?: boolean
	optional?: boolean
}

export type ParquetSchemaDefinition<T> = Record<Extract<keyof T, string>, ParquetFieldDefinition>

/**
 * A single Parquet row shape.
 *
 * The index signature allows callers to retain source fields before projection.
 *
 * Optional fields are represented as null in the Arrow table and read back as null.
 */
export interface ParquetRow {
	raw: string
	tokens: readonly string[]
	labels: readonly string[]
	span_starts: readonly number[]
	span_ends: readonly number[]
	span_tags: readonly string[]
	country: string
	locale?: string | null
	source: string
	source_id: string
	/**
	 * The SPDX identifier or `LicenseRef-*` id of the source's register inputs,
	 * which every writer stamps from `#source-register/row-license`.
	 *
	 * A file written before the column had this meaning holds the producer's prose here,
	 * and {@linkcode corpusRowFromParquet} passes it through unchanged.
	 */
	license: string
	register?: string | null
	surface: string
	/**
	 * The augmentation that derived the row from the row `base_source_id` names, or `null`.
	 */
	augmentation?: string | null
	base_source_id?: string | null
	[key: string]: unknown
}

/**
 * Column names emitted into every parquet file.
 *
 * Matches `ParquetRow`.
 */
export const PARQUET_COLUMNS = [
	"raw",
	"tokens",
	"labels",
	"span_starts",
	"span_ends",
	"span_tags",
	"country",
	"locale",
	"source",
	"source_id",
	"license",
	"register",
	"surface",
	"augmentation",
	"base_source_id",
] as const

/**
 * The DuckDB type each column is read and written as.
 *
 * Paired with {@linkcode PARQUET_COLUMNS} so a `read_json` column map and a `copy`
 * select list are built from one list rather than two that can disagree.
 */
export const PARQUET_COLUMN_TYPES: Record<(typeof PARQUET_COLUMNS)[number], string> = {
	raw: "VARCHAR",
	tokens: "VARCHAR[]",
	labels: "VARCHAR[]",
	span_starts: "INTEGER[]",
	span_ends: "INTEGER[]",
	span_tags: "VARCHAR[]",
	country: "VARCHAR",
	locale: "VARCHAR",
	source: "VARCHAR",
	source_id: "VARCHAR",
	license: "VARCHAR",
	register: "VARCHAR",
	surface: "VARCHAR",
	augmentation: "VARCHAR",
	base_source_id: "VARCHAR",
}

/* oxlint-disable unicorn/text-encoding-identifier-case -- `"UTF8"` below is a ParquetType enum member rather than a text-encoding identifier. A lowercase spelling does not type-check against ParquetSchemaDefinition.
   The rule cannot distinguish the enum member from a text-encoding identifier. */

/**
 * Parquet schema for `LabeledRow`.
 *
 * Optional fields set `optional: true`.
 * Repeated UTF8 columns capture the tokens and labels arrays.
 */
export const LABELED_ROW_SCHEMA: ParquetSchemaDefinition<ParquetRow> = {
	raw: { type: "UTF8", compression: PARQUET_COMPRESSION },
	tokens: { type: "UTF8", repeated: true, compression: PARQUET_COMPRESSION },
	labels: { type: "UTF8", repeated: true, compression: PARQUET_COMPRESSION },
	// Char-offset label spans, meaning parallel arrays over `raw` in UTF-16 code units. Each span is [start, end) with an exclusive end, sorted and non-overlapping. INT32 holds a short address string and round-trips as `number` where parquetjs INT64 would surface bigint.
	span_starts: { type: "INT32", repeated: true, compression: PARQUET_COMPRESSION },
	span_ends: { type: "INT32", repeated: true, compression: PARQUET_COMPRESSION },
	span_tags: { type: "UTF8", repeated: true, compression: PARQUET_COMPRESSION },
	country: { type: "UTF8", compression: PARQUET_COMPRESSION },
	locale: { type: "UTF8", compression: PARQUET_COMPRESSION, optional: true },
	source: { type: "UTF8", compression: PARQUET_COMPRESSION },
	source_id: { type: "UTF8", compression: PARQUET_COMPRESSION },
	license: { type: "UTF8", compression: PARQUET_COMPRESSION },
	register: { type: "UTF8", compression: PARQUET_COMPRESSION, optional: true },
	surface: { type: "UTF8", compression: PARQUET_COMPRESSION },
	augmentation: { type: "UTF8", compression: PARQUET_COMPRESSION, optional: true },
	base_source_id: { type: "UTF8", compression: PARQUET_COMPRESSION, optional: true },
}

/* oxlint-enable unicorn/text-encoding-identifier-case */

/**
 * Project a labeled row to the Parquet schema.
 *
 * The span triple is required because `alignRow` emits it on every labeled row.
 * A row without it came from a producer that has not migrated.
 *
 * The writer would drop the labels from the file if it wrote that row.
 * A thrown error identifies the row instead.
 */
export function rowToParquet(row: LabeledRow): ParquetRow {
	const { span_starts, span_ends, span_tags } = row

	if (!span_starts || !span_ends || !span_tags) {
		throw new Error(
			`rowToParquet: row is missing the char-offset span triple (#519) — ` +
				`span_starts=${span_starts} span_ends=${span_ends} span_tags=${span_tags} ` +
				`(source=${row.source}, source_id=${row.source_id}). ` +
				`Every parquet-bound row must carry span_starts/span_ends/span_tags; ` +
				`producers that emit tokens/labels only have not migrated to the v0.5.0 format.`
		)
	}

	if (span_starts.length !== span_ends.length || span_starts.length !== span_tags.length) {
		throw new Error(
			`rowToParquet: span triple arrays are not parallel — ` +
				`starts=${span_starts.length} ends=${span_ends.length} tags=${span_tags.length} ` +
				`(source=${row.source}, source_id=${row.source_id})`
		)
	}

	// The runner stamps the adapter's `surface` on every row that omits one, so an absent
	// value here means the row reached parquet by a path that bypassed it.
	// A default would record every such row as the publisher's own string.
	if (!row.surface) {
		throw new Error(
			`rowToParquet: row carries no surface ` +
				`(source=${row.source}, source_id=${row.source_id}). ` +
				`An adapter declares CorpusAdapter.surface and the runner stamps it; ` +
				`a recipe writing rows directly sets the field itself.`
		)
	}

	return {
		raw: row.raw,
		tokens: row.tokens,
		labels: row.labels,
		span_starts,
		span_ends,
		span_tags,
		country: row.country,
		locale: row.locale ?? null,
		source: row.source,
		source_id: row.source_id,
		// The producer's statement, which the writer replaces with the register's id (`stampRowLicense`).
		license: row.license,
		register: row.register ?? null,
		surface: row.surface,
		augmentation: row.augmentation?.name ?? null,
		base_source_id: row.augmentation?.base_source_id ?? null,
	}
}

/**
 * The columns a corpus parquet file written before #2741 carries in place of `augmentation`.
 */
export const RETIRED_PARQUET_COLUMNS = ["corpus_version", "recipe"] as const

/**
 * Read one row of a corpus parquet file of either schema as a {@linkcode ParquetRow}.
 *
 * This is the one place an older file's columns map to the current ones.
 * A v0.7.x file carries `corpus_version`, the run of whichever recipe or build wrote the row,
 * and `recipe`, which held an augmentation name on a row derived from a base row
 * and the producer's own name or template on every other row.
 *
 * Measured over the 1,069 files of `v0.7.10-gb-county`, a `recipe` value is an
 * augmentation exactly where `base_source_id` is set, so that value becomes `augmentation`
 * and every other becomes `null`; the producer is the row's `source`.
 * `corpus_version` is dropped, because the file's record and the manifest name the corpus.
 *
 * `license` passes through unchanged.
 * An older file holds the producer's prose there, which is what the file says,
 * and a writer re-stamps the register's id when the row is written again.
 *
 * Every other column passes through, so a projection of current columns reads the same from both schemas.
 */
export function corpusRowFromParquet(raw: Record<string, unknown>): ParquetRow {
	if (!("recipe" in raw) && !("corpus_version" in raw)) return raw as ParquetRow

	const { recipe, corpus_version: _corpusVersion, ...rest } = raw
	const baseSourceID = rest["base_source_id"]
	const derived = typeof baseSourceID === "string" && baseSourceID !== ""

	return {
		...rest,
		augmentation: derived && typeof recipe === "string" ? recipe : ((rest["augmentation"] as string | null) ?? null),
	} as ParquetRow
}
