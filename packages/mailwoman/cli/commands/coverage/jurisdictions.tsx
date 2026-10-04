/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Implements `mailwoman coverage jurisdictions`, which builds the jurisdiction coverage PMTiles:
 *   Natural Earth map units carrying a training run's realized draws, the register's sources,
 *   the address system and the board rows of each jurisdiction.
 *
 *   The command requires `tippecanoe` on the path. `mailwoman tiles publish` uploads the result.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { dataRootPath } from "@mailwoman/core/data-root"
import { repoRootPath } from "@mailwoman/core/paths"
import { readScopeConfig } from "@mailwoman/core/scope-config"
import { Box, Text } from "ink"
import { resolvePath } from "path-ts"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * The maximum zoom level that Tippecanoe supports.
 */
const MAX_TILE_ZOOM = 22

/**
 * The command specification for `mailwoman coverage jurisdictions`.
 *
 * The CLI reference page `docs/articles/developers/reference/cli.mdx` is generated
 * from these option names and descriptions.
 * The docs check fails when the page is stale.
 */
export const spec = {
	name: "jurisdictions",
	description: "Build jurisdiction coverage PMTiles.",
	options: {
		exposure: {
			type: "string",
			default: resolvePath(dataRootPath("exposure", "exposure-realized-v720.json")),
			description: "Realized-draws report",
		},
		config: { type: "string", description: "Training config" },
		"max-zoom": {
			type: "number",
			default: 7,
			validate: (value) => Number.isInteger(value) && value >= 0 && value <= MAX_TILE_ZOOM,
			description: "Max zoom",
		},
		out: {
			type: "string",
			default: resolvePath(dataRootPath("coverage", "jurisdictions-v1.pmtiles")),
			description: "Output PMTiles",
		},
	},
} as const satisfies CommandSpec

/**
 * Builds the jurisdiction tiles and renders a summary.
 */
const CoverageJurisdictions: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildJurisdictionTiles } = await import("#tools/coverage/jurisdictions")
		const { fetchNaturalEarthFile, readNaturalEarthMapUnits } = await import("#tools/coverage/natural-earth")
		const { readAddressSystemRegistry } = await import("#tools/dev-tools/codex/address/systems")

		const systems = await readAddressSystemRegistry()

		if (!systems) throw new Error("the address-system registry is missing; run `mailwoman dev generate address-systems`")

		const { resolveTrainingConfig } = await import("#tools/coverage/census")
		const configPath = resolveTrainingConfig(await readScopeConfig(), { requested: options.config }).path

		return buildJurisdictionTiles({
			units: await readNaturalEarthMapUnits(await fetchNaturalEarthFile()),
			exposurePath: options.exposure,
			configPath,
			casesRoot: repoRootPath("packages", "mailwoman", "tools", "eval-harness", "gauntlet", "cases"),
			systems,
			out: options.out,
			maxZoom: options.maxZoom,
		})
	})

	if (state.status === "error") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		const done = state.result

		return (
			<Box flexDirection="column">
				<Text>
					<Text color="green">✓</Text> {done.features.toLocaleString()} map units ·{" "}
					{done.jurisdictions.toLocaleString()} jurisdictions · {ByteFormatter.formatIEC(done.pmtilesBytes)}
				</Text>
				<Text dimColor>
					{done.unownedUnits.length} units without a jurisdiction · jurisdictions without a unit:{" "}
					{done.unmappedJurisdictions.join(" ") || "none"}
				</Text>
				<Text dimColor>{done.out}</Text>
			</Box>
		)
	}

	return <Text>building jurisdiction tiles…</Text>
}

export default CoverageJurisdictions
