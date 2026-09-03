/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build nsul` — the GB UPRN → unit-postcode register (`nsul.db`): the ONS
 *   National Statistics UPRN Lookup joined to OS Open UPRN's coordinates, under the layer contract.
 *   Reads a hand-acquired archive from a vintage-dated `<data-root>/nsul/<YYYY-MM>/` directory
 *   (there is no download step — the portal item is fetched by hand beside its `.md5` sidecar and
 *   `item.json`), verifies it against the sidecar, and writes a sealed, atomically-swapped artifact.
 *   Nothing on the parse/resolve path reads it yet; the runtime surface is a separate proposal
 *   (#1975, F4).
 *
 *   Coverage is England, Scotland and Wales; Northern Ireland postcode data is outside ONS's open
 *   terms, and the layer's own coverage rows say so. See `gazetteer-pipeline/nsul-layer.ts` for the
 *   checks (md5, exact header per region, the eleven-region set, accounting identity, row floor).
 *
 *   The pipeline module is lazy-imported so `--help` never faults without the optional
 *   `@mailwoman/resolver-wof-sqlite` peer.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers"
import { Box, Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	phaseReporter,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "nsul",
	description: "Build the ONS NSUL UPRN-to-postcode layer database (GB).",
	options: {
		"source-dir": {
			type: "string",
			description: "Acquisition dir holding NSUL_E<epoch>_<MON>_<YYYY>.zip. Default: newest <data-root>/nsul/<YYYY-MM>",
		},
		out: { type: "string", description: "Output path. Default <data-root>/nsul/nsul.db" },
		"uprn-db": {
			type: "string",
			description: "The uprn.db to take coordinates from. Default <data-root>/uprn/uprn.db",
		},
	},
} as const satisfies CommandSpec

interface Options {
	sourceDir?: string
	out?: string
	uprnDB?: string
}

const GazetteerBuildNSUL: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { repoRootPath } = await import("@mailwoman/core/utils")
		const { buildSHA } = await import("#gazetteer/stamp-manifest")
		const { buildNSULLayer, NSUL_COVERAGE_NOTE, nsulVintageLabel } = await import("#gazetteer/nsul-layer")

		const result = await buildNSULLayer({
			sourceDir: options.sourceDir,
			out: options.out,
			uprnDatabasePath: options.uprnDB,
			buildSHA: buildSHA(String(repoRootPath())),
			onPhase: phaseReporter(),
		})

		const regions = Object.entries(result.readByRegion)
			.map(([region, count]) => `${region} ${count.toLocaleString()}`)
			.join(" · ")

		return [
			`nsul layer: ${result.out} (${await formatFileSize(result.out)})`,
			`${result.inserted.toLocaleString()} UPRN→postcode rows — NSUL ${nsulVintageLabel(result.vintage)}, coordinates from uprn.db ${result.uprnLayerVersion}`,
			`read ${result.read.toLocaleString()} = inserted ${result.inserted.toLocaleString()} + malformed ${result.skippedMalformed.toLocaleString()} + duplicate ${result.skippedDuplicate.toLocaleString()} + no-postcode ${result.skippedNoPostcode.toLocaleString()} + no-coordinate ${result.skippedNoCoordinate.toLocaleString()}`,
			`by region: ${regions}`,
			`coverage ${result.coverageCells.toLocaleString()} res-6 cells (basis: designated)`,
			`archive md5 ${result.archiveMD5}`,
			result.mismatches.length ? `CHECK VIOLATIONS: ${result.mismatches.join(" · ")}` : "every check holds",
			NSUL_COVERAGE_NOTE,
			"licence + the four NSUL attribution statements in the layer manifest",
			result.sealed ? "sealed 0444" : "NOT SEALED",
			`${(result.durationMs / 1000).toFixed(0)} s`,
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

export default GazetteerBuildNSUL
