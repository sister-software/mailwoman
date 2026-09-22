/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The SQL that reads one component's text out of a corpus row, for a query that runs in DuckDB.
 *
 *   A parquet row carries no `components` map. Each component's text is `raw` sliced at the offsets the
 *   parallel `span_starts` / `span_ends` / `span_tags` triple records, and a query that groups or filters
 *   by a component has to do that slice in SQL rather than row by row in the process.
 *
 *   `holdoutComponents` in `#tools/overlay/split-slice` is the same read in JavaScript. The two are not
 *   interchangeable, and the difference is stated below rather than left for a reader to find twice.
 */

/**
 * The text of one component tag, or NULL when the row carries no span for it.
 *
 * `list_position` is one-based and answers NULL for an absent tag.
 * `substr` takes a one-based start with a length, so the start is `span_starts[i] + 1`
 * and the length is the span's width.
 *
 * WHAT THIS GETS WRONG, AND WHEN.
 * `alignRow` records a span in UTF-16 code units.
 *
 * DuckDB's `substr` counts characters.
 * The two agree for the Basic Multilingual Plane and diverge by one unit per astral character,
 * so a row carrying one slices late by the number of astral characters before the span.
 *
 * Measured over the first 40 train files of `v0.6.0-register-surface`, 40,000,000 rows: 6,982 rows
 * carry an astral character, which is 0.0175%, and 5,230 of 11,521,648 US rows, which is 0.0454%.
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
 * A query that hoists `list_position(span_tags, …)` into a subquery column reads it by name,
 * and recomputing it in the projection would evaluate the search twice per row.
 * Every caveat on {@linkcode componentAtSpanSQL} applies here, because this is the expression it builds.
 */
export function componentAtIndexSQL(indexExpression: string, rawColumn = "raw"): string {
	return `CASE WHEN ${indexExpression} IS NULL THEN NULL ELSE substr(${rawColumn}, span_starts[${indexExpression}] + 1, span_ends[${indexExpression}] - span_starts[${indexExpression}]) END`
}
