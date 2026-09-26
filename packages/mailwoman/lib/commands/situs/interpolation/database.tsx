/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { removePathIfPresent, makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { LayerFreshnessPolicy, LayerTier } from "@mailwoman/core/layers"
import { repoRootPath } from "@mailwoman/core/paths"
import { CommandError } from "@mailwoman/core/scripting/command"
import { interpolationDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { StreetSegmentDatabase } from "@mailwoman/resolver-wof-sqlite/street"
import { swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { Box, Text } from "ink"
import { basename, dirname, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"
import { buildSHA, stampLayerManifest } from "#gazetteer-pipeline/stamp-manifest"

/**
 * Update when the multipliers in `interp-calibration.ts` are re-measured.
 */
const CALIBRATION_METHOD = "split-conformal:2026-06-14"

const STATE_FIPS: Record<string, string> = {
	VT: "50",
	TX: "48",
	IL: "17",
	NJ: "34",
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
 * The command specification for `mailwoman situs interpolation-database`:
 * each address-carrying road edge yields one row per side, because the left
 * and right sides carry independent ranges and ZIP codes.
 */
export const spec = {
	name: "interpolation-database",
	description: "Build a state interpolation database",
	options: {
		state: { type: "string", required: true, choices: Object.keys(STATE_FIPS), description: "US state abbreviation" },
		"edges-dir": {
			type: "string",
			description: "TIGER EDGES directory. Defaults to census/tiger<year>-edges under the data root for --release",
		},
		release: { type: "string", default: "TIGER2023", description: "TIGER release tag" },
		out: { type: "string", description: "Output DB path" },
	},
} as const satisfies CommandSpec

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

const SitusInterpolationDatabase: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { DatabaseClient } = await import("@mailwoman/sqlite/client")
		const { parseJSONStrict } = await import("@mailwoman/core/json")
		const { INTERP_RADIUS_CALIBRATION } = await import("#interp-calibration")

		if (!options.state || !STATE_FIPS[options.state.toUpperCase()]) {
			throw new CommandError(
				`--state required (one of: ${Object.keys(STATE_FIPS).join(", ")} — extend STATE_FIPS for others)`
			)
		}

		const STATE = options.state.toUpperCase()
		const { parseTIGERRelease } = await import("@mailwoman/tiger")
		const vintage = parseTIGERRelease(options.release)
		const edgesDir = options.edgesDir ?? resolvePath(dataRootPath("census", `tiger${vintage}-edges`))

		const finalOut = resolvePath(options.out ?? interpolationDatabasePath(`interpolation-us-${STATE.toLowerCase()}.db`))

		// Both packages load dynamically because the published CLI does not depend on them.
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

		const shapefiles = (
			await Globerator.from(`${edgesDir}/tl_${vintage}_${STATE_FIPS[STATE]}???_edges.shp`, {
				absolute: true,
			}).toArray()
		).toSorted()

		if (!shapefiles.length) {
			throw new CommandError(
				`no tl_${vintage}_${STATE_FIPS[STATE]}???_edges.shp under ${edgesDir} — download TIGER EDGES first`
			)
		}

		console.error(`${shapefiles.length} county shapefiles for ${STATE}`)

		await makeDirectories(dirname(finalOut))
		const tmpOut = `${finalOut}.building-${process.pid}.db`

		for (const sfx of ["", "-wal", "-shm"]) {
			await removePathIfPresent(tmpOut + sfx)
		}

		const parityCounts = { odd: 0, even: 0, mixed: 0 }
		let sides = 0
		let skippedNonNumeric = 0
		// `StreetInterpolator` reads this multiplier when it opens the file.
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
			// The schema comes from the shared builder so that the reader and this writer agree.
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

					// Rounding to 1e-6 degrees (about 0.1 m) drops noise digits that would bloat the JSON.
					const polyline = stringifyJSON(
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
							options.release
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

		// The manifest is stamped before the swap so that the published file is never written to.
		await stampLayerManifest(tmpOut, {
			name: `interpolation-us-${STATE.toLowerCase()}`,
			version: options.release,
			schemaVersion: 1,
			// Build-local only: no artifact publishes it.
			tier: LayerTier.BuildLocal,
			license: "public-domain",
			attribution: "US Census Bureau TIGER/Line",
			source: "tiger",
			sourceVintage: options.release,
			buildCmd: "mailwoman situs interpolation-database",
			buildSHA: buildSHA(repoRootPath()),
			freshnessPolicy: LayerFreshnessPolicy.Sealed,
			// The layer joins only on `street_norm`.
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

	return null
}

export default SitusInterpolationDatabase
