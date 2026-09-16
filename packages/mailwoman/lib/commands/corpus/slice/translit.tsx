/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus slice translit` — build per-script parquet files from the DeepSeek-generated
 *   transliteration JSONL (one file per `deepseek-translit-<slug>` source) and emit the combined
 *   corpus MANIFEST. Sibling of `corpus slice kryptonite`; also canonicalizes the base corpus's
 *   legacy parquet paths (`$MAILWOMAN_DATA_ROOT/…` → `/data/…`).
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "translit",
	description: "Build transliteration corpus parquet files and their combined manifest.",
	options: {
		jsonl: { type: "string", required: true, description: "Canonical transliteration JSONL to convert" },
		"base-manifest": {
			type: "string",
			required: true,
			description: "Base corpus MANIFEST.json whose parquet files carry forward",
		},
		"out-dir": {
			type: "string",
			required: true,
			description: "Output directory (parquet files land under corpus-v<version>/train/)",
		},
		"corpus-version": { type: "string", default: "0.4.0", description: "Corpus version stamped into rows + MANIFEST" },
		"canonical-path-prefix": {
			type: "string",
			default: "/data/",
			description: "Prefix replacing the base corpus's legacy parquet paths",
		},
		"legacy-path-prefix": {
			type: "string",
			description: "Legacy base-corpus parquet path prefix to rewrite (default: $MAILWOMAN_DATA_ROOT)",
		},
	},
} as const satisfies CommandSpec

const CorpusTranslitParquet: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildTranslitOverlay } = await import("@mailwoman/corpus/tools")

		await buildTranslitOverlay(
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

	if (state.status === "done")
		return <Text color="green">✓ transliteration parquet files built → {options.outDir}</Text>

	return null
}

export default CorpusTranslitParquet
