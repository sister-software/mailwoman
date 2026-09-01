/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus slice kryptonite` — build a parquet slice from the DeepSeek-generated
 *   kryptonite JSONL and emit the combined corpus MANIFEST (base slices + the new slice). See
 *   docs/engineering/reference/CORPUS_V0_4_0_GENERATION.md for the reproducibility contract.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "kryptonite",
	description: "Build a corpus slice from canonical kryptonite JSONL.",
	options: {
		jsonl: { type: "string", required: true, description: "Canonical kryptonite JSONL to slice" },
		"base-manifest": {
			type: "string",
			required: true,
			description: "Base corpus MANIFEST.json whose slices carry forward",
		},
		"out-dir": {
			type: "string",
			required: true,
			description: "Output directory (slices land under corpus-v<version>/)",
		},
		"corpus-version": { type: "string", default: "0.4.0", description: "Corpus version stamped into rows + MANIFEST" },
		source: { type: "string", default: "deepseek-kryptonite", description: "Source tag stamped on the new slice(s)" },
	},
} as const satisfies CommandSpec

interface Options {
	jsonl: string
	baseManifest: string
	outDir: string
	corpusVersion: string
	source: string
}

const CorpusSliceKryptonite: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildKryptoniteSlice } = await import("@mailwoman/corpus/tools")

		await buildKryptoniteSlice(
			{
				jsonl: options.jsonl,
				baseManifest: options.baseManifest,
				outDir: options.outDir,
				corpusVersion: options.corpusVersion,
				source: options.source,
			},
			(line) => console.error(line)
		)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") return <Text color="green">✓ kryptonite slice built → {options.outDir}</Text>

	return null
}

export default CorpusSliceKryptonite
