/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman coverage build` — bake the demo map's "fog of war" address-coverage H3 hexbin tileset
 *   (PMTiles) from the per-state address-point (+ interpolation) shards. See `coverage-core.ts` for the
 *   pipeline + fog model. Publish the result with `mailwoman tiles publish`.
 *
 *   Maintainer-only: needs the local shards + `tippecanoe` on PATH + the @duckdb/node-api dev dep.
 */

import { Box, Text } from "ink"
import { setImmediate } from "node:timers/promises"
import { useEffect, useState } from "react"
import zod from "zod"
import { dataRootPath } from "@mailwoman/core/utils"
import { buildCoverageTiles, type CoverageBuildResult } from "../../coverage-core.js"
import type { CommandComponent } from "../../sdk/cli.js"

const OptionsSchema = zod.object({
	states: zod.string().optional().default("all").describe("Comma-separated state slugs (e.g. CA,TX) or 'all'"),
	excludeStates: zod.string().optional().default("AK").describe("Comma-separated slugs to exclude (default AK — antimeridian)"),
	dataRoot: zod
		.string()
		.optional()
		.default(dataRootPath("address-points"))
		.describe("Root holding address-points-us-<st>.db shards"),
	interp: zod.coerce.boolean().optional().default(true).describe("Blend the TIGER street-segment signal (--no-interp to disable)"),
	interpRoot: zod
		.string()
		.optional()
		.default(dataRootPath("interpolation"))
		.describe("Root holding interpolation-us-<st>.db shards"),
	fineRes: zod.coerce.number().int().min(0).max(15).optional().default(9).describe("Finest H3 resolution (fog floor; 9 ≈ 174 m)"),
	rollup: zod.string().optional().default("7,5").describe("Coarser rollup resolutions (comma-separated)"),
	domainRes: zod.coerce.number().int().min(0).max(15).optional().default(6).describe("Parent res defining the fog neighborhood (6 ≈ 3.2 km)"),
	saturation: zod.coerce.number().positive().optional().default(25).describe("Address-point count at which a fine cell fully clears"),
	satSeg: zod.coerce.number().positive().optional().default(8).describe("Street-segment count at which the interp signal saturates"),
	interpWeight: zod.coerce.number().min(0).max(1).optional().default(0.4).describe("Weight of the street-segment signal vs address points"),
	optimisticGamma: zod.coerce.number().positive().optional().default(2).describe("Exponent for the optimistic fog curve (fog ** gamma)"),
	postcode: zod.coerce.boolean().optional().default(true).describe("Add the global civilization-holes layer (--no-postcode to disable)"),
	geonamesPostal: zod
		.string()
		.optional()
		.default(dataRootPath("geonames", "allCountries-postal.txt"))
		.describe("GeoNames postal file (12-col) — the global postcode COVERAGE signal"),
	wofDb: zod
		.string()
		.optional()
		.default(dataRootPath("wof", "admin-global-priority-importance.db"))
		.describe("WOF DB (spr + place_importance) — the civilization/salience backdrop"),
	postcodeCeiling: zod.coerce.number().min(0).max(1).optional().default(0.85).describe("Coverage a postcode cell contributes (clears the hole; ≤ 1)"),
	salienceFloor: zod.coerce.number().min(0).max(1).optional().default(0.15).describe("Min place importance to flag as a hole (noise floor)"),
	postcodeExclude: zod.string().optional().default("US").describe("Country codes the global holes layer skips (rooftop-covered; comma-separated)"),
	maxZoom: zod.coerce.number().int().min(0).max(22).optional().default(12).describe("Highest baked zoom (MapLibre overzooms above)"),
	out: zod
		.string()
		.optional()
		.default(dataRootPath("coverage", "coverage-us.pmtiles"))
		.describe("Output .pmtiles path"),
	keepNdjson: zod.coerce.boolean().optional().default(false).describe("Keep the intermediate NDJSON"),
	threads: zod.coerce.number().int().positive().optional().describe("DuckDB worker-thread cap (default: all cores)"),
})

export { OptionsSchema as options }

const CoverageBuild: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [done, setDone] = useState<CoverageBuildResult>()
	const [stage, setStage] = useState<{ name: string; message: string }>()

	useEffect(() => {
		if (error) setImmediate().then(() => process.exit(1))
		else if (done) setImmediate().then(() => process.exit(0))
	}, [error, done])

	useEffect(() => {
		const rollup = options.rollup
			.split(",")
			.map((s) => Number(s.trim()))
			.filter((n) => Number.isInteger(n) && n < options.fineRes)
		buildCoverageTiles(
			{
				states: options.states,
				excludeStates: options.excludeStates.split(",").map((s) => s.trim()).filter(Boolean),
				dataRoot: options.dataRoot,
				interpRoot: options.interp ? options.interpRoot : null,
				fineRes: options.fineRes,
				rollup,
				domainRes: options.domainRes,
				saturation: options.saturation,
				satSeg: options.satSeg,
				interpWeight: options.interpWeight,
				optimisticGamma: options.optimisticGamma,
				geonamesPostalFile: options.postcode ? options.geonamesPostal : null,
				wofDb: options.postcode ? options.wofDb : null,
				postcodeCeiling: options.postcodeCeiling,
				salienceFloor: options.salienceFloor,
				postcodeExcludeCountries: options.postcodeExclude.split(",").map((s) => s.trim()).filter(Boolean),
				tileMaxZoom: options.maxZoom,
				out: options.out,
				keepNdjson: options.keepNdjson,
				threads: options.threads,
			},
			(name, message) => setStage({ name, message })
		)
			.then(setDone)
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
	}, [options])

	if (error) return <Text color="red">{error}</Text>

	if (done) {
		return (
			<Box flexDirection="column">
				<Text>
					<Text color="green">✓</Text> {done.features.toLocaleString()} features · {done.domainCells.toLocaleString()} cells (
					{done.withPoints.toLocaleString()} with points, {done.streetOnly.toLocaleString()} street-only,{" "}
					{done.postcodeCells.toLocaleString()} postcode) · {(done.pmtilesBytes / 1024 / 1024).toFixed(1)} MB
				</Text>
				<Text dimColor>{done.out}</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column">
			<Text>building coverage tiles…</Text>
			{stage ? (
				<Text dimColor>
					[{stage.name}] {stage.message}
				</Text>
			) : null}
		</Box>
	)
}

export default CoverageBuild
