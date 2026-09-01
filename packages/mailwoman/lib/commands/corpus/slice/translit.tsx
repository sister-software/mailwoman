/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus slice translit` — build per-script parquet slices from the DeepSeek-generated
 *   transliteration JSONL (one slice per `deepseek-translit-<slug>` source) and emit the combined
 *   corpus MANIFEST. Sibling of `corpus slice kryptonite`; also canonicalizes legacy base-slice
 *   paths (`$MAILWOMAN_DATA_ROOT/…` → `/data/…`).
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "translit",
	description: "Build transliteration corpus slices and their combined manifest.",
	options: {
		jsonl: { type: "string", required: true, description: "Canonical transliteration JSONL to slice" },
		"base-manifest": {
			type: "string",
			required: true,
			description: "Base corpus MANIFEST.json whose slices carry forward",
		},
		"out-dir": {
			type: "string",
			required: true,
			description: "Output directory (slices land under corpus-v<version>/train/)",
		},
		"corpus-version": { type: "string", default: "0.4.0", description: "Corpus version stamped into rows + MANIFEST" },
		"canonical-path-prefix": {
			type: "string",
			default: "/data/",
			description: "Prefix replacing legacy base-slice paths",
		},
		"legacy-path-prefix": {
			type: "string",
			description: "Legacy base-slice path prefix to rewrite (default: $MAILWOMAN_DATA_ROOT)",
		},
	},
} as const satisfies CommandSpec

interface Options {
	jsonl: string
	baseManifest: string
	outDir: string
	corpusVersion: string
	canonicalPathPrefix: string
	legacyPathPrefix?: string
}

const CorpusSliceTranslit: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildTranslitSlice } = await import("@mailwoman/corpus/tools")

		await buildTranslitSlice(
			{
				jsonl: options.jsonl,
				baseManifest: options.baseManifest,
				outDir: options.outDir,
				corpusVersion: options.corpusVersion,
				canonicalPathPrefix: options.canonicalPathPrefix,
				legacyPathPrefix: options.legacyPathPrefix,
			},
			(line) => console.error(line)
		)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") return <Text color="green">✓ transliteration slices built → {options.outDir}</Text>

	return null
}

export default CorpusSliceTranslit
