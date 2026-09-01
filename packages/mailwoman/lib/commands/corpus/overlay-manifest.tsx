/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate a corpus overlay manifest.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

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
			description: "Modal volume root the manifest paths are relative to",
		},
		"corpus-version": { type: "string", required: true, description: "New corpus version" },
		"slice-parquet": { type: "string", required: true, description: "The ONE slice parquet to add" },
		source: { type: "string", required: true, description: "Slice source label" },
		note: { type: "string", required: true, description: "Manifest note" },
	},
} as const satisfies CommandSpec

interface Options {
	base: string
	newDir: string
	modalRoot: string
	corpusVersion: string
	sliceParquet: string
	source: string
	note: string
}

const Cmd: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { assembleOverlayManifest } = await import("@mailwoman/corpus/tools")

		await assembleOverlayManifest({
			base: options.base,
			newDir: options.newDir,
			modalRoot: options.modalRoot,
			version: options.corpusVersion,
			sliceParquet: options.sliceParquet,
			source: options.source,
			note: options.note,
		})

		return "done"
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
