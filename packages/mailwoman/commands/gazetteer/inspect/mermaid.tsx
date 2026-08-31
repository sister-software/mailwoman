/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman wof mermaid <localRepoDir> <placetype>` — render a Mermaid flowchart of the WOF
 *   placetype hierarchy rooted at the given placetype.
 *
 *   Reads from the local `whosonfirst-placetypes` clone produced by `mailwoman wof sync`. Pass
 *   `--roles` to restrict the chart to specific roles (e.g. `common`, `common_optional`) and
 *   `--output` to write the markup to a file instead of stdout.
 */

import { Spinner } from "@inkjs/ui"
import type { InterpolateColorCallback, PlacetypeRole } from "@mailwoman/core"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { PlacetypeRoles } from "@mailwoman/core/placetypes"
import { availableParallelism } from "@mailwoman/core/utils/system"
import { Box, Text } from "ink"
import { PathBuilder } from "path-ts"

import { CommandError, type CommandSpec, parseRoles, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

const BATCH_SIZE = availableParallelism()

/**
 * Auto-discover d3-scale-chromatic's sequential interpolators so callers can pass e.g. `--interpolator viridis` and we
 * map it to `interpolateViridis`. Categorical scales (`scheme*`) are deliberately excluded — they're string[]s, not
 * (t)=>string.
 */
async function loadD3Interpolators(): Promise<Record<string, InterpolateColorCallback>> {
	const d3Chromatic = await import("d3-scale-chromatic")
	const out: Record<string, InterpolateColorCallback> = {}

	for (const [key, value] of Object.entries(d3Chromatic)) {
		if (!key.startsWith("interpolate") || typeof value !== "function") continue
		out[key.slice("interpolate".length).toLowerCase()] = value as InterpolateColorCallback
	}

	return out
}

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "mermaid",
	description: "Generate a Mermaid placetype hierarchy",
	positionals: [
		{ name: "localRepoDirectory", required: true, description: "Local whosonfirst-placetypes clone" },
		{ name: "placetype", required: true, description: "Placetype to use as the hierarchy root" },
	],
	options: {
		roles: { type: "string", description: `Comma-separated role filter: ${PlacetypeRoles.join(", ")}` },
		output: { type: "string", description: "Path to write the Mermaid markup to. Defaults to stdout." },
		interpolator: {
			type: "string",
			description: "d3-scale-chromatic sequential interpolator, such as viridis or turbo",
		},
	},
} as const satisfies CommandSpec

interface Options {
	roles?: string
	output?: string
	interpolator?: string
}

async function resolveInterpolator(raw: string | undefined): Promise<InterpolateColorCallback | undefined> {
	if (!raw) return undefined

	const interpolators = await loadD3Interpolators()
	const fn = interpolators[raw.toLowerCase()]

	if (!fn) {
		throw new CommandError(
			`Unknown interpolator '${raw}'. Available: ${Object.keys(interpolators).toSorted().join(", ")}.`
		)
	}

	return fn
}

const WOFMermaid: ParsedCommandComponent<Options, [string, string]> = ({ args, options }) => {
	const placetypeName = args[1]

	const state = useCommandTask(async () => {
		const { generateMermaidMarkup, Placetype } = await import("@mailwoman/core")

		if (!args[0]) {
			throw new CommandError("Missing required positional argument: <localRepoDirectory>")
		}

		const localRepoDirectory = PathBuilder.from(args[0])

		if (!placetypeName) {
			throw new CommandError("Missing required positional argument: <placetype>")
		}

		const roles: PlacetypeRole[] | undefined = parseRoles(options.roles)
		const interpolator: InterpolateColorCallback | undefined = await resolveInterpolator(options.interpolator)

		await Placetype.prepare({ batchSize: BATCH_SIZE, localRepoDirectory })

		const placetype = Placetype.find(placetypeName)

		if (!placetype) {
			throw new CommandError(
				`No placetype named '${placetypeName}' found. Ensure '${localRepoDirectory.toString()}' contains a clone of whosonfirst/whosonfirst-placetypes (run \`mailwoman wof sync\` first).`
			)
		}

		const chart = generateMermaidMarkup(placetype, { roles, edgeInterpolator: interpolator })

		if (options.output) {
			await writeLocalFile(chart + "\n", options.output)
		} else {
			// Write Mermaid directly to stdout so long classDef / linkStyle lines aren't
			// word-wrapped by Ink's <Text> renderer — Mermaid won't parse a broken line.
			process.stdout.write(chart + "\n")
		}

		return chart
	})

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	if (state.status === "running") {
		return <Spinner />
	}

	if (options.output) {
		return (
			<Box flexDirection="column">
				<Text>
					Wrote Mermaid markup for placetype <Text bold>{placetypeName!}</Text> to <Text bold>{options.output}</Text>.
				</Text>
			</Box>
		)
	}

	// Stdout path: markup is written above via process.stdout.write; render nothing through Ink.
	return null
}

export default WOFMermaid
