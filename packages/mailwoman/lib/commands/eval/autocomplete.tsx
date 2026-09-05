/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval autocomplete` — the autocomplete ladder (#2154): every board row truncated at every prefix
 *   boundary and graded at each rung against the row's own truth, on the parse → resolve arm and the FST
 *   autocomplete arm. Report-only: a non-zero exit means the harness broke, never a rung missing.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Autocomplete ladder (#2154) — first-hit rung, stability, latency and abstention per prefix"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "autocomplete",
	description,
	options: {
		country: { type: "string", description: "Board rows of this ISO-3166 alpha-2 country only" },
		limit: { type: "number", description: "Row limit" },
		"weights-cache": { type: "string", description: "Candidate weights dir" },
		"candidate-db": { type: "string", description: "Byte-range candidate.db" },
		"fst-dir": {
			type: "string",
			description: "Per-locale FST directory (default $MAILWOMAN_DATA_ROOT/wof/fst-per-locale)",
		},
		"admin-db": { type: "string", description: "WOF admin database for suggestion coordinates" },
		out: { type: "string", description: "Write the full report JSON here" },
		json: { type: "boolean", default: false, description: "Print JSON" },
	},
} as const satisfies CommandSpec

interface Options {
	country?: string
	limit?: number
	weightsCache?: string
	candidateDB?: string
	fstDir?: string
	adminDB?: string
	out?: string
	json: boolean
}

const EvalAutocomplete: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { printAutocompleteLadder, runAutocompleteLadder } = await import("#eval-harness/autocomplete-ladder")

		const report = await runAutocompleteLadder({
			country: options.country,
			limit: options.limit,
			weightsCacheRoot: options.weightsCache,
			candidateDB: options.candidateDB,
			fstDir: options.fstDir,
			adminDB: options.adminDB,
			quiet: options.json,
		})

		if (options.out) {
			await writeLocalJSONFile(report, options.out)
		}

		if (!options.json) {
			printAutocompleteLadder(report)
		}

		return { report }
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (options.json) {
		return <Text>{JSON.stringify(state.result.report, null, 2)}</Text>
	}

	return null
}

export default EvalAutocomplete
