/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Implements `mailwoman coverage build`, which builds the demo map's address-coverage H3 hexbin
 *   PMTiles from the per-state address-point and interpolation databases.
 *
 *   `coverage-core.ts` implements the pipeline. `mailwoman tiles publish` uploads the result. The
 *   command requires the local databases, `tippecanoe` on the path and the `@duckdb/node-api`
 *   development dependency.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { dataRootPath } from "@mailwoman/core/data-root"
import {
	addressPointDatabasePath,
	interpolationDatabasePath,
	wofDatabasePath,
} from "@mailwoman/resolver-wof-sqlite/paths"
import { Box, Text } from "ink"
import { resolvePath } from "path-ts"
import { useState } from "react"

import {
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	splitNumberList,
	useCommandTask,
} from "#cli-kit"

/**
 * The finest resolution that H3 defines.
 */
const MAX_H3_RESOLUTION = 15

/**
 * The maximum zoom level that Tippecanoe supports.
 */
const MAX_TILE_ZOOM = 22

const h3 = (description: string, defaultValue: number) =>
	({
		type: "number",
		default: defaultValue,
		validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= MAX_H3_RESOLUTION,
		validationMessage: `${description} must be an integer from 0 to ${MAX_H3_RESOLUTION}.`,
		description,
	}) as const

const unit = (description: string, defaultValue: number) =>
	({
		type: "number",
		default: defaultValue,
		validate: (value: number) => value >= 0 && value <= 1,
		validationMessage: `${description} must be between 0 and 1.`,
		description,
	}) as const

/**
 * The command specification for `mailwoman coverage build`.
 *
 * The CLI reference page `docs/articles/developers/reference/cli.mdx` is generated from
 * these option names and descriptions, and the docs check fails when the page is stale.
 */
export const spec = {
	name: "build",
	description: "Build address-coverage PMTiles.",
	options: {
		states: { type: "string", default: "all", description: "State slugs" },
		"exclude-states": { type: "string", default: "AK", description: "Excluded states" },
		"data-root": {
			type: "string",
			default: addressPointDatabasePath.toString(),
			description: "Address-point root",
		},
		interp: { type: "boolean", default: true, description: "Blend interpolation" },
		"interp-root": {
			type: "string",
			default: interpolationDatabasePath.toString(),
			description: "Interpolation root",
		},
		"fine-res": h3("fine resolution", 9),
		rollup: { type: "string", default: "7,5", description: "Rollup resolutions" },
		"domain-res": h3("domain resolution", 6),
		saturation: { type: "number", default: 25, description: "Point saturation" },
		"sat-seg": { type: "number", default: 8, description: "Segment saturation" },
		"interp-weight": unit("interpolation weight", 0.4),
		"optimistic-gamma": { type: "number", default: 2, description: "Fog exponent" },
		postcode: { type: "boolean", default: true, description: "Add global holes" },
		"geonames-postal": {
			type: "string",
			default: resolvePath(dataRootPath("geonames", "allCountries-postal.txt")),
			description: "GeoNames postal file",
		},
		"wof-db": {
			type: "string",
			default: wofDatabasePath("admin-global-priority-importance.db").toString(),
			description: "WOF database",
		},
		"postcode-ceiling": unit("postcode ceiling", 0.85),
		"salience-floor": unit("salience floor", 0.15),
		"postcode-exclude": { type: "string", default: "US", description: "Excluded postcode countries" },
		"max-zoom": {
			type: "number",
			default: 12,
			validate: (value) => Number.isInteger(value) && value >= 0 && value <= MAX_TILE_ZOOM,
			description: "Max zoom",
		},
		out: {
			type: "string",
			default: resolvePath(dataRootPath("coverage", "coverage-us.pmtiles")),
			description: "Output PMTiles",
		},
		"keep-ndjson": { type: "boolean", default: false, description: "Keep NDJSON" },
		threads: {
			type: "number",
			validate: (value) => Number.isInteger(value) && value > 0,
			description: "Worker threads",
		},
	},
} as const satisfies CommandSpec

/**
 * Builds the coverage tiles and renders progress and a summary.
 */
const CoverageBuild: CommandComponent<typeof spec> = ({ options }) => {
	const [stage, setStage] = useState<{ name: string; message: string }>()

	const state = useCommandTask(async () => {
		const { buildCoverageTiles } = await import("#coverage/core")

		const rollup = splitNumberList(options.rollup).filter((n) => Number.isInteger(n) && n < options.fineRes)

		return buildCoverageTiles(
			{
				states: options.states,
				excludeStates: extractDelimited(options.excludeStates),
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
				wofDB: options.postcode ? options.wofDB : null,
				postcodeCeiling: options.postcodeCeiling,
				salienceFloor: options.salienceFloor,
				postcodeExcludeCountries: extractDelimited(options.postcodeExclude),
				tileMaxZoom: options.maxZoom,
				out: options.out,
				keepNdjson: options.keepNdjson,
				threads: options.threads,
			},
			(name, message) => setStage({ name, message })
		)
	})

	if (state.status === "error") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		const done = state.result

		return (
			<Box flexDirection="column">
				<Text>
					<Text color="green">✓</Text> {done.features.toLocaleString()} features · {done.domainCells.toLocaleString()}{" "}
					cells ({done.withPoints.toLocaleString()} with points, {done.streetOnly.toLocaleString()} street-only,{" "}
					{done.postcodeCells.toLocaleString()} postcode) · {ByteFormatter.formatIEC(done.pmtilesBytes)}
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
