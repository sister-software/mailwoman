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
import { setImmediate } from "node:timers/promises"

import { Spinner } from "@inkjs/ui"
import { generatePlacetypeTree, Placetype, type PlacetypeRole, PlacetypeRoles } from "@mailwoman/core"
import { Box, Text } from "ink"
import { PathBuilder } from "path-ts"
import { useEffect, useMemo, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../../cli-kit/index.ts"

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
			throw new Error(`Unknown placetype role '${role}'. Valid roles: ${PlacetypeRoles.join(", ")}.`)
		}
	}

	return parsed as PlacetypeRole[]
}

const WOFTree: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) => {
	const [done, setDone] = useState(false)
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

		try {
			roles = parseRoles(options.roles)
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

			const tree = generatePlacetypeTree(placetype, roles)
			const serialized = options.compact ? JSON.stringify(tree) : JSON.stringify(tree, null, 2)

			if (options.output) {
				await fs.writeFile(options.output, serialized + "\n", "utf8")
			} else {
				// Write JSON directly to stdout so Ink's <Text> renderer doesn't word-wrap long
				// lines (compact mode is one very long line; pretty mode is fine either way).
				process.stdout.write(serialized + "\n")
			}

			setDone(true)
		})().catch((err) => setError((err as Error).message))
	}, [localRepoDirectory, placetypeName, options.roles, options.output, options.compact])

	useEffect(() => {
		if (!error) return
		setImmediate().then(() => process.exit(1))
	}, [error])

	useEffect(() => {
		if (!done) return

		if (options.output) return // let Ink render the success summary; exit naturally
		setImmediate().then(() => process.exit(0))
	}, [done, options.output])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (!done) {
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
