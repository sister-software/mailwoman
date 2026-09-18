/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman coverage build` — bake the demo map's "fog of war" address-coverage H3 hexbin tileset
 *   (PMTiles) from the per-state address-point (+ interpolation) databases. See `coverage-core.ts` for the
 *   pipeline + fog model. Publish the result with `mailwoman tiles publish`.
 *
 *   Maintainer-only: needs the local databases + `tippecanoe` on PATH + the @duckdb/node-api dev dep.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { dataRootPath } from "@mailwoman/core/data-root"
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
 * The coarsest and finest H3 resolutions the library defines. A cell index outside 0–15 is not a
 * resolution the H3 bindings can address, so this bound is the format's rather than a tuning choice.
 */
const MAX_H3_RESOLUTION = 15

/**
 * The deepest zoom a tile pyramid addresses. Tippecanoe and the Web Mercator tile scheme both stop at
 * 22, so a higher value names a tile no renderer will request.
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
 * The command-line contract the filesystem command router reads for `mailwoman coverage build`.
 *
 * Its option names and descriptions are the source the CLI reference page is generated from, so a
 * rename here moves `docs/articles/developers/reference/cli.mdx` and the docs check refuses the drift.
 */
export const spec = {
	name: "build",
	description: "Build address-coverage PMTiles.",
	options: {
		states: { type: "string", default: "all", description: "State slugs" },
		"exclude-states": { type: "string", default: "AK", description: "Excluded states" },
		"data-root": {
			type: "string",
			default: resolvePath(dataRootPath("address-points")),
			description: "Address-point root",
		},
		interp: { type: "boolean", default: true, description: "Blend interpolation" },
		"interp-root": {
			type: "string",
			default: resolvePath(dataRootPath("interpolation")),
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
			default: resolvePath(dataRootPath("wof", "admin-global-priority-importance.db")),
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
