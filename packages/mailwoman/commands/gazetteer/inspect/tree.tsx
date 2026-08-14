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
import type { PlacetypeRole } from "@mailwoman/core"
import { PlacetypeRoles } from "@mailwoman/core/placetypes"
import { Box, Text } from "ink"
import {
	type CommandSpec,
	type ParsedCommandComponent,
	CommandError,
	parseRoles,
	useCommandTask,
} from "mailwoman/cli-kit"
import { PathBuilder } from "path-ts"

const BATCH_SIZE = availableParallelism()

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "tree",
	description: "Render a WOF placetype tree.",
	positionals: [
		{ name: "local-repo-directory", required: true, description: "Placetype repository" },
		{ name: "placetype", required: true, description: "Root placetype" },
	],
	options: {
		roles: { type: "string", description: `Role filter: ${PlacetypeRoles.join(", ")}` },
		output: { type: "string", description: "Output JSON" },
		compact: { type: "boolean", default: false, description: "Emit compact JSON" },
	},
} as const satisfies CommandSpec

interface Options {
	roles?: string
	output?: string
	compact: boolean
}

const WOFTree: ParsedCommandComponent<Options, [string, string]> = ({ args, options }) => {
	const placetypeName = args[1]

	const state = useCommandTask(async () => {
		const { generatePlacetypeTree, Placetype } = await import("@mailwoman/core")

		const localRepoDirectory = PathBuilder.from(args[0])

		const roles: PlacetypeRole[] | undefined = parseRoles(options.roles)

		await Placetype.prepare({ batchSize: BATCH_SIZE, localRepoDirectory })

		const placetype = Placetype.find(placetypeName)

		if (!placetype) {
			throw new CommandError(
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
