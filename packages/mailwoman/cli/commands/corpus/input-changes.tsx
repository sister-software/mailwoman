/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus input-changes --manifest <MANIFEST.json> --source wof-admin` lists the input files that changed
 *   since the source's corpus files were built: each checkout's commits since the recorded one, then its uncommitted
 *   files, with the WOF id at the start of each file name.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { isPresent } from "@mailwoman/core/objects"
import { Box, Text } from "ink"

import { type CommandComponent, type CommandSpec, CommandTaskResult, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "input-changes",
	description: "List the input files and WOF ids that changed since a corpus source's files were built.",
	options: {
		manifest: { type: "string", required: true, description: "The corpus MANIFEST.json to compare" },
		source: { type: "string", required: true, description: "The manifest source to compare, such as wof-admin" },
		input: {
			type: "string",
			default: dataRootPath("src", "wof-repos").toString(),
			description: "The directory of git checkouts the source was read from",
		},
		at: {
			type: "string",
			description: "When the records store no commits: the time the rows were read, as git's --before accepts it",
		},
		out: { type: "string", description: "Write one JSONL line per changed file" },
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { listInputChanges } = await import("@mailwoman/corpus/tools/input-changes")

		const result = await listInputChanges({
			manifestPath: options.manifest,
			source: options.source,
			inputRoot: options.input,
			at: options.at,
		})

		if (options.out) {
			await writeLocalJSONLFile(
				result.checkouts.flatMap((checkout) => checkout.changed),
				options.out
			)
		}

		return result
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	const { source, files, origin, checkouts, missing } = state.result
	const changed = checkouts.filter((checkout) => checkout.changed.length)
	const ids = new Set(changed.flatMap((checkout) => checkout.changed.map((file) => file.wofID)).filter(isPresent))

	return (
		<Box flexDirection="column">
			<Text>
				{`${source}: ${files} files, base commits ${origin}; ${changed.length} of ${checkouts.length} checkouts changed, ${ids.size.toLocaleString()} WOF ids`}
			</Text>

			{changed.map((checkout) => {
				const committed = checkout.changed.filter((file) => file.change === "committed").length

				return (
					<Text key={checkout.checkout}>
						{`  ${checkout.checkout}  ${checkout.base?.slice(0, 10) ?? "none"}..${checkout.head.slice(0, 10)}  committed ${committed}  uncommitted ${checkout.changed.length - committed}`}
					</Text>
				)
			})}

			{missing.map((checkout) => (
				<Text key={checkout}>{`  ${checkout}  recorded, absent from the input directory`}</Text>
			))}
		</Box>
	)
}

export default Cmd
