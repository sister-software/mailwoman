/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman situs interpolation-shard --state VT` — build a per-state STREET-SEGMENT shard (#483)
 *   from TIGER EDGES: side-aware house-number ranges + segment polylines, keyed by THE shared
 *   street normalizer (`@mailwoman/resolver-wof-sqlite/street-normalize` — the same function the
 *   interpolation lookup applies at query time; one normalizer, never two). The interpolation
 *   tier's data half; design in `docs/articles/plan/2026-06-11-interpolation-design.md`.
 *
 *   One row PER SIDE per address-carrying road edge (left and right carry independent ranges and ZIPs
 *   in TIGER). Parity is derived from the from/to numbers ('odd' | 'even' | 'mixed'); descending
 *   ranges keep their raw from/to (direction matters for the interpolation position) alongside
 *   min/max index columns. Non-numeric ranges (hyphenated, alphanumeric) are skipped and counted.
 *
 *   Inputs: TIGER EDGES shapefiles per county (the same files the intersection eval reads),
 *   downloaded to --edges-dir from:
 *   https://www2.census.gov/geo/tiger/TIGER2023/EDGES/tl_2023_<countyfips>_edges.zip
 *
 *   Maintainer-only: needs the local shapefiles + the @duckdb/node-api dev dep + the optional
 * @mailwoman/resolver-wof-sqlite peer (the shared schema + normalizer). Progress streams to stderr;
 *   the final summary lands on stdout. The build writes to a temp path, then atomically swaps into
 *   place (scripts/AGENTS.md) — the original script rebuilt in place.
 */

import { existsSync, globSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { basename, dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath } from "@mailwoman/core/utils"
import type { StreetSegmentDatabase } from "@mailwoman/resolver-wof-sqlite/street-segment-schema"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../sdk/cli.js"

/** State abbreviation → state FIPS prefix, for picking county files out of --edges-dir. */
const STATE_FIPS: Record<string, string> = {
	// Original entries preserved
	VT: "50",
	TX: "48",
	IL: "17",
	NJ: "34",
	// All 50 states + DC (FIPS PUB 5-2 / TIGER column statefp)
	AL: "01",
	AK: "02",
	AZ: "04",
	AR: "05",
	CA: "06",
	CO: "08",
	CT: "09",
	DE: "10",
	DC: "11",
	FL: "12",
	GA: "13",
	HI: "15",
	ID: "16",
	IN: "18",
	IA: "19",
	KS: "20",
	KY: "21",
	LA: "22",
	ME: "23",
	MD: "24",
	MA: "25",
	MI: "26",
	MN: "27",
	MS: "28",
	MO: "29",
	MT: "30",
	NE: "31",
	NV: "32",
	NH: "33",
	NM: "35",
	NY: "36",
	NC: "37",
	ND: "38",
	OH: "39",
	OK: "40",
	OR: "41",
	PA: "42",
	RI: "44",
	SC: "45",
	SD: "46",
	TN: "47",
	UT: "49",
	VA: "51",
	WA: "53",
	WV: "54",
	WI: "55",
	WY: "56",
}

const OptionsSchema = zod.object({
	state: zod
		.string()
		.optional()
		.describe(`US state abbreviation (one of: ${Object.keys(STATE_FIPS).join(", ")} — extend STATE_FIPS for others)`),
	edgesDir: zod
		.string()
		.optional()
		.default("/tmp/tiger-edges")
		.describe("Directory holding the per-county TIGER EDGES shapefiles (tl_*_<statefips>???_edges.shp)"),
	release: zod.string().optional().default("TIGER2023").describe("TIGER release tag, recorded as per-row provenance"),
	out: zod.string().optional().describe("Output DB path. Default <data-root>/interpolation/interpolation-us-<st>.db"),
})

export { OptionsSchema as options }

/** Strictly-numeric house number → integer, else null (hyphenated/alphanumeric skipped). */
function parseHn(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null
	const s = String(raw).trim()

	if (!/^\d+$/.test(s)) return null

	return Number(s)
}

function parityOf(from: number, to: number): "odd" | "even" | "mixed" {
	const f = from % 2

	if (f !== to % 2) return "mixed"

	return f === 1 ? "odd" : "even"
}

/**
 * Scripts/AGENTS.md atomic swap: the build wrote to a temp path, so a mid-build crash never leaves a half-written DB at
 * finalPath. Move any prior version aside, slot the new one in, then drop the old. (The original script rebuilt in
 * place — `rmSync(OUT)` then `new DatabaseSync(OUT)`.)
 */
function swapDatabaseIntoPlace(tmpPath: string, finalPath: string): void {
	const aside = `${finalPath}.old-${process.pid}`

	if (existsSync(finalPath)) renameSync(finalPath, aside)

	for (const sfx of ["-wal", "-shm"]) rmSync(finalPath + sfx, { force: true })
	renameSync(tmpPath, finalPath)

	for (const sfx of ["-wal", "-shm"]) rmSync(tmpPath + sfx, { force: true })
	rmSync(aside, { force: true })
}

const SitusInterpolationShard: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [summary, setSummary] = useState<string[]>()

	useEffect(() => {
		void (async () => {
			try {
				if (!options.state || !STATE_FIPS[options.state.toUpperCase()]) {
					throw new Error(
						`--state required (one of: ${Object.keys(STATE_FIPS).join(", ")} — extend STATE_FIPS for others)`
					)
				}
				const STATE = options.state.toUpperCase()
				const finalOut = options.out ?? dataRootPath("interpolation", `interpolation-us-${STATE.toLowerCase()}.db`)

				// Optional maintainer deps: the shared schema/normalizer (resolver-wof-sqlite, an optional peer)
				// and the DuckDB spatial reader (@duckdb/node-api, a dev dep). Both dynamic + guarded so the
				// published CLI doesn't force them on every consumer.
				let segmentSchema: typeof import("@mailwoman/resolver-wof-sqlite/street-segment-schema")
				let streetNormalize: typeof import("@mailwoman/resolver-wof-sqlite/street-normalize")

				try {
					segmentSchema = await import("@mailwoman/resolver-wof-sqlite/street-segment-schema")
					streetNormalize = await import("@mailwoman/resolver-wof-sqlite/street-normalize")
				} catch {
					throw new Error(
						"situs interpolation-shard requires `@mailwoman/resolver-wof-sqlite` to be installed (the shared street-segment schema + normalizer)."
					)
				}
				let DuckDBInstance: typeof import("@duckdb/node-api").DuckDBInstance

				try {
					;({ DuckDBInstance } = await import("@duckdb/node-api"))
				} catch {
					throw new Error(
						"@duckdb/node-api is not installed — `situs interpolation-shard` is a maintainer-only data command"
					)
				}
				const { STREET_SEGMENT_COLUMNS, createStreetSegmentTable, createStreetSegmentIndexes } = segmentSchema
				const { canonicalizeRouteKey, normalizeStreetForKey } = streetNormalize

				const shapefiles = globSync(`${options.edgesDir}/tl_*_${STATE_FIPS[STATE]}???_edges.shp`).sort()

				if (shapefiles.length === 0) {
					throw new Error(
						`no tl_*_${STATE_FIPS[STATE]}???_edges.shp under ${options.edgesDir} — download TIGER EDGES first`
					)
				}
				console.error(`${shapefiles.length} county shapefiles for ${STATE}`)

				mkdirSync(dirname(finalOut), { recursive: true })
				// Build into a temp path; atomically swap on success (scripts/AGENTS.md).
				const tmpOut = `${finalOut}.building-${process.pid}.db`

				for (const sfx of ["", "-wal", "-shm"]) rmSync(tmpOut + sfx, { force: true })

				const db = new DatabaseSync(tmpOut)
				db.exec("PRAGMA journal_mode = WAL;")
				// DDL via the SHARED street-segment-schema builder (the table the reader + tests use) so this
				// producer can't drift. DuckDB below is the raw spatial reader; the hot INSERT stays on `db`.
				const kdb = new DatabaseClient<StreetSegmentDatabase>({ database: db })
				await createStreetSegmentTable(kdb)
				const insert = db.prepare(
					`INSERT INTO street_segment (${STREET_SEGMENT_COLUMNS.join(", ")})
					 VALUES (${STREET_SEGMENT_COLUMNS.map(() => "?").join(", ")})`
				)

				const instance = await DuckDBInstance.create()
				const duck = await instance.connect()
				await duck.run("INSTALL spatial; LOAD spatial;")

				let sides = 0
				let skippedNonNumeric = 0
				const parityCounts = { odd: 0, even: 0, mixed: 0 }

				db.exec("BEGIN")

				for (const shp of shapefiles) {
					const countyFips = basename(shp).match(/tl_\d+_(\d{5})_edges/)?.[1] ?? "unknown"
					// Address-carrying road edges only; geometry as GeoJSON text so the JS side stays
					// shapefile-free (same ST_Read approach as build-intersection-real.ts).
					const result = await duck.runAndReadAll(`
						SELECT FULLNAME AS name, LFROMADD, LTOADD, RFROMADD, RTOADD, ZIPL, ZIPR,
							ST_AsGeoJSON(geom) AS geojson
						FROM ST_Read('${shp}')
						WHERE MTFCC LIKE 'S1%' AND FULLNAME IS NOT NULL
							AND (LFROMADD IS NOT NULL OR RFROMADD IS NOT NULL)
					`)

					for (const r of result.getRowObjects() as Record<string, unknown>[]) {
						const streetRaw = String(r.name)
						const streetNorm = canonicalizeRouteKey(normalizeStreetForKey(streetRaw))

						if (!streetNorm) continue
						const geom = JSON.parse(String(r.geojson)) as { type: string; coordinates: number[][] }

						if (geom.type !== "LineString" || geom.coordinates.length < 2) continue
						// Round to 1e-6 deg (~0.1 m) — shapefile floats carry noise digits that bloat the JSON.
						const polyline = JSON.stringify(
							geom.coordinates.map(([lon, lat]) => [Math.round(lon! * 1e6) / 1e6, Math.round(lat! * 1e6) / 1e6])
						)

						for (const [side, fromRaw, toRaw, zip] of [
							["L", r.LFROMADD, r.LTOADD, r.ZIPL],
							["R", r.RFROMADD, r.RTOADD, r.ZIPR],
						] as const) {
							if (fromRaw === null && toRaw === null) continue
							const from = parseHn(fromRaw)
							const to = parseHn(toRaw)

							if (from === null || to === null) {
								skippedNonNumeric++
								continue
							}
							const parity = parityOf(from, to)
							parityCounts[parity]++
							insert.run(
								streetNorm,
								side,
								from,
								to,
								Math.min(from, to),
								Math.max(from, to),
								parity,
								zip === null || zip === undefined ? null : String(zip),
								countyFips,
								streetRaw,
								polyline,
								"tiger:edges",
								String(options.release)
							)
							sides++
						}
					}
					console.error(`  ${countyFips}: done (${sides} sides so far)`)
				}
				db.exec("COMMIT")
				await createStreetSegmentIndexes(kdb)
				db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
				const stats = db
					.prepare(
						"SELECT count(*) AS n, count(DISTINCT street_norm) AS streets, count(DISTINCT postcode) AS postcodes FROM street_segment"
					)
					.get() as Record<string, number>
				await kdb.destroy()

				swapDatabaseIntoPlace(tmpOut, finalOut)

				setSummary([
					`${sides} segment-sides → ${finalOut}`,
					`distinct streets: ${stats.streets} · postcodes: ${stats.postcodes}`,
					`parity: odd ${parityCounts.odd} · even ${parityCounts.even} · mixed ${parityCounts.mixed}`,
					`skipped non-numeric ranges: ${skippedNonNumeric}`,
				])
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

export default SitusInterpolationShard
