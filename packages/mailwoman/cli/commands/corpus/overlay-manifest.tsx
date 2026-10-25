/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate a corpus overlay manifest.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"
import type { DuckDBLimits } from "@mailwoman/corpus/parquet/duckdb"

import {
	isCorpusVersion,
	positiveInteger,
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	useCommandTask,
} from "#cli-kit"

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
		"corpus-version": {
			type: "string",
			required: true,
			description: "New corpus version",
			validate: isCorpusVersion,
			validationMessage:
				"--corpus-version is the version alone, without the `corpus-v` prefix, as `0.7.0` or `0.7.0-de-holdout`.",
		},
		parquet: {
			type: "string",
			required: true,
			description: "Parquet files to add, comma-separated",
		},
		source: { type: "string", required: true, description: "Source label per parquet, comma-separated" },
		"split-attribute": {
			type: "string",
			description:
				"Split attribute files `corpus split-overlay` wrote under --new-dir, comma-separated. Each names its parquet, which then holds every split's rows at <new-dir>/<parquet>. A parquet without one is train, at <new-dir>/train/<parquet>.",
		},
		note: { type: "string", required: true, description: "Manifest note" },
		"unshippable-reason": {
			type: "string",
			description:
				"Admit sources whose register rows lack an elected decision permitting transform and train, for a " +
				"local experiment. States why; the manifest records the corpus as not shippable",
		},
		deletions: {
			type: "string",
			description:
				"A JSON file holding an array of deletions, each with a target ({path} or {source}), sourceIDs or a sourceIDsFile parquet, a reason and an issue (#<number>). The loader drops those rows by source_id.",
		},
		"replace-source": {
			type: "string",
			description:
				"Base sources to drop, comma-separated. The base's files with each source leave the manifest and its counts, so the added files take their place.",
		},
		"duckdb-memory-gib": {
			type: "number",
			validate: (value: number) => Number.isFinite(value) && value > 0,
			validationMessage: "--duckdb-memory-gib must be a positive number of GiB.",
			description:
				"Memory limit in GiB of each DuckDB connection the assembly opens. Defaults to DUCKDB_MEMORY_SHARE (a quarter) of host memory",
		},
		"duckdb-threads": {
			type: "number",
			validate: positiveInteger,
			validationMessage: "--duckdb-threads must be a positive integer.",
			description:
				"Threads of each DuckDB connection the assembly opens. Defaults to DUCKDB_THREAD_SHARE (a quarter) of the host's threads",
		},
	},
} as const satisfies CommandSpec

/**
 * The DuckDB limits the two `--duckdb-*` options state, in {@linkcode DuckDBLimits}'s units.
 *
 * An omitted option stays absent so `openDuckDB` applies its stated default.
 */
export function overlayDuckDBLimits(options: { duckdbMemoryGib?: number; duckdbThreads?: number }): DuckDBLimits {
	return {
		...(typeof options.duckdbMemoryGib === "number"
			? { memoryLimitBytes: Math.floor(options.duckdbMemoryGib * 2 ** 30) }
			: {}),
		...(typeof options.duckdbThreads === "number" ? { threads: options.duckdbThreads } : {}),
	}
}

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { assembleOverlayManifest } = await import("@mailwoman/corpus/tools/overlay/manifest")
		const { readDeletionRequests } = await import("@mailwoman/corpus/tools/overlay/deletions")

		const parquets = extractDelimited(options.parquet)
		const sources = extractDelimited(options.source)
		const { readSplitAttribute } = await import("@mailwoman/corpus/tools/overlay/split-attribute")
		const { resolvePath } = await import("path-ts")

		if (parquets.length !== sources.length) {
			throw new CommandError(
				`--parquet names ${parquets.length} parquet files and --source ${sources.length} labels; one label per file`
			)
		}

		// Each attribute file states the parquet it describes, so the flag needs no positional pairing.
		const attributeFor = new Map<string, string>()

		for (const name of options.splitAttribute ? extractDelimited(options.splitAttribute) : []) {
			const attribute = await readSplitAttribute(resolvePath(options.newDir, name))

			if (!parquets.includes(attribute.file.name)) {
				throw new CommandError(`${name} describes ${attribute.file.name}, which --parquet does not list`)
			}

			attributeFor.set(attribute.file.name, name)
		}

		await assembleOverlayManifest({
			base: options.base,
			newDir: options.newDir,
			modalRoot: options.modalRoot,
			version: options.corpusVersion,
			files: parquets.map((parquet, index) => ({
				parquet,
				source: sources[index]!,
				splitAttribute: attributeFor.get(parquet),
			})),
			note: options.note,
			replaceSources: options.replaceSource ? extractDelimited(options.replaceSource) : [],
			unshippableReason: options.unshippableReason,
			deletions: options.deletions ? await readDeletionRequests(options.deletions) : [],
			limits: overlayDuckDBLimits(options),
		})

		return "done"
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
