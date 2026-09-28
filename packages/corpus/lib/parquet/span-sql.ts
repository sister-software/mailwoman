/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The SQL that reads one component's text out of a corpus row, for a query that runs in DuckDB.
 *
 *   A parquet row stores component offsets in `span_starts` and `span_ends` arrays.
 *   A third array, `span_tags`, identifies each component. The text comes from slicing `raw` at those offsets.
 *   A query that groups or filters by a
 *   component performs that slice in SQL instead of decoding every row in the process.
 *
 *   `holdoutComponents` in `#tools/overlay/split-slice` performs the same read in JavaScript.
 *   The SQL and JavaScript operations use different string indexing. The difference is described below.
 */

/**
 * The text of one component tag, or NULL when the row has no span for it.
 *
 * `list_position` is one-based and answers NULL for an absent tag.
 * `substr` takes a one-based start with a length, so the start is `span_starts[i] + 1`
 * and the length is the span's width.
 *
 * Known limitation and scope.
 * `alignRow` records a span in UTF-16 code units.
 *
 * DuckDB's `substr` counts characters.
 * The two agree for the Basic Multilingual Plane and diverge by one unit per astral character,
 * so a row carrying one slices late by the number of astral characters before the span.
 *
 * In the first 40 train files of `v0.6.0-register-surface`, 6,982 of 40,000,000
 * rows (0.0175%) contain an astral character.
 * Among 11,521,648 US rows, 5,230 (0.0454%) contain one.
 *
 * `𐍀𐍂𐍉𐍆𐌹𐌳𐌰𐌹𐌽𐍃, RHODE ISLAND` read its region as `ND`, taken from `ISLAND`.
 *
 * So this is sound for an aggregate over millions of rows and unsound for a decision about one row.
 * A caller that acts per row narrows with this and confirms with `holdoutComponents`, which
 * slices with JavaScript string semantics and therefore reads the offsets as they were written.
 */
export function componentAtSpanSQL(tag: string, rawColumn = "raw"): string {
	return componentAtIndexSQL(`list_position(span_tags, '${tag}')`, rawColumn)
}

/**
 * The same slice against a span index the caller already computed.
 *
 * A query can hoist `list_position(span_tags, …)` into a subquery column and read it by name.
 * A second evaluation in the projection would run the search twice per row.
 *
 * Every caveat on {@linkcode componentAtSpanSQL} applies here, because this is the expression it builds.
 */
export function componentAtIndexSQL(indexExpression: string, rawColumn = "raw"): string {
	return `CASE WHEN ${indexExpression} IS NULL THEN NULL ELSE substr(${rawColumn}, span_starts[${indexExpression}] + 1, span_ends[${indexExpression}] - span_starts[${indexExpression}]) END`
}
