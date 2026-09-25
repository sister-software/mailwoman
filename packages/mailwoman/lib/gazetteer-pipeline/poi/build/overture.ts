/**
 * @copyright Sister Software
 * @license AGPL-3.0
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { PathBuilder } from "path-ts"

import { DEFAULT_RELEASE } from "#gazetteer-pipeline/poi/defaults"

const MIN_CONFIDENCE = 0.85
const S3_GLOB = (release: string) => `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*.parquet`

/**
 * Describes one row of a DuckDB `DESCRIBE` result, of which the schema probe reads only the column name.
 */
export interface DescribeColumn {
	column_name: string
}

/**
 * Chooses the Overture places category column, preferring `taxonomy.primary`
 * when the release has a `taxonomy` column and falling back to `categories.primary`.
 */
export function chooseCategoryColumn(
	describeRows: readonly DescribeColumn[]
): "taxonomy.primary" | "categories.primary" {
	return describeRows.some((r) => r.column_name === "taxonomy") ? "taxonomy.primary" : "categories.primary"
}

/**
 * Pure: whether the `brand` struct column is present in this release's places schema.
 */
export function hasBrandColumn(describeRows: readonly DescribeColumn[]): boolean {
	return describeRows.some((r) => r.column_name === "brand")
}

/**
 * The expression pair {@link chooseCountryExpression} resolves — one for the `where`, one for the `select`.
 */
export interface CountryExpression {
	/**
	 * The bare column or struct access compared against the country code in the `WHERE` clause.
	 */
	filterExpr: string

	/**
	 * The same expression aliased to `country` for the `SELECT` list.
	 */
	selectExpr: string
}

/**
 * Chooses the SQL expressions that filter and select a place's country, preferring a
 * top-level `country` column and falling back to `addresses[1].country`.
 *
 * Under the fallback, a place with no `addresses` entry has a NULL country
 * and is excluded from every per-country ingest.
 *
 * @throws If the schema has neither column.
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

/**
 * Configures {@link ingestPlaces}: the Overture release, the countries to copy,
 * the output directory and an optional per-country row limit.
 */
export interface IngestPlacesOptions {
	/**
	 * The pinned Overture release, defaulting to {@link DEFAULT_RELEASE}.
	 */
	release?: string

	/**
	 * The ISO 3166-1 alpha-2 codes to copy, compared verbatim against Overture's country values.
	 */
	countries: readonly string[]

	/**
	 * The output directory for the per-country Parquet files, defaulting
	 * to `<data-root>/overture/<release>/places`.
	 */
	out?: string

	/**
	 * Caps the rows copied per country, for debugging.
	 */
	limit?: number
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * Describes the per-country Parquet files {@link ingestPlaces} wrote
 * and the schema choices it made for the release.
 */
export interface IngestPlacesResult {
	release: string
	outDir: string

	/**
	 * Maps each requested country code to the Parquet file written for it.
	 */
	countryParquet: Record<string, string>
	categoryColumn: "taxonomy.primary" | "categories.primary"
	hasBrand: boolean
}

/**
 * Copies Overture places at or above the confidence floor into one local Parquet
 * file per country, probing the release schema first.
 */
export async function ingestPlaces(opts: IngestPlacesOptions): Promise<IngestPlacesResult> {
	const release = opts.release ?? DEFAULT_RELEASE
	const outDir = PathBuilder.from(opts.out ?? dataRootPath("overture", release, "places"))
	await makeDirectories(outDir)
	const phase = opts.onPhase ?? (() => {})

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

	const brandExprs = hasBrand ? "brand.wikidata AS brand_wikidata" : "CAST(NULL AS VARCHAR) AS brand_wikidata"

	const countryParquet: Record<string, string> = {}

	for (const cc of opts.countries) {
		const dest = outDir(`places-${cc.toLowerCase()}.parquet`).toString()
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

	return { release, outDir: outDir.toString(), countryParquet, categoryColumn, hasBrand }
}
