/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus run <adapter-id> --input <path> --out <dir> [--country XX] [--limit N]`
 *
 *   CLI shim around `runAdapter` from `@mailwoman/corpus`. Resolves `<adapter-id>` against the
 *   default registry. refuses with a clear, non-zero exit if the id isn't known (and lists the
 *   registered ids). On success, prints a one-line summary and the path to the manifest file.
 */

import { ProgressBar } from "@inkjs/ui"
import { isAlpha2CodeShape } from "@mailwoman/codex/country"
import { stringifyJSON } from "@mailwoman/core/json"
import { CommandError } from "@mailwoman/core/scripting/command"
import { Box, Text } from "ink"
import { useState } from "react"

import {
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	positiveIntegerOption,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "run",
	description: "Run one corpus adapter.",
	positionals: [{ name: "adapter-id", required: true, description: "Adapter id" }],
	options: {
		input: { type: "string", required: true, description: "Adapter input" },
		out: { type: "string", required: true, description: "Output root", deprecatedName: "output" },
		country: {
			type: "string",
			validate: isAlpha2CodeShape,
			validationMessage: "--country must be an ISO alpha-2 code.",
			description: "Country filter",
		},
		limit: positiveIntegerOption("--limit"),
		"country-fraction": {
			type: "string",
			validate: (value) => Number.parseFloat(value) >= 0 && Number.parseFloat(value) <= 1,
			validationMessage: "--country-fraction must be between 0 and 1.",
			description: "Fraction of rows carrying an explicit country component",
		},
		seed: { type: "string", description: "Seed for --country-fraction. Default 20260922" },
		"source-name": {
			type: "string",
			description: "The `source` id stamped on every row, when it differs from the adapter id",
		},
		"corpus-version": { type: "string", default: "0.1.0-dev", description: "Corpus version" },
		"progress-every": positiveIntegerOption("--progress-every", 1000),
	},
} as const satisfies CommandSpec

const CorpusRun: CommandComponent<typeof spec, [string]> = ({ options, args }) => {
	const [progress, setProgress] = useState<{ yielded: number; written: number; bytes: number }>({
		yielded: 0,
		written: 0,
		bytes: 0,
	})

	const state = useCommandTask(async () => {
		const { defaultAdapterRegistry, runAdapter } = await import("@mailwoman/corpus")

		const adapterID = args[0]

		const adapter = defaultAdapterRegistry.get(adapterID)

		if (!adapter) {
			const ids = defaultAdapterRegistry.ids()
			const hint = !ids.length ? "(no adapters registered yet)" : `registered: ${ids.join(", ")}`
			throw new CommandError(`unknown adapter id ${stringifyJSON(adapterID)}; ${hint}`)
		}

		const ac = new AbortController()

		return runAdapter({
			adapter,
			adapterOptions: {
				inputPath: options.input,
				outputDir: options.out,
				country: options.country,
				limit: options.limit,
				countryFraction: options.countryFraction ? Number.parseFloat(options.countryFraction) : undefined,
				seed: options.seed ? Number.parseInt(options.seed, 10) : undefined,
				signal: ac.signal,
			},
			outputDir: options.out,
			corpusVersion: options.corpusVersion,
			sourceName: options.sourceName,
			progressEvery: options.progressEvery,
			onProgress: (snap) => {
				setProgress({ yielded: snap.yielded, written: snap.written, bytes: snap.bytes })
			},
		})
	})

	if (state.status === "error") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		const manifest = state.result

		return (
			<Box flexDirection="column">
				<Text>
					<Text bold>{manifest.adapter_id}</Text>
					{": wrote "}
					<Text color="green">{manifest.written}</Text>
					{" rows ("}
					<Text dimColor>{manifest.deduped} deduped</Text>
					{") in "}
					{(manifest.elapsed_ms / 1000).toFixed(2)}s
				</Text>
				<Text dimColor>{manifest.jsonl_path}</Text>
				<Text dimColor>sha256={manifest.sha256}</Text>
			</Box>
		)
	}

	const ratio = progress.written && progress.yielded ? (progress.written / progress.yielded) * 100 : 0

	return (
		<Box flexDirection="column">
			<Text>
				yielded={progress.yielded}
				{"  "}written={progress.written}
				{"  "}bytes={progress.bytes}
			</Text>
			<Box paddingX={1}>
				<ProgressBar value={Math.min(100, ratio)} />
			</Box>
		</Box>
	)
}

export default CorpusRun
