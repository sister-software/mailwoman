/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus run <adapter-id> --input <path> --output <dir> [--country XX] [--limit N]`
 *
 *   CLI shim around `runAdapter` from `@mailwoman/corpus`. Resolves `<adapter-id>` against the
 *   default registry; refuses with a clear, non-zero exit if the id isn't known (and lists the
 *   registered ids). On success, prints a one-line summary and the path to the manifest file.
 */

import { ProgressBar } from "@inkjs/ui"
import { Box, Text } from "ink"
import { useState } from "react"

import { type CommandSpec, type ParsedCommandComponent, CommandError, useCommandTask } from "#cli-kit"

const positiveInteger = (description: string, defaultValue?: number) =>
	({
		type: "number",
		...(defaultValue === undefined ? {} : { default: defaultValue }),
		validate: (value: number) => Number.isInteger(value) && value > 0,
		validationMessage: `${description} must be a positive integer.`,
		description,
	}) as const

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "run",
	description: "Run one corpus adapter.",
	positionals: [{ name: "adapter-id", required: true, description: "Adapter id" }],
	options: {
		input: { type: "string", required: true, description: "Adapter input" },
		output: { type: "string", required: true, description: "Output root" },
		country: {
			type: "string",
			validate: (value) => /^[A-Z]{2}$/u.test(value),
			validationMessage: "--country must be an ISO alpha-2 code.",
			description: "Country filter",
		},
		limit: positiveInteger("--limit"),
		"corpus-version": { type: "string", default: "0.1.0-dev", description: "Corpus version" },
		"progress-every": positiveInteger("--progress-every", 1000),
	},
} as const satisfies CommandSpec

interface Options {
	input: string
	output: string
	country?: string
	limit?: number
	corpusVersion: string
	progressEvery: number
}

const CorpusRun: ParsedCommandComponent<Options, [string]> = ({ options, args }) => {
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
			throw new CommandError(`unknown adapter id ${JSON.stringify(adapterID)}; ${hint}`)
		}

		const ac = new AbortController()

		return runAdapter({
			adapter,
			adapterOptions: {
				inputPath: options.input,
				outputDir: options.output,
				country: options.country,
				limit: options.limit,
				signal: ac.signal,
			},
			outputDir: options.output,
			corpusVersion: options.corpusVersion,
			progressEvery: options.progressEvery,
			onProgress: (snap) => {
				setProgress({ yielded: snap.yielded, written: snap.written, bytes: snap.bytes })
			},
		})
	})

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

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
