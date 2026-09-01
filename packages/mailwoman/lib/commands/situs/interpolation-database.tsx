/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman situs interpolation-database --state VT` — build a per-state STREET-SEGMENT database (#483)
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

import { dataRootPath } from "@mailwoman/core/data-root"
import { globPaths } from "@mailwoman/core/fs/readers"
import { removePathIfPresent, makeDirectories } from "@mailwoman/core/fs/writers"
import { LayerFreshnessPolicy, LayerTier } from "@mailwoman/core/layers"
import { repoRootPath } from "@mailwoman/core/paths"
import type { StreetSegmentDatabase } from "@mailwoman/resolver-wof-sqlite/street"
import { swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { Box, Text } from "ink"
import { basename, dirname, resolvePath } from "path-ts"

import {
	CommandError,
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	useCommandTask,
} from "#cli-kit"
import { buildSHA, stampLayerManifest } from "#gazetteer-pipeline/stamp-manifest"

/**
 * Provenance tag for the baked `interp_calibration` row — the split-conformal multi-region recalibration this build
 * selects its multiplier from (`docs/articles/evals/calibration/2026-06-14-interp-multiregion-recalibration.md`). Bump
 * when the calibration source of record (`interp-calibration.ts` / `data/calibration/interp-radius-conformal.json`) is
 * re-measured.
 */
const CALIBRATION_METHOD = "split-conformal:2026-06-14"

/**
 * State abbreviation → state FIPS prefix, for picking county files out of --edges-dir.
 */
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

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "interpolation-database",
	description: "Build a state interpolation database",
	options: {
		state: { type: "string", required: true, choices: Object.keys(STATE_FIPS), description: "US state abbreviation" },
		"edges-dir": {
			type: "string",
			default: resolvePath(dataRootPath("census", "tiger2023-edges")),
			description: "TIGER EDGES directory",
		},
		release: { type: "string", default: "TIGER2023", description: "TIGER release tag" },
		out: { type: "string", description: "Output DB path" },
	},
} as const satisfies CommandSpec

interface Options {
	state: string
	edgesDir: string
	release: string
	out?: string
}

/**
 * Strictly-numeric house number → integer, else null (hyphenated/alphanumeric skipped).
 */
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

const SitusInterpolationDatabase: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { DatabaseClient } = await import("@mailwoman/sqlite/client")
		const { parseJSONStrict } = await import("@mailwoman/core/objects")
		const { INTERP_RADIUS_CALIBRATION } = await import("#interp-calibration")

		if (!options.state || !STATE_FIPS[options.state.toUpperCase()]) {
			throw new CommandError(
				`--state required (one of: ${Object.keys(STATE_FIPS).join(", ")} — extend STATE_FIPS for others)`
			)
		}

		const STATE = options.state.toUpperCase()

		const finalOut = resolvePath(
			options.out ?? dataRootPath("interpolation", `interpolation-us-${STATE.toLowerCase()}.db`)
		)

		// Optional maintainer deps: the shared schema/normalizer (resolver-wof-sqlite, an optional peer)
		// and the DuckDB spatial reader (@duckdb/node-api, a dev dep). Both dynamic + guarded so the
		// published CLI doesn't force them on every consumer.
		let segmentSchema: typeof import("@mailwoman/resolver-wof-sqlite/street")
		let streetNormalize: typeof import("@mailwoman/resolver-wof-sqlite/street")

		try {
			segmentSchema = await import("@mailwoman/resolver-wof-sqlite/street")
			streetNormalize = await import("@mailwoman/resolver-wof-sqlite/street")
		} catch {
			throw new CommandError(
				"situs interpolation-database requires `@mailwoman/resolver-wof-sqlite` to be installed (the shared street-segment schema + normalizer)."
			)
		}

		let DuckDBInstance: typeof import("@duckdb/node-api").DuckDBInstance

		try {
			;({ DuckDBInstance } = await import("@duckdb/node-api"))
		} catch {
			throw new CommandError(
				"@duckdb/node-api is not installed — `situs interpolation-database` is a maintainer-only data command"
			)
		}

		const { STREET_SEGMENT_COLUMNS, createStreetSegmentTable, createStreetSegmentIndexes, writeInterpCalibration } =
			segmentSchema

		const { canonicalizeRouteKey, normalizeStreetForKey } = streetNormalize

		const shapefiles = await globPaths(`${options.edgesDir}/tl_*_${STATE_FIPS[STATE]}???_edges.shp`)

		if (!shapefiles.length) {
			throw new CommandError(
				`no tl_*_${STATE_FIPS[STATE]}???_edges.shp under ${options.edgesDir} — download TIGER EDGES first`
			)
		}

		console.error(`${shapefiles.length} county shapefiles for ${STATE}`)

		await makeDirectories(dirname(finalOut))
		// Build into a temp path; atomically swap on success (scripts/AGENTS.md).
		const tmpOut = `${finalOut}.building-${process.pid}.db`

		for (const sfx of ["", "-wal", "-shm"]) {
			await removePathIfPresent(tmpOut + sfx)
		}

		const parityCounts = { odd: 0, even: 0, mixed: 0 }
		let sides = 0
		let skippedNonNumeric = 0
		// #374 doctrine: the conformal radius multiplier is a property of the calibration set, so it ships IN
		// the artifact — bake the state's factor (or the conservative default for unmeasured states) into the
		// database's `interp_calibration` metadata table. `StreetInterpolator` reads it at open time; callers
		// stop carrying the number.
		const measuredMultiplier = INTERP_RADIUS_CALIBRATION.byRegion[STATE]

		const calibration = {
			radius_multiplier: measuredMultiplier ?? INTERP_RADIUS_CALIBRATION.default,
			method: CALIBRATION_METHOD,
			region: measuredMultiplier === undefined ? "default" : STATE,
		}

		let stats: Record<string, number>

		{
			using kdb = new DatabaseClient<StreetSegmentDatabase>(tmpOut)
			kdb.exec("PRAGMA journal_mode = WAL;")
			// DDL via the SHARED street-segment-schema builder (the table the reader + tests use) so this
			// producer can't drift. DuckDB below is the raw spatial reader; the hot INSERT stays on `db`.

			await createStreetSegmentTable(kdb)
			await writeInterpCalibration(kdb, calibration)

			const insert = kdb.prepare(
				`INSERT INTO street_segment (${STREET_SEGMENT_COLUMNS.join(", ")})
						 VALUES (${STREET_SEGMENT_COLUMNS.map(() => "?").join(", ")})`
			)

			const instance = await DuckDBInstance.create()
			const duck = await instance.connect()
			await duck.run("INSTALL spatial; LOAD spatial;")

			kdb.exec("BEGIN")

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
					const geom = parseJSONStrict<{ type: string; coordinates: number[][] }>(String(r.geojson))

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

			kdb.exec("COMMIT")
			await createStreetSegmentIndexes(kdb)
			kdb.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")

			stats = kdb
				.prepare(
					"SELECT count(*) AS n, count(DISTINCT street_norm) AS streets, count(DISTINCT postcode) AS postcodes FROM street_segment"
				)
				.get() as Record<string, number>
		}

		// Stamped on the TEMP file, before the swap: `swapDatabaseIntoPlace` is the moment the artifact
		// becomes the live one, and a manifest written after it would be a write to a published file.
		await stampLayerManifest(tmpOut, {
			name: `interpolation-us-${STATE.toLowerCase()}`,
			version: String(options.release),
			schemaVersion: 1,
			// US Census TIGER/Line is public domain, so unlike the ODbL layers this one COULD ship. It is
			// build-local because nothing publishes it today, not because the licence forbids it.
			tier: LayerTier.BuildLocal,
			license: "public-domain",
			attribution: "US Census Bureau TIGER/Line",
			source: "tiger",
			sourceVintage: String(options.release),
			buildCmd: "mailwoman situs interpolation-database",
			buildSHA: buildSHA(String(repoRootPath())),
			freshnessPolicy: LayerFreshnessPolicy.Sealed,
			// No H3, no WOF id, no address-id — see `SpineKeys.street`. Every probe joins on `street_norm`.
			spineKeys: { street: { column: "street_norm" } },
			createdAt: new Date().toISOString(),
		})

		await swapDatabaseIntoPlace(tmpOut, finalOut)

		return [
			`${sides} segment-sides → ${finalOut}`,
			`distinct streets: ${stats.streets} · postcodes: ${stats.postcodes}`,
			`parity: odd ${parityCounts.odd} · even ${parityCounts.even} · mixed ${parityCounts.mixed}`,
			`skipped non-numeric ranges: ${skippedNonNumeric}`,
			`baked radius calibration: ×${calibration.radius_multiplier} (${calibration.region}, ${calibration.method})`,
		]
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

export default SitusInterpolationDatabase
