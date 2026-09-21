/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman data sources [<bundle...>]` — read the publisher stamp on the rows of a downloaded bundle and print it
 *   beside the publishers its record names.
 *
 *   `data --list` and `data pull` print what the record says. This prints what the bytes say, which is the check the
 *   record had none of: the `us` bundle's record named the Census Bureau and OpenAddresses while 68.2% of its
 *   125,276,536 rows were stamped `overture:NAD`.
 *
 *   Read-only and offline. It opens the copy in the data root and nothing else.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask, writeRawStdout } from "#cli-kit"
import { BUNDLES } from "#data/bundles"
import { censusBundleSources, renderSourceCensus } from "#data/sources"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "sources",
	description: "Read the publisher stamp on a downloaded bundle's rows",
	positionals: [
		{ name: "bundle", multiple: true, description: `Bundle names. Default: ${Object.keys(BUNDLES).join(", ")}` },
	],
	options: {
		"data-root": { type: "string", description: "Override the data root" },
	},
} as const satisfies CommandSpec

const DataSources: CommandComponent<typeof spec> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const { mailwomanDataRoot } = await import("@mailwoman/core/utils")
		const dataRoot = options.dataRoot ?? mailwomanDataRoot()
		const names = args.length ? args : Object.keys(BUNDLES)

		const lines: string[] = [
			"What the rows say about who published them, from your copy in the data root.",
			"",
			`Data root: ${dataRoot}`,
			"",
		]

		for (const name of names) {
			const bundle = BUNDLES[name]

			if (!bundle) {
				lines.push(`${name}: no such bundle. Known: ${Object.keys(BUNDLES).join(", ")}`, "")

				continue
			}

			lines.push(...renderSourceCensus(await censusBundleSources(bundle, dataRoot), bundle.rights.publishers), "")
		}

		lines.push(
			"A stamp the record does not name is a publisher whose terms nobody read against this bundle.",
			"This reports your copy. It is not a statement about what the published artifact contains."
		)

		writeRawStdout(`${lines.join("\n")}\n`)

		return { ok: true }
	})

	if (state.status !== "done") {
		return <CommandTaskResult state={state} running={<Text color="gray">reading…</Text>} />
	}

	return null
}

export default DataSources
