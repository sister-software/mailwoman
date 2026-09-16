/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate a corpus overlay manifest.
 */

import { CommandError } from "@mailwoman/core/scripting/command"

import { type CommandSpec, CommandTaskResult, type CommandComponent, splitList, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "overlay-manifest",
	description: "Assemble an overlay corpus manifest.",
	options: {
		base: { type: "string", required: true, description: "Base corpus manifest path" },
		"new-dir": { type: "string", required: true, description: "New overlay corpus dir" },
		"modal-root": {
			type: "string",
			required: true,
			description: "Remote path of --new-dir, e.g. /data/corpus/versioned/<version>/corpus-<version>",
		},
		"corpus-version": { type: "string", required: true, description: "New corpus version" },
		parquet: {
			type: "string",
			required: true,
			description: "Parquet files to add, comma-separated",
			deprecatedName: "slice-parquet",
		},
		source: { type: "string", required: true, description: "Source label per parquet, comma-separated" },
		note: { type: "string", required: true, description: "Manifest note" },
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { assembleOverlayManifest } = await import("@mailwoman/corpus/tools")

		const parquets = splitList(options.parquet)
		const sources = splitList(options.source)

		if (parquets.length !== sources.length) {
			throw new CommandError(
				`--parquet names ${parquets.length} parquet files and --source ${sources.length} labels; one label per file`
			)
		}

		await assembleOverlayManifest({
			base: options.base,
			newDir: options.newDir,
			modalRoot: options.modalRoot,
			version: options.corpusVersion,
			slices: parquets.map((parquet, index) => ({ parquet, source: sources[index]! })),
			note: options.note,
		})

		return "done"
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
