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
import {
	generateMermaidMarkup,
	type InterpolateColorCallback,
	Placetype,
	type PlacetypeRole,
	PlacetypeRoles,
} from "@mailwoman/core"
import * as d3Chromatic from "d3-scale-chromatic"
import { Box, Text } from "ink"
import * as fs from "node:fs/promises"
import { availableParallelism } from "node:os"
import { setImmediate } from "node:timers/promises"
import { PathBuilder } from "path-ts"
import { useEffect, useMemo, useState } from "react"
import zod from "zod"
import type { CommandComponent } from "../../sdk/cli.js"

const BATCH_SIZE = availableParallelism()

// Auto-discover d3-scale-chromatic's sequential interpolators so callers can pass
// e.g. `--interpolator viridis` and we map it to `interpolateViridis`. Categorical
// scales (`scheme*`) are deliberately excluded — they're string[]s, not (t)=>string.
const D3_INTERPOLATORS: Record<string, InterpolateColorCallback> = (() => {
	const out: Record<string, InterpolateColorCallback> = {}
	for (const [key, value] of Object.entries(d3Chromatic)) {
		if (!key.startsWith("interpolate") || typeof value !== "function") continue
		out[key.slice("interpolate".length).toLowerCase()] = value as InterpolateColorCallback
	}
	return out
})()
const D3_INTERPOLATOR_NAMES = Object.keys(D3_INTERPOLATORS).sort()

const ArgumentsSchema = zod
	.array(zod.string())
	.describe(
		"Positional args: <localRepoDirectory> <placetype>. The directory should contain a clone of whosonfirst/whosonfirst-placetypes (run `mailwoman wof sync` first)."
	)

const OptionsSchema = zod.object({
	roles: zod
		.string()
		.optional()
		.describe(
			`Optional comma-separated role filter. One or more of: ${PlacetypeRoles.join(", ")}. Defaults to all roles.`
		),
	output: zod.string().optional().describe("Path to write the Mermaid markup to. Defaults to stdout."),
	interpolator: zod
		.string()
		.optional()
		.describe(
			"d3-scale-chromatic sequential interpolator that colors edges by depth from the root so lineage paths trace a smooth gradient. " +
				"Defaults to 'viridis'. Try 'turbo', 'plasma', 'cool', 'magma', etc. Node colors always use the hand-tuned role palette."
		),
})

export { ArgumentsSchema as args, OptionsSchema as options }

function resolveInterpolator(raw: string | undefined): InterpolateColorCallback | undefined {
	if (!raw) return undefined
	const fn = D3_INTERPOLATORS[raw.toLowerCase()]
	if (!fn) {
		throw new Error(`Unknown interpolator '${raw}'. Available: ${D3_INTERPOLATOR_NAMES.join(", ")}.`)
	}
	return fn
}

function parseRoles(raw: string | undefined): PlacetypeRole[] | undefined {
	if (!raw) return undefined

	const valid = new Set<string>(PlacetypeRoles)
	const parsed = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)

	for (const role of parsed) {
		if (!valid.has(role)) {
			throw new Error(`Unknown placetype role '${role}'. Valid roles: ${PlacetypeRoles.join(", ")}.`)
		}
	}

	return parsed as PlacetypeRole[]
}

const WOFMermaid: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) => {
	const [markup, setMarkup] = useState<string>()
	const [error, setError] = useState<string>()

	const localRepoDirectory = useMemo(() => (args[0] ? PathBuilder.from(args[0]) : null), [args])
	const placetypeName = args[1]

	useEffect(() => {
		if (!localRepoDirectory) {
			setError("Missing required positional argument: <localRepoDirectory>")
			return
		}

		if (!placetypeName) {
			setError("Missing required positional argument: <placetype>")
			return
		}

		let roles: PlacetypeRole[] | undefined
		let interpolator: InterpolateColorCallback | undefined
		try {
			roles = parseRoles(options.roles)
			interpolator = resolveInterpolator(options.interpolator)
		} catch (err) {
			setError((err as Error).message)
			return
		}

		;(async () => {
			await Placetype.prepare({ batchSize: BATCH_SIZE, localRepoDirectory })

			const placetype = Placetype.find(placetypeName)

			if (!placetype) {
				throw new Error(
					`No placetype named '${placetypeName}' found. Ensure '${localRepoDirectory.toString()}' contains a clone of whosonfirst/whosonfirst-placetypes (run \`mailwoman wof sync\` first).`
				)
			}

			const chart = generateMermaidMarkup(placetype, { roles, edgeInterpolator: interpolator })

			if (options.output) {
				await fs.writeFile(options.output, chart + "\n", "utf8")
			} else {
				// Write Mermaid directly to stdout so long classDef / linkStyle lines aren't
				// word-wrapped by Ink's <Text> renderer — Mermaid won't parse a broken line.
				process.stdout.write(chart + "\n")
			}

			setMarkup(chart)
		})().catch((err) => setError((err as Error).message))
	}, [localRepoDirectory, placetypeName, options.roles, options.output, options.interpolator])

	useEffect(() => {
		if (!error) return
		setImmediate().then(() => process.exit(1))
	}, [error])

	useEffect(() => {
		if (markup === undefined) return
		if (options.output) return // let Ink render the success summary; exit naturally
		setImmediate().then(() => process.exit(0))
	}, [markup, options.output])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (markup === undefined) {
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
