/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Overture Places Parquet ingest.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { join, resolvePath } from "path-ts"

import { DEFAULT_RELEASE } from "#gazetteer-pipeline/poi/defaults"

const MIN_CONFIDENCE = 0.85
const S3_GLOB = (release: string) => `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*.parquet`

/**
 * A row of `DESCRIBE SELECT * FROM read_parquet(...)` — just the column name matters for the schema probe.
 */
export interface DescribeColumn {
	column_name: string
}

/**
 * PURE column-choice logic over a `DESCRIBE` result — no DuckDB/network in this function, so it's unit-testable on its
 * own. Overture's places-theme category struct has gone by `taxonomy` (newer) and `categories` (older); prefer
 * `taxonomy.primary` when the column is present.
 */
export function chooseCategoryColumn(
	describeRows: readonly DescribeColumn[]
): "taxonomy.primary" | "categories.primary" {
	return describeRows.some((r) => r.column_name === "taxonomy") ? "taxonomy.primary" : "categories.primary"
}

/**
 * PURE: whether the `brand` STRUCT column is present in this release's places schema.
 */
export function hasBrandColumn(describeRows: readonly DescribeColumn[]): boolean {
	return describeRows.some((r) => r.column_name === "brand")
}

/**
 * The expression pair {@link chooseCountryExpression} resolves — one for the `WHERE`, one for the `SELECT`.
 */
export interface CountryExpression {
	/**
	 * Bare expression to compare against `'<cc>'` in the `WHERE` clause (a column or a struct/list access).
	 */
	filterExpr: string
	/**
	 * The same expression, aliased to `country` for the `SELECT` list.
	 */
	selectExpr: string
}

/**
 * PURE column-choice logic over a `DESCRIBE` result — no DuckDB/network in this function, so it's unit-testable on its
 * own (mirrors {@link chooseCategoryColumn}'s pattern). The Overture places-theme has, as of the 2026-05-20.0 release,
 * NO top-level `country` column (unlike the addresses theme, whose SQL this one is templated from) — country instead
 * lives inside the `addresses` LIST<STRUCT<...>> column. Prefers a top-level `country` column when present (a future
 * release may add one back), falling back to `addresses[1].country` (DuckDB lists are 1-based).
 *
 * Deviation to note at the call site: under the `addresses`-based expression, a row with a NULL/empty `addresses` list
 * has `addresses[1]` evaluate to NULL, so `addresses[1].country = '<cc>'` is NULL (never true) and the row is dropped
 * from every country slice — rows with no address struct are simply excluded from country-filtered ingests. Acceptable
 * for v1; the excluded-row count is visible as the delta between a country slice's row count and an unfiltered
 * `COUNT(*)` over the same Parquet, if this ever needs auditing.
 */
export function chooseCountryExpression(describeRows: readonly DescribeColumn[]): CountryExpression {
	if (describeRows.some((r) => r.column_name === "country")) {
		return { filterExpr: "country", selectExpr: "country" }
	}

	if (describeRows.some((r) => r.column_name === "addresses")) {
		return { filterExpr: "addresses[1].country", selectExpr: "addresses[1].country AS country" }
	}

	throw new Error(
		`ingestPlaces: Overture places schema has neither a top-level "country" column nor an "addresses" column to ` +
			`derive one from. Columns found: ${describeRows.map((r) => r.column_name).join(", ")}`
	)
}

export interface IngestPlacesOptions {
	/**
	 * Pinned Overture release. Default {@link DEFAULT_RELEASE} (the same pin `overture-ingest.tsx` uses).
	 */
	release?: string
	/**
	 * ISO 3166-1 alpha-2 codes to materialize.
	 */
	countries: readonly string[]
	/**
	 * Output root for the per-country Parquet. Default `<data-root>/overture/<release>/places`.
	 */
	out?: string
	/**
	 * Cap rows per country (debug).
	 */
	limit?: number
	onPhase?: (phase: string, detail?: string) => void
}

export interface IngestPlacesResult {
	release: string
	outDir: string
	/**
	 * ISO country code → the local Parquet path materialized for it.
	 */
	countryParquet: Record<string, string>
	categoryColumn: "taxonomy.primary" | "categories.primary"
	hasBrand: boolean
}

/**
 * Overture places-theme ingest: predicate-pushdown per-country COPY into local Parquet, mirroring `overture-ingest.tsx`
 * (lazy DuckDB, `s3_region='us-west-2'`, `threads=4`, `memory_limit='8GB'`). Probes the release's places schema once
 * (`DESCRIBE`) via the PURE {@link chooseCategoryColumn}/{@link hasBrandColumn} before issuing the per-country COPYs.
 */
export async function ingestPlaces(opts: IngestPlacesOptions): Promise<IngestPlacesResult> {
	const release = opts.release ?? DEFAULT_RELEASE
	const outDir = resolvePath(opts.out ?? dataRootPath("overture", release, "places"))
	await makeDirectories(outDir)
	const phase = opts.onPhase ?? (() => {})

	// @duckdb/node-api is an optional peer dep — lazy import so merely loading this module (e.g. via
	// the `poi.tsx` command import graph under `mailwoman --help`) doesn't fault when it's absent.
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()
	const db = await instance.connect()

	await db.run("INSTALL httpfs; LOAD httpfs;")
	await db.run("INSTALL spatial; LOAD spatial;")
	await db.run("SET s3_region='us-west-2';")
	await db.run("SET threads=4;")
	await db.run("SET memory_limit='8GB';")

	const glob = S3_GLOB(release)

	phase("probe", "DESCRIBE places schema")
	const describeResult = await db.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${glob}') LIMIT 1`)

	const describeRows: DescribeColumn[] = describeResult
		.getRowObjects()
		.map((row) => ({ column_name: String(row["column_name"]) }))

	const categoryColumn = chooseCategoryColumn(describeRows)
	const hasBrand = hasBrandColumn(describeRows)
	const countryExpression = chooseCountryExpression(describeRows)

	phase(
		"probe",
		`category column: ${categoryColumn}; brand: ${hasBrand ? "present" : "absent"}; country: ${countryExpression.filterExpr}`
	)

	// brand.wikidata only: the QID is the join key; the row's own name carries the display form.
	// brand.names.primary is deliberately NOT extracted (review 2026-07-18).
	const brandExprs = hasBrand ? "brand.wikidata AS brand_wikidata" : "CAST(NULL AS VARCHAR) AS brand_wikidata"

	const countryParquet: Record<string, string> = {}

	for (const cc of opts.countries) {
		const dest = join(outDir, `places-${cc.toLowerCase()}.parquet`)
		const limitClause = opts.limit ? `LIMIT ${opts.limit}` : ""
		const started = Date.now()

		await db.run(`
			COPY (
				SELECT
					id AS gers_id,
					names.primary AS name,
					${categoryColumn} AS category,
					${brandExprs},
					confidence,
					ST_X(geometry) AS lon,
					ST_Y(geometry) AS lat,
					${countryExpression.selectExpr}
				FROM read_parquet('${glob}', hive_partitioning = 1)
				WHERE ${countryExpression.filterExpr} = '${cc}' AND confidence >= ${MIN_CONFIDENCE}
				${limitClause}
			) TO '${dest}' (FORMAT PARQUET, COMPRESSION SNAPPY)
		`)

		const secs = ((Date.now() - started) / 1000).toFixed(0)
		phase("ingest", `${cc} -> ${dest} (${secs}s)`)
		countryParquet[cc] = dest
	}

	db.closeSync()

	return { release, outDir, countryParquet, categoryColumn, hasBrand }
}
