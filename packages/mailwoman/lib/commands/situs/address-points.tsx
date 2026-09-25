/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Builds a state or national address-point database from Overture or OpenAddresses.
 */

import { removePathIfPresent, makeDirectories } from "@mailwoman/core/fs/writers"
import { OVERTURE_ADDRESSES_RELEASE } from "@mailwoman/core/overture-pins"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"
import type { AddressPointDatabase } from "@mailwoman/resolver-wof-sqlite/address"
import { Box, Text } from "ink"
import { basename, dirname, resolvePath } from "path-ts"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Declares the options of `mailwoman situs address-points`.
 */
export const spec = {
	name: "address-points",
	description: "Build a state address-point database",
	options: {
		state: { type: "string", description: "US state abbreviation (the per-state build)" },
		country: {
			type: "string",
			description:
				"ISO alpha-2 country for a NATIONAL build from addresses-<cc>.parquet (registered in national-overture.ts)",
		},
		bbox: {
			type: "string",
			description: "minLon,minLat,maxLon,maxLat — drop rows whose coordinate falls outside (national builds)",
		},
		release: {
			type: "string",
			default: OVERTURE_ADDRESSES_RELEASE,
			description: "Overture release (the addresses-theme pin)",
		},
		out: { type: "string", description: "Output DB path" },
		"county-fips": { type: "string", validate: (v: string) => /^\d{5}$/u.test(v), description: "County FIPS" },
		"county-boundary": { type: "string", description: "TIGER county boundary shapefile" },
		"license-filter": { type: "string", description: "Dataset allow-list" },
		threads: { type: "string", description: "DuckDB thread cap" },
		"oa-csv": { type: "string", description: "OpenAddresses CSV paths" },
	},
} as const satisfies CommandSpec

/**
 * The number of `--bbox` fields: minLon, minLat, maxLon, maxLat.
 */
const BBOX_FIELDS = 4

/**
 * Builds an address-point database that maps `(street, number)` within a postcode
 * or locality scope to an exact point, then prints its provenance summary.
 *
 * `--state` builds one US state from the Overture addresses parquet.
 * `--country` builds one national database for `OvertureNationalDatabaseProvider`.
 *
 * `--oa-csv` builds from OpenAddresses CSVs for states that Overture does not carry.
 *
 * Keys come from the shared normalizer in `@mailwoman/resolver-wof-sqlite`,
 * which the lookup tier also applies at query time.
 * The command needs `@duckdb/node-api` and the optional `@mailwoman/resolver-wof-sqlite` peer.
 * It builds into a temp path and swaps the result into place.
 */
