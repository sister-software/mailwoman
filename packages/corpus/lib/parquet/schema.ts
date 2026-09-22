/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The corpus parquet schema — the column list, its logical types, and the projection from a `LabeledRow`.
 *
 *   Every file in this family agrees on this one definition. A column added here and nowhere else fails to compile
 *   against {@linkcode ParquetRow}, which is the property that keeps the writer, the reader and the manifest's
 *   `schema` key from drifting apart.
 *
 *   Compression is `snappy` throughout. The Phase 1.5 plan specified `zstd`; parquet-wasm supports snappy, which is
 *   also PyArrow's default and the standard ML-corpus codec. Therefore, a reader outside this repository opens the files
 *   without configuration.
 */

import type { LabeledRow } from "#types"

/**
 * Row groups are written at this cadence within a parquet file.
 */
export const ROW_GROUP_SIZE = 50_000

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
 * The index signature allows callers to carry source fields before projection.
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
	corpus_version: string
	license: string
	synth_method?: string | null
	synth_base_id?: string | null
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
	"corpus_version",
	"license",
	"synth_method",
	"synth_base_id",
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
	corpus_version: "VARCHAR",
	license: "VARCHAR",
	synth_method: "VARCHAR",
	synth_base_id: "VARCHAR",
}

/* oxlint-disable unicorn/text-encoding-identifier-case -- `"UTF8"` below is a ParquetType enum member rather than a text-encoding identifier. Lowercasing it does not type-check against ParquetSchemaDefinition,
   and the rule has no way to tell the two apart. */

/**
 * Parquet schema for `LabeledRow` per #18 §4.
 *
 * Optional fields use `optional: true`; repeated UTF8 columns capture tokens/labels arrays.
 * Compression is per-column snappy.
 */
export const LABELED_ROW_SCHEMA: ParquetSchemaDefinition<ParquetRow> = {
	raw: { type: "UTF8", compression: PARQUET_COMPRESSION },
	tokens: { type: "UTF8", repeated: true, compression: PARQUET_COMPRESSION },
	labels: { type: "UTF8", repeated: true, compression: PARQUET_COMPRESSION },
	// v0.5.0 char-offset label spans (#519): parallel arrays over `raw` (UTF-16 code units, [start, end) exclusive-end, sorted, non-overlapping). INT32 — raw is a short address string, and INT32 round-trips as `number` where parquetjs INT64 would surface bigint.
	span_starts: { type: "INT32", repeated: true, compression: PARQUET_COMPRESSION },
	span_ends: { type: "INT32", repeated: true, compression: PARQUET_COMPRESSION },
	span_tags: { type: "UTF8", repeated: true, compression: PARQUET_COMPRESSION },
	country: { type: "UTF8", compression: PARQUET_COMPRESSION },
	locale: { type: "UTF8", compression: PARQUET_COMPRESSION, optional: true },
	source: { type: "UTF8", compression: PARQUET_COMPRESSION },
	source_id: { type: "UTF8", compression: PARQUET_COMPRESSION },
	corpus_version: { type: "UTF8", compression: PARQUET_COMPRESSION },
	license: { type: "UTF8", compression: PARQUET_COMPRESSION },
	synth_method: { type: "UTF8", compression: PARQUET_COMPRESSION, optional: true },
	synth_base_id: { type: "UTF8", compression: PARQUET_COMPRESSION, optional: true },
}

/* oxlint-enable unicorn/text-encoding-identifier-case */

/**
 * Project a labeled row to the Parquet schema.
 *
 * The span triple is required here (#519): `alignRow` emits it on every labeled row, so a row
 * arriving without it came from a producer that hasn't migrated — writing it would silently
 * drop the v0.5.0 labels from the file (the "builders before parquet = silent loss" hazard).
 * Loud failure, naming the row, instead.
 */
export function rowToParquet(row: LabeledRow): ParquetRow {
	const { span_starts, span_ends, span_tags } = row

	if (span_starts === undefined || span_ends === undefined || span_tags === undefined) {
		throw new Error(
			`rowToParquet: row is missing the char-offset span triple (#519) — ` +
				`span_starts=${span_starts !== undefined} span_ends=${span_ends !== undefined} span_tags=${span_tags !== undefined} ` +
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
		corpus_version: row.corpus_version,
		license: row.license,
		synth_method: row.synth?.method ?? null,
		synth_base_id: row.synth?.base_source_id ?? null,
	}
}
