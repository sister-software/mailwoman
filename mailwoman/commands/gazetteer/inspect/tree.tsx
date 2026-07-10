/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman wof tree <localRepoDir> <placetype>` — emit a nested JSON tree of the WOF placetype
 *   hierarchy rooted at the given placetype.
 *
 *   Reads from the local `whosonfirst-placetypes` clone produced by `mailwoman wof sync`. `--roles`
 *   restricts descendants to specific roles; `--output` writes to a file instead of stdout;
 *   `--compact` disables pretty-printing.
 */

import * as fs from "node:fs/promises"
import { availableParallelism } from "node:os"

import { Spinner } from "@inkjs/ui"
import { generatePlacetypeTree, Placetype, type PlacetypeRole, PlacetypeRoles } from "@mailwoman/core"
import { Box, Text } from "ink"
import { PathBuilder } from "path-ts"
import zod from "zod"

import { commandError, type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const BATCH_SIZE = availableParallelism()

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
	output: zod.string().optional().describe("Path to write the JSON tree to. Defaults to stdout."),
	compact: zod
		.boolean()
		.optional()
		.default(false)
		.describe("Emit single-line JSON instead of pretty-printed (indent = 2)."),
})

export { ArgumentsSchema as args, OptionsSchema as options }

function parseRoles(raw: string | undefined): PlacetypeRole[] | undefined {
	if (!raw) return undefined

	const valid = new Set<string>(PlacetypeRoles)
	const parsed = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)

	for (const role of parsed) {
		if (!valid.has(role)) {
			throw commandError(`Unknown placetype role '${role}'. Valid roles: ${PlacetypeRoles.join(", ")}.`)
		}
	}

	return parsed as PlacetypeRole[]
}

const WOFTree: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) => {
	const placetypeName = args[1]

	const state = useCommandTask(async () => {
		if (!args[0]) {
			throw commandError("Missing required positional argument: <localRepoDirectory>")
		}

		const localRepoDirectory = PathBuilder.from(args[0])

		if (!placetypeName) {
			throw commandError("Missing required positional argument: <placetype>")
		}

		const roles: PlacetypeRole[] | undefined = parseRoles(options.roles)

		await Placetype.prepare({ batchSize: BATCH_SIZE, localRepoDirectory })

		const placetype = Placetype.find(placetypeName)

		if (!placetype) {
			throw commandError(
				`No placetype named '${placetypeName}' found. Ensure '${localRepoDirectory.toString()}' contains a clone of whosonfirst/whosonfirst-placetypes (run \`mailwoman wof sync\` first).`
			)
		}

		const tree = generatePlacetypeTree(placetype, roles)
		const serialized = options.compact ? JSON.stringify(tree) : JSON.stringify(tree, null, 2)

		if (options.output) {
			await fs.writeFile(options.output, serialized + "\n", "utf8")
		} else {
			// Write JSON directly to stdout so Ink's <Text> renderer doesn't word-wrap long
			// lines (compact mode is one very long line; pretty mode is fine either way).
			process.stdout.write(serialized + "\n")
		}
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
					Wrote JSON tree for placetype <Text bold>{placetypeName!}</Text> to <Text bold>{options.output}</Text>.
				</Text>
			</Box>
		)
	}

	// Stdout path: JSON is written above via process.stdout.write; render nothing through Ink.
	return null
}

export default WOFTree