const SitusAddressPoints: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { DatabaseClient } = await import("@mailwoman/sqlite/client")
		const { dataRootPath } = await import("@mailwoman/core/data-root")
		const { addressPointDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")
		const { swapDatabaseIntoPlace } = await import("@mailwoman/sqlite/sealed-db")

		const OA_MODE = Boolean(options.oaCSV)
		const COUNTRY = options.country?.toUpperCase()

		if (!options.state && !COUNTRY) {
			throw new CommandError("--state (a US state abbreviation, e.g. VT) or --country (e.g. TW) is required")
		}

		if (options.state && COUNTRY) {
			throw new CommandError("--state and --country are two builds; pass one")
		}

		if (COUNTRY && (options.countyFips || options.oaCSV)) {
			throw new CommandError("--country takes neither --county-fips nor --oa-csv")
		}

		const bbox = options.bbox?.split(",").map(Number)

		if (bbox && (bbox.length !== BBOX_FIELDS || bbox.some((value) => !Number.isFinite(value)))) {
			throw new CommandError("--bbox must be minLon,minLat,maxLon,maxLat")
		}

		if (options.countyFips && !/^\d{5}$/.test(options.countyFips)) {
			throw new CommandError("--county-fips must be a 5-digit state+county FIPS (e.g. 17031)")
		}

		if (options.countyFips && !options.countyBoundary) {
			throw new CommandError(
				"--county-fips requires --county-boundary (the TIGER COUNTY shapefile to point-in-polygon against)"
			)
		}

		const STATE = options.state?.toUpperCase() ?? ""

		const PARQUET = COUNTRY
			? dataRootPath("overture", options.release, `addresses-${COUNTRY.toLowerCase()}.parquet`)
			: dataRootPath("overture", options.release, "addresses-us.parquet")

		const SCOPE = COUNTRY ?? STATE

		const { licenseForOvertureCountry, nationalAddressPointsPath, streetLocaleForOvertureCountry } =
			await import("#geocode/national-overture")

		// A national build must key with the locale its provider reads with.
		// An unregistered country throws here instead of keying with the wrong rules.
		const nationalLocale = COUNTRY ? streetLocaleForOvertureCountry(COUNTRY) : undefined

		const finalOut = resolvePath(
			options.out ??
				(COUNTRY
					? nationalAddressPointsPath(dataRootPath(), COUNTRY)
					: addressPointDatabasePath(`address-points-us-${STATE.toLowerCase()}.db`))
		)

		// Both imports are dynamic so the published CLI does not require these optional dependencies.
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

		const {
			canonicalizeRouteKey,
			normalizeHouseNumberForKey,
			normalizeLocalityForKey,
			normalizeLocalityForKeyLocale,
			normalizeStreetForKey,
			normalizeStreetForKeyLocale,
		} = streetNormalize

		// An empty allow-list keeps every dataset.
		const allowedDatasets: Set<string> = new Set(extractDelimited(options.licenseFilter).map((d) => d.toLowerCase()))

		await makeDirectories(dirname(finalOut))
		const tmpOut = `${finalOut}.building-${process.pid}.db`

		for (const sfx of ["", "-wal", "-shm"]) {
			await removePathIfPresent(tmpOut + sfx)
		}

		const instance = await DuckDBInstance.create()
		const duck = await instance.connect()

		// The national driver caps threads so concurrent state builds do not oversubscribe cores.
		if (options.threads && /^\d+$/.test(options.threads)) {
			await duck.run(`SET threads TO ${options.threads}`)
		}

		// Overture has no county field, so a county scope tests each point against the TIGER county polygon.
		// DuckDB hoists the scalar subquery to a constant, so each row pays only the containment test.
		let countyFilter = ""

		if (options.countyFips) {
			await duck.run("INSTALL spatial; LOAD spatial;")

			countyFilter = `AND ST_Contains(
							(SELECT geom FROM ST_Read('${options.countyBoundary}') WHERE GEOID = '${options.countyFips}'),
							ST_Point(lon, lat))`
		}

		// DuckDB applies the license filter so the parquet scan drops ineligible rows before transfer.
		const datasetFilter = allowedDatasets.size
			? `AND lower(sources[1].dataset) IN (${[...allowedDatasets].map((d) => `'${d}'`).join(", ")})`
			: ""

		const kdb = new DatabaseClient<AddressPointDatabase>(tmpOut)
		// The DDL and column order come from the shared schema so this writer cannot drift from the reader.
		kdb.exec("PRAGMA journal_mode = WAL;")

		await createAddressPointTable(kdb)

		const insert = kdb.prepare(
			`INSERT INTO address_point (${ADDRESS_POINT_COLUMNS.join(", ")})
					 VALUES (${ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`
		)

		// These counts cover every row DuckDB returns, before the JavaScript-side drops.
		const datasetCounts = new Map<string, number>()
		let kept = 0
		let totalReturned = 0

		const oaCSVList = OA_MODE
			? extractDelimited(options.oaCSV)
					.map((p) => `'${p}'`)
					.join(", ")
			: ""

		const bboxFilter = bbox ? `AND lon BETWEEN ${bbox[0]} AND ${bbox[2]} AND lat BETWEEN ${bbox[1]} AND ${bbox[3]}` : ""

		const streamSQL = OA_MODE
			? `SELECT
							NUMBER AS number, STREET AS street, NULLIF(trim(UNIT), '') AS unit,
							NULLIF(trim(POSTCODE), '') AS postcode,
							NULLIF(trim(CITY), '') AS locality,
							'openaddresses' AS dataset,
							LAT AS lat, LON AS lon
						FROM read_csv([${oaCSVList}], header = true, all_varchar = true)
						WHERE nullif(trim(STREET), '') IS NOT NULL AND nullif(trim(NUMBER), '') IS NOT NULL`
			: COUNTRY
				? `SELECT
							number, street, unit, postcode,
							-- The scope pair: the country's top two admin levels, folded together at insert time.
							concat(coalesce(trim(address_levels[1].value), ''), coalesce(trim(address_levels[2].value), '')) AS locality,
							nullif(trim(address_levels[3].value), '') AS admin_code,
							sources[1].dataset AS dataset,
							lat, lon
						FROM read_parquet('${PARQUET}')
						WHERE country = '${COUNTRY}'
							AND nullif(trim(street), '') IS NOT NULL
							AND nullif(trim(number), '') IS NOT NULL
							${bboxFilter}
							${datasetFilter}`
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

		// The scan streams one DataChunk at a time because the largest states overflow
		// the V8 heap when the whole result is materialized.
		const stream = await duck.stream(streamSQL)
		// A streamed DataChunk has no column names, so the names come from the result.
		const colNames = stream.columnNames()
		kdb.exec("BEGIN")

		for (let chunk = await stream.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await stream.fetchChunk()) {
			const rows = chunk.getRowObjects(colNames) as Record<string, unknown>[]

			for (const r of rows) {
				totalReturned++
				const dataset = String(r.dataset ?? "unknown")
				datasetCounts.set(dataset, (datasetCounts.get(dataset) ?? 0) + 1)

				const streetRaw = String(r.street)

				const streetNorm = nationalLocale
					? normalizeStreetForKeyLocale(streetRaw, nationalLocale)
					: normalizeStreetForKey(streetRaw)

				if (!streetNorm) continue
				const lat = Number(r.lat)
				const lon = Number(r.lon)

				// OpenAddresses rows can have empty coordinates.
				if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

				const locality = r.locality
					? nationalLocale
						? normalizeLocalityForKeyLocale(String(r.locality), nationalLocale)
						: normalizeLocalityForKey(String(r.locality))
					: null

				const number = normalizeHouseNumberForKey(String(r.number), nationalLocale ?? "us")

				if (!number) continue

				insert.run(
					streetNorm,
					canonicalizeRouteKey(streetNorm),
					number,
					r.unit ? String(r.unit).trim().toLowerCase() : null,
					r.postcode ? String(r.postcode).trim() : null,
					locality,
					streetRaw,
					lat,
					lon,
					OA_MODE ? "openaddresses" : `overture:${r.dataset}`,
					OA_MODE ? "openaddresses-latest" : options.release,
					// Only a national build has an admin code: the third admin level, such as the Taiwanese 村里.
					r.admin_code ? String(r.admin_code) : null,
					null
				)

				kept++
			}
		}

		kdb.exec("COMMIT")

		console.error(`${totalReturned} ${SCOPE} rows from ${OA_MODE ? "OpenAddresses" : basename(PARQUET)}`)

		await createAddressPointIndexes(kdb)
		kdb.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")

		const stats = kdb
			.prepare(
				"SELECT count(*) AS n, count(DISTINCT street_norm) AS streets, count(DISTINCT postcode) AS postcodes FROM address_point"
			)
			.get() as Record<string, number>

		// The summary always includes provenance so operators can audit database licenses.
		const lines: string[] = [
			`${kept} points → ${finalOut}`,
			`${totalReturned} ${SCOPE} rows from ${OA_MODE ? "OpenAddresses" : basename(PARQUET)}`,
			`distinct streets: ${stats.streets} · postcodes: ${stats.postcodes}`,
			`provenance (${SCOPE}, release ${options.release}):`,
		]

		const sortedDatasets = [...datasetCounts.entries()].toSorted((a, b) => b[1] - a[1])

		for (const [dataset, count] of sortedDatasets) {
			lines.push(`  ${(OA_MODE ? dataset : `overture:${dataset}`).padEnd(28)} ${count.toLocaleString()} rows`)
		}

		if (allowedDatasets.size) {
			// The main query already excluded filtered rows, so a second count measures what the filter dropped.
			const totalResult = await duck.runAndReadAll(`
						SELECT count(*) AS n
						FROM read_parquet('${PARQUET}')
						WHERE ${COUNTRY ? `country = '${COUNTRY}'` : `address_levels[1].value = '${STATE}'`}
							AND nullif(trim(street), '') IS NOT NULL
							AND nullif(trim(number), '') IS NOT NULL
							${countyFilter}
							${bboxFilter}
					`)

			const totalUnfiltered = Number((totalResult.getRowObjects()[0] as Record<string, unknown>).n)
			const keptCount = totalReturned
			const droppedCount = totalUnfiltered - keptCount

			lines.push(
				`license-filter: ${[...allowedDatasets].join(", ")} → kept ${keptCount.toLocaleString()} / dropped ${droppedCount.toLocaleString()} (of ${totalUnfiltered.toLocaleString()} total parquet rows for ${SCOPE})`
			)
		}

		await kdb.destroy()

		// The manifest is stamped on the temp file because the swap is the moment the database goes live.
		const { buildSHA, stampLayerManifest } = await import("#gazetteer-pipeline/stamp-manifest")
		const { LayerFreshnessPolicy, LayerTier } = await import("@mailwoman/core/layers")
		const { repoRootPath } = await import("@mailwoman/core/paths")

		await stampLayerManifest(tmpOut, {
			name: COUNTRY ? `address-points-${COUNTRY.toLowerCase()}` : `address-points-us-${STATE.toLowerCase()}`,
			version: options.release,
			schemaVersion: 1,
			tier: LayerTier.BuildLocal,
			// The manifest accepts only an SPDX expression that the obligations table knows.
			// The attribution lists the kept datasets because each allow-list carries different terms.
			license: COUNTRY ? licenseForOvertureCountry(COUNTRY) : "CDLA-Permissive-2.0",
			attribution: `Overture addresses (${(allowedDatasets.size ? [...allowedDatasets] : sortedDatasets.map(([dataset]) => dataset)).toSorted().join(", ")})`,
			source: "overture-addresses",
			sourceVintage: options.release,
			buildCmd: "mailwoman situs address-points",
			buildSHA: buildSHA(repoRootPath()),
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

	return null
}

export default SitusAddressPoints
