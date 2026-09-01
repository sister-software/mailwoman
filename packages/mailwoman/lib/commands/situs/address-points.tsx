/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman situs address-points --state VT` — build a per-state ADDRESS-POINT database (#476) from
 *   the pinned-release Overture Parquet: exact `(street, number)` within a `(postcode | locality)`
 *   scope → exact point. The geocoder's street-level opening move — when the point exists you look
 *   it up; you interpolate (#483) only on miss. This database is also the gold standard the future
 *   TIGER interpolation is graded against.
 *
 *   Keying uses THE shared normalizer (`@mailwoman/resolver-wof-sqlite/street-normalize`) — the same
 *   function the lookup tier applies at query time. Provenance per row (epic #470 rules): source
 *   dataset + release pinned in-table.
 *
 *   County scoping (#483 density characterization): Overture carries no county field, so an optional
 *   --county-fips filter does a point-in-polygon against the TIGER COUNTY boundary shapefile
 *   (--county-boundary, same TIGER vintage as the EDGES the interpolation database reads) — keeps a
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

import { removePathIfPresent, makeDirectories } from "@mailwoman/core/fs/writers"
import type { AddressPointDatabase } from "@mailwoman/resolver-wof-sqlite/address"
import { Box, Text } from "ink"
import { basename, dirname, resolvePath } from "path-ts"

import {
	CommandError,
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	splitList,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "address-points",
	description: "Build a state address-point database",
	options: {
		state: { type: "string", required: true, description: "US state abbreviation" },
		release: { type: "string", default: "2026-05-20.0", description: "Overture release" },
		out: { type: "string", description: "Output DB path" },
		"county-fips": { type: "string", validate: (v: string) => /^\d{5}$/u.test(v), description: "County FIPS" },
		"county-boundary": { type: "string", description: "TIGER county boundary shapefile" },
		"license-filter": { type: "string", description: "Dataset allow-list" },
		threads: { type: "string", description: "DuckDB thread cap" },
		"oa-csv": { type: "string", description: "OpenAddresses CSV paths" },
	},
} as const satisfies CommandSpec

interface Options {
	state: string
	release: string
	out?: string
	countyFips?: string
	countyBoundary?: string
	licenseFilter?: string
	threads?: string
	oaCSV?: string
}

const SitusAddressPoints: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { DatabaseClient } = await import("@mailwoman/sqlite/client")
		const { dataRootPath } = await import("@mailwoman/core/utils")
		const { swapDatabaseIntoPlace } = await import("@mailwoman/sqlite/sealed-db")

		// OA mode: build from OpenAddresses CSV(s) rather than the Overture parquet.
		const OA_MODE = Boolean(options.oaCSV)

		if (!options.state) {
			throw new CommandError("--state required (US state abbreviation, e.g. VT)")
		}

		if (options.countyFips && !/^\d{5}$/.test(options.countyFips)) {
			throw new CommandError("--county-fips must be a 5-digit state+county FIPS (e.g. 17031)")
		}

		if (options.countyFips && !options.countyBoundary) {
			throw new CommandError(
				"--county-fips requires --county-boundary (the TIGER COUNTY shapefile to point-in-polygon against)"
			)
		}

		const STATE = options.state.toUpperCase()
		const PARQUET = dataRootPath("overture", options.release, "addresses-us.parquet")

		const finalOut = resolvePath(
			options.out ?? dataRootPath("address-points", `address-points-us-${STATE.toLowerCase()}.db`)
		)

		// Optional maintainer deps: the shared schema/normalizer (resolver-wof-sqlite, an optional peer)
		// and the DuckDB parquet/CSV reader (@duckdb/node-api, a dev dep). Both dynamic + guarded so the
		// published CLI doesn't force them on every consumer.
		let pointSchema: typeof import("@mailwoman/resolver-wof-sqlite/address")
		let streetNormalize: typeof import("@mailwoman/resolver-wof-sqlite/street")

		try {
			pointSchema = await import("@mailwoman/resolver-wof-sqlite/address")
			streetNormalize = await import("@mailwoman/resolver-wof-sqlite/street")
		} catch {
			throw new CommandError(
				"situs address-points requires `@mailwoman/resolver-wof-sqlite` to be installed (the shared address-point schema + normalizer)."
			)
		}

		let DuckDBInstance: typeof import("@duckdb/node-api").DuckDBInstance

		try {
			;({ DuckDBInstance } = await import("@duckdb/node-api"))
		} catch {
			throw new CommandError(
				"@duckdb/node-api is not installed — `situs address-points` is a maintainer-only data command"
			)
		}

		const { ADDRESS_POINT_COLUMNS, createAddressPointTable, createAddressPointIndexes } = pointSchema
		const { canonicalizeRouteKey, normalizeLocalityForKey, normalizeStreetForKey } = streetNormalize

		// Build the dataset allow-list (normalised to lower-case for a case-insensitive match).
		// Empty = no filter (keep everything).
		const allowedDatasets: Set<string> = new Set(splitList(options.licenseFilter).map((d) => d.toLowerCase()))

		await makeDirectories(dirname(finalOut))
		// Build into a temp path; atomically swap on success (scripts/AGENTS.md).
		const tmpOut = `${finalOut}.building-${process.pid}.db`

		for (const sfx of ["", "-wal", "-shm"]) {
			await removePathIfPresent(tmpOut + sfx)
		}

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
		const datasetFilter = allowedDatasets.size
			? `AND lower(sources[1].dataset) IN (${[...allowedDatasets].map((d) => `'${d}'`).join(", ")})`
			: ""

		const kdb = new DatabaseClient<AddressPointDatabase>(tmpOut)
		// DDL + column order come from the SHARED schema (address-point-schema) so the writer can't drift
		// from AddressPointSqliteLookup (the reader). The INSERT stays a POSITIONAL prepared statement —
		// tens of millions of rows per state — but its column list is derived from ADDRESS_POINT_COLUMNS.
		kdb.exec("PRAGMA journal_mode = WAL;")

		await createAddressPointTable(kdb)

		const insert = kdb.prepare(
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
		const oaCSVList = OA_MODE
			? splitList(options.oaCSV)
					.map((p) => `'${p}'`)
					.join(", ")
			: ""

		const streamSQL = OA_MODE
			? `SELECT
							NUMBER AS number, STREET AS street, NULLIF(trim(UNIT), '') AS unit,
							NULLIF(trim(POSTCODE), '') AS postcode,
							NULLIF(trim(CITY), '') AS locality,
							'openaddresses' AS dataset,
							LAT AS lat, LON AS lon
						FROM read_csv([${oaCSVList}], header = true, all_varchar = true)
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

		const stream = await duck.stream(streamSQL)
		// A streamed DataChunk carries no column names of its own, so pull them off the result once.
		const colNames = stream.columnNames()
		kdb.exec("BEGIN")

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

		kdb.exec("COMMIT")

		console.error(`${totalReturned} ${STATE} rows from ${OA_MODE ? "OpenAddresses" : basename(PARQUET)}`)

		await createAddressPointIndexes(kdb)
		kdb.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")

		const stats = kdb
			.prepare(
				"SELECT count(*) AS n, count(DISTINCT street_norm) AS streets, count(DISTINCT postcode) AS postcodes FROM address_point"
			)
			.get() as Record<string, number>

		// --- Provenance summary --- always emitted so the operator can audit which licenses a database carries.
		const lines: string[] = [
			`${kept} points → ${finalOut}`,
			`${totalReturned} ${STATE} rows from ${OA_MODE ? "OpenAddresses" : basename(PARQUET)}`,
			`distinct streets: ${stats.streets} · postcodes: ${stats.postcodes}`,
			`provenance (${STATE}, release ${options.release}):`,
		]

		const sortedDatasets = [...datasetCounts.entries()].toSorted((a, b) => b[1] - a[1])

		for (const [dataset, count] of sortedDatasets) {
			lines.push(`  ${(OA_MODE ? dataset : `overture:${dataset}`).padEnd(28)} ${count.toLocaleString()} rows`)
		}

		if (allowedDatasets.size) {
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

		// Stamped on the TEMP file, before the swap, for the same reason the interpolation database is: the swap
		// is the moment the artifact becomes live.
		const { buildSHA, stampLayerManifest } = await import("#gazetteer-pipeline/stamp-manifest")
		const { LayerFreshnessPolicy, LayerTier } = await import("@mailwoman/core/layers")
		const { repoRootPath } = await import("@mailwoman/core/utils")

		await stampLayerManifest(tmpOut, {
			name: `address-points-us-${STATE.toLowerCase()}`,
			version: options.release,
			schemaVersion: 1,
			tier: LayerTier.BuildLocal,
			// The dataset allow-list this build applied is the licence claim — a database built with a different
			// filter carries different terms, and the filter is reported in the build output but was recorded
			// nowhere in the artifact.
			license: "see attribution; per-dataset, filtered at build time",
			attribution: `Overture addresses (${[...allowedDatasets].toSorted().join(", ")})`,
			source: "overture-addresses",
			sourceVintage: options.release,
			buildCmd: "mailwoman situs address-points",
			buildSHA: buildSHA(String(repoRootPath())),
			freshnessPolicy: LayerFreshnessPolicy.Sealed,
			spineKeys: { street: { column: "street_norm" } },
			createdAt: new Date().toISOString(),
		})

		await swapDatabaseIntoPlace(tmpOut, finalOut)

		return lines
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
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
