/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman situs address-points --state VT` — build a per-state ADDRESS-POINT shard (#476) from
 *   the pinned-release Overture Parquet: exact `(street, number)` within a `(postcode | locality)`
 *   scope → exact point. The geocoder's street-level opening move — when the point exists you look
 *   it up; you interpolate (#483) only on miss. This shard is also the gold standard the future
 *   TIGER interpolation is graded against.
 *
 *   Keying uses THE shared normalizer (`@mailwoman/resolver-wof-sqlite/street-normalize`) — the same
 *   function the lookup tier applies at query time. Provenance per row (epic #470 rules): source
 *   dataset + release pinned in-table.
 *
 *   County scoping (#483 density characterization): Overture carries no county field, so an optional
 *   --county-fips filter does a point-in-polygon against the TIGER COUNTY boundary shapefile
 *   (--county-boundary, same TIGER vintage as the EDGES the interpolation shard reads) — keeps a
 *   county-scoped gold comparable to a county-scoped segment table.
 *
 *   Alternate source: --oa-csv builds from OpenAddresses conformed CSV(s) instead of the Overture
 *   parquet, for states Overture's US addresses theme does NOT carry (HI, NH).
 *
 *   Maintainer-only: needs the local parquet/CSV inputs + the @duckdb/node-api dev dep + the optional
 * @mailwoman/resolver-wof-sqlite peer (the shared schema + normalizer). Progress streams to stderr;
 *   the final summary lands on stdout. The build writes to a temp path, then atomically swaps into
 *   place (scripts/AGENTS.md) — the original script rebuilt in place.
 */

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath } from "@mailwoman/core/utils"
import type { AddressPointDatabase } from "@mailwoman/resolver-wof-sqlite/address-point-schema"
import { Box, Text } from "ink"
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { basename, dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../sdk/cli.js"

const OptionsSchema = zod.object({
	state: zod.string().optional().describe("US state abbreviation, e.g. VT"),
	release: zod
		.string()
		.optional()
		.default("2026-05-20.0")
		.describe("Overture release tag (selects the parquet + recorded as provenance)"),
	out: zod.string().optional().describe("Output DB path. Default <data-root>/address-points/address-points-us-<st>.db"),
	countyFips: zod
		.string()
		.optional()
		.describe("5-digit state+county FIPS (e.g. 17031) — point-in-polygon scope against --county-boundary"),
	countyBoundary: zod
		.string()
		.optional()
		.default("/tmp/tiger-county/tl_2023_us_county.shp")
		.describe("TIGER COUNTY boundary shapefile (GEOID = state+county FIPS) for the --county-fips PIP"),
	// ODbL-hygiene: when set, only keep rows whose Overture dataset is in this comma-separated allow-list
	// (case-insensitive). Default absent = keep everything (byte-stable). Typical: --license-filter NAD.
	licenseFilter: zod
		.string()
		.optional()
		.describe("Comma-separated Overture dataset allow-list (case-insensitive); absent = keep all"),
	// DuckDB worker-thread cap for the parquet scan. Default (unset) = DuckDB's default (all cores). The
	// national driver passes a low value so N concurrent state builds don't each grab every core.
	threads: zod.string().optional().describe("DuckDB worker-thread cap (default: all cores)"),
	// Alternate source: comma-separated OpenAddresses conformed-CSV path(s). When set, the shard is built
	// from these instead of the Overture parquet — for states Overture's addresses theme does NOT carry
	// (HI, NH). The CSVs are already state-scoped, so no state/county filter applies; --state still names
	// the output. Same address_point schema + shared normalizer as the Overture path.
	oaCsv: zod
		.string()
		.optional()
		.describe("Comma-separated OpenAddresses conformed-CSV path(s); builds from these instead of Overture"),
})

export { OptionsSchema as options }

/**
 * Scripts/AGENTS.md atomic swap: the build wrote to a temp path, so a mid-build crash never leaves
 * a half-written DB at finalPath. Move any prior version aside, slot the new one in, then drop the
 * old. (The original script rebuilt in place — `rmSync(OUT)` then `new DatabaseSync(OUT)`.)
 */
function swapDatabaseIntoPlace(tmpPath: string, finalPath: string): void {
	const aside = `${finalPath}.old-${process.pid}`
	if (existsSync(finalPath)) renameSync(finalPath, aside)
	for (const sfx of ["-wal", "-shm"]) rmSync(finalPath + sfx, { force: true })
	renameSync(tmpPath, finalPath)
	for (const sfx of ["-wal", "-shm"]) rmSync(tmpPath + sfx, { force: true })
	rmSync(aside, { force: true })
}

const SitusAddressPoints: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [summary, setSummary] = useState<string[]>()

	useEffect(() => {
		void (async () => {
			try {
				// OA mode: build from OpenAddresses CSV(s) rather than the Overture parquet.
				const OA_MODE = Boolean(options.oaCsv)
				if (!options.state) {
					throw new Error("--state required (US state abbreviation, e.g. VT)")
				}
				if (options.countyFips && !/^\d{5}$/.test(options.countyFips)) {
					throw new Error("--county-fips must be a 5-digit state+county FIPS (e.g. 17031)")
				}
				const STATE = options.state.toUpperCase()
				const PARQUET = dataRootPath("overture", options.release, "addresses-us.parquet")
				const finalOut = options.out ?? dataRootPath("address-points", `address-points-us-${STATE.toLowerCase()}.db`)

				// Optional maintainer deps: the shared schema/normalizer (resolver-wof-sqlite, an optional peer)
				// and the DuckDB parquet/CSV reader (@duckdb/node-api, a dev dep). Both dynamic + guarded so the
				// published CLI doesn't force them on every consumer.
				let pointSchema: typeof import("@mailwoman/resolver-wof-sqlite/address-point-schema")
				let streetNormalize: typeof import("@mailwoman/resolver-wof-sqlite/street-normalize")
				try {
					pointSchema = await import("@mailwoman/resolver-wof-sqlite/address-point-schema")
					streetNormalize = await import("@mailwoman/resolver-wof-sqlite/street-normalize")
				} catch {
					throw new Error(
						"situs address-points requires `@mailwoman/resolver-wof-sqlite` to be installed (the shared address-point schema + normalizer)."
					)
				}
				let DuckDBInstance: typeof import("@duckdb/node-api").DuckDBInstance
				try {
					;({ DuckDBInstance } = await import("@duckdb/node-api"))
				} catch {
					throw new Error(
						"@duckdb/node-api is not installed — `situs address-points` is a maintainer-only data command"
					)
				}
				const { ADDRESS_POINT_COLUMNS, createAddressPointTable, createAddressPointIndexes } = pointSchema
				const { canonicalizeRouteKey, normalizeLocalityForKey, normalizeStreetForKey } = streetNormalize

				// Build the dataset allow-list (normalised to lower-case for a case-insensitive match).
				// Empty = no filter (keep everything).
				const allowedDatasets: Set<string> = new Set(
					options.licenseFilter
						? options.licenseFilter
								.split(",")
								.map((d) => d.trim().toLowerCase())
								.filter(Boolean)
						: []
				)

				mkdirSync(dirname(finalOut), { recursive: true })
				// Build into a temp path; atomically swap on success (scripts/AGENTS.md).
				const tmpOut = `${finalOut}.building-${process.pid}.db`
				for (const sfx of ["", "-wal", "-shm"]) rmSync(tmpOut + sfx, { force: true })

				const instance = await DuckDBInstance.create()
				const duck = await instance.connect()
				// Optional thread cap (national driver sets this so concurrent state builds don't oversubscribe cores).
				if (options.threads && /^\d+$/.test(options.threads)) {
					await duck.run(`SET threads TO ${options.threads}`)
				}
				// Optional county scope: PIP against the TIGER COUNTY polygon (GEOID = state+county FIPS).
				// DuckDB hoists the scalar subquery to a constant, so the per-row cost is the containment test.
				let countyFilter = ""
				if (options.countyFips) {
					await duck.run("INSTALL spatial; LOAD spatial;")
					countyFilter = `AND ST_Contains(
							(SELECT geom FROM ST_Read('${options.countyBoundary}') WHERE GEOID = '${options.countyFips}'),
							ST_Point(lon, lat))`
				}
				// License filter: pushed into DuckDB so the parquet scan drops ineligible rows before transfer.
				// lower() matches case-insensitively against our normalised allow-list.
				const datasetFilter =
					allowedDatasets.size > 0
						? `AND lower(sources[1].dataset) IN (${[...allowedDatasets].map((d) => `'${d}'`).join(", ")})`
						: ""

				const db = new DatabaseSync(tmpOut)
				// DDL + column order come from the SHARED schema (address-point-schema) so the writer can't drift
				// from AddressPointSqliteLookup (the reader). The INSERT stays a POSITIONAL prepared statement —
				// tens of millions of rows per state — but its column list is derived from ADDRESS_POINT_COLUMNS.
				db.exec("PRAGMA journal_mode = WAL;")
				const kdb = new DatabaseClient<AddressPointDatabase>({ database: db })
				await createAddressPointTable(kdb)

				const insert = db.prepare(
					`INSERT INTO address_point (${ADDRESS_POINT_COLUMNS.join(", ")})
					 VALUES (${ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`
				)

				// Provenance accounting: per-dataset counts across ALL rows returned by DuckDB (pre-JS drop).
				// When --license-filter is active DuckDB already dropped the ineligible rows, so this reflects the
				// kept set. `totalReturned` feeds the kept-vs-dropped summary below.
				const datasetCounts = new Map<string, number>()
				let kept = 0
				let totalReturned = 0

				// STREAM the parquet scan in DuckDB DataChunks (~2048 rows each) rather than materialising the
				// whole result — a 13.5M-row state (CA/FL/TX) blows the ~4GB V8 heap that way (OOM 2026-06-14).
				// stream()+fetchChunk() keeps JS memory bounded to one chunk; the growing data lives in the
				// on-disk SQLite WAL inside a single transaction.
				const oaCsvList = OA_MODE
					? options
							.oaCsv!.split(",")
							.map((p) => `'${p.trim()}'`)
							.join(", ")
					: ""
				const streamSql = OA_MODE
					? `SELECT
							NUMBER AS number, STREET AS street, NULLIF(trim(UNIT), '') AS unit,
							NULLIF(trim(POSTCODE), '') AS postcode,
							NULLIF(trim(CITY), '') AS locality,
							'openaddresses' AS dataset,
							LAT AS lat, LON AS lon
						FROM read_csv([${oaCsvList}], header = true, all_varchar = true)
						WHERE nullif(trim(STREET), '') IS NOT NULL AND nullif(trim(NUMBER), '') IS NOT NULL`
					: `SELECT
							number, street, unit, postcode,
							coalesce(nullif(trim(address_levels[2].value), ''), nullif(trim(postal_city), '')) AS locality,
							sources[1].dataset AS dataset,
							lat, lon
						FROM read_parquet('${PARQUET}')
						WHERE address_levels[1].value = '${STATE}'
							AND nullif(trim(street), '') IS NOT NULL
							AND nullif(trim(number), '') IS NOT NULL
							${countyFilter}
							${datasetFilter}`
				const stream = await duck.stream(streamSql)
				// A streamed DataChunk carries no column names of its own, so pull them off the result once.
				const colNames = stream.columnNames()
				db.exec("BEGIN")
				for (let chunk = await stream.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await stream.fetchChunk()) {
					const rows = chunk.getRowObjects(colNames) as Record<string, unknown>[]
					for (const r of rows) {
						totalReturned++
						const dataset = String(r.dataset ?? "unknown")
						datasetCounts.set(dataset, (datasetCounts.get(dataset) ?? 0) + 1)

						const streetRaw = String(r.street)
						const streetNorm = normalizeStreetForKey(streetRaw)
						if (!streetNorm) continue
						const lat = Number(r.lat)
						const lon = Number(r.lon)
						if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue // OA rows can carry empty coords
						const locality = r.locality ? normalizeLocalityForKey(String(r.locality)) : null
						insert.run(
							streetNorm,
							canonicalizeRouteKey(streetNorm),
							String(r.number).trim().toLowerCase(),
							r.unit ? String(r.unit).trim().toLowerCase() : null,
							r.postcode ? String(r.postcode).trim() : null,
							locality,
							streetRaw,
							lat,
							lon,
							OA_MODE ? "openaddresses" : `overture:${r.dataset}`,
							OA_MODE ? "openaddresses-latest" : String(options.release)
						)
						kept++
					}
				}
				db.exec("COMMIT")
				console.error(`${totalReturned} ${STATE} rows from ${OA_MODE ? "OpenAddresses" : basename(PARQUET)}`)
				await createAddressPointIndexes(kdb)
				db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
				const stats = db
					.prepare(
						"SELECT count(*) AS n, count(DISTINCT street_norm) AS streets, count(DISTINCT postcode) AS postcodes FROM address_point"
					)
					.get() as Record<string, number>

				// --- Provenance summary --- always emitted so the operator can audit which licenses a shard carries.
				const lines: string[] = [
					`${kept} points → ${finalOut}`,
					`${totalReturned} ${STATE} rows from ${OA_MODE ? "OpenAddresses" : basename(PARQUET)}`,
					`distinct streets: ${stats.streets} · postcodes: ${stats.postcodes}`,
					`provenance (${STATE}, release ${options.release}):`,
				]
				const sortedDatasets = [...datasetCounts.entries()].sort((a, b) => b[1] - a[1])
				for (const [dataset, count] of sortedDatasets) {
					lines.push(`  ${(OA_MODE ? dataset : `overture:${dataset}`).padEnd(28)} ${count.toLocaleString()} rows`)
				}
				if (allowedDatasets.size > 0) {
					// The DuckDB query already excluded non-allowed rows, so totalReturned is the kept count.
					// Run a secondary count (cheap: parquet predicate pushdown on a single column) for the
					// total-minus-kept so the operator can see how much the filter dropped.
					const totalResult = await duck.runAndReadAll(`
						SELECT count(*) AS n
						FROM read_parquet('${PARQUET}')
						WHERE address_levels[1].value = '${STATE}'
							AND nullif(trim(street), '') IS NOT NULL
							AND nullif(trim(number), '') IS NOT NULL
							${countyFilter}
					`)
					const totalUnfiltered = Number((totalResult.getRowObjects()[0] as Record<string, unknown>).n)
					const keptCount = totalReturned
					const droppedCount = totalUnfiltered - keptCount
					lines.push(
						`license-filter: ${[...allowedDatasets].join(", ")} → kept ${keptCount.toLocaleString()} / dropped ${droppedCount.toLocaleString()} (of ${totalUnfiltered.toLocaleString()} total parquet rows for ${STATE})`
					)
				}

				await kdb.destroy() // closes the underlying `db` handle
				swapDatabaseIntoPlace(tmpOut, finalOut)

				setSummary(lines)
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (summary || error) setImmediate(() => process.exit(error ? 1 : 0))
	}, [summary, error])

	if (error) return <Text color="red">✗ {error}</Text>
	if (summary) {
		return (
			<Box flexDirection="column">
				{summary.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}
	return null // progress streams to stderr until the summary lands
}

export default SitusAddressPoints
