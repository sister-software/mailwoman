// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman corpus recorded-runs --inputs <inputs.json> --out <dir> --corpus-version <version>`
 *
 *   Runs every adapter run a build record lists under `sourceRuns`.
 *   Each runs as `corpus run <adapter> --source-name` would, into `<out>/<source>-<country>/<adapter>/`.
 *
 *   The runs' rows join a corpus as an overlay, so `corpus build` never reads them.
 */

import { CommandError } from "@mailwoman/core/scripting/command"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { Box, Text } from "ink"

import {
	type CommandComponent,
	type CommandSpec,
	CommandTaskResult,
	isCorpusVersion,
	useCommandTask,
	useStageProgress,
} from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "recorded-runs",
	description: "Run the adapter runs a build record lists under sourceRuns.",
	options: {
		inputs: { type: "string", required: true, description: "The build record (inputs.json)" },
		out: { type: "string", required: true, description: "Output root" },
		"corpus-version": {
			type: "string",
			required: true,
			description: "Corpus version",
			validate: isCorpusVersion,
			validationMessage: "--corpus-version is the version alone, without the `corpus-v` prefix.",
		},
	},
} as const satisfies CommandSpec

const RecordedRuns: CommandComponent<typeof spec> = ({ options }) => {
	const progress = useStageProgress()

	const state = useCommandTask(async () => {
		const [{ defaultAdapterRegistry, runAdapter }, { readSourceRuns, sourceRunDirectoryName }, { resolvePathBuilder }] =
			await Promise.all([import("@mailwoman/corpus"), import("@mailwoman/corpus/build/inputs"), import("path-ts")])

		const runs = await readSourceRuns(options.inputs).catch((error: Error) => {
			throw new CommandError(error.message)
		})

		const written: Array<{ run: string; rows: number; path: string }> = []

		for (const run of runs) {
			const adapter = defaultAdapterRegistry.get(run.adapter)

			if (!adapter) throw new CommandError(`${options.inputs} lists unknown adapter ${stringifyJSON(run.adapter)}`)

			const name = sourceRunDirectoryName({ sourceName: run.sourceName, country: run.options.country })
			const outputDir = resolvePathBuilder(options.out, name)

			const manifest = await runAdapter({
				adapter,
				adapterOptions: { ...run.options, outputDir: outputDir.toString() },
				outputDir,
				corpusVersion: options.corpusVersion,
				sourceName: run.sourceName,
				onProgress: (snapshot) => progress.report(name, `${snapshot.written} rows`),
			})

			written.push({ run: name, rows: manifest.written, path: manifest.jsonl_path })
		}

		return written
	})

	if (state.status !== "done") return <CommandTaskResult state={state} progress={progress} />

	return (
		<Box flexDirection="column">
			{state.result.map((run) => (
				<Text key={run.run}>{`${run.run}: ${run.rows} rows, ${run.path}`}</Text>
			))}
		</Box>
	)
}

export default RecordedRuns
