/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate a corpus overlay manifest.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
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
		split: {
			type: "string",
			description: "Split per parquet, comma-separated. Unset puts every file in train.",
		},
		note: { type: "string", required: true, description: "Manifest note" },
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { assembleOverlayManifest } = await import("@mailwoman/corpus/tools")

		const parquets = extractDelimited(options.parquet)
		const sources = extractDelimited(options.source)
		const splits = options.split ? extractDelimited(options.split) : []

		if (parquets.length !== sources.length) {
			throw new CommandError(
				`--parquet names ${parquets.length} parquet files and --source ${sources.length} labels; one label per file`
			)
		}

		if (splits.length && splits.length !== parquets.length) {
			throw new CommandError(
				`--split names ${splits.length} splits and --parquet ${parquets.length} files; give one split per file or omit the flag`
			)
		}

		const unknown = splits.filter((split) => split !== "train" && split !== "val" && split !== "test")

		if (unknown.length) {
			throw new CommandError(`--split takes train, val or test; got ${unknown.join(", ")}`)
		}

		await assembleOverlayManifest({
			base: options.base,
			newDir: options.newDir,
			modalRoot: options.modalRoot,
			version: options.corpusVersion,
			files: parquets.map((parquet, index) => ({
				parquet,
				source: sources[index]!,
				split: (splits[index] ?? "train") as "train" | "val" | "test",
			})),
			note: options.note,
		})

		return "done"
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
