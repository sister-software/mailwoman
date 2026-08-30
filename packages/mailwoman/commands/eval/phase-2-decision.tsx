import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Pre-registered phase-2 decision ruler (#1967)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "phase-2-decision",
	description,
	options: {
		locale: { type: "string", default: "en-US", description: "Weights package locale" },
		"weights-cache": { type: "string", description: "Candidate weights dir" },
		db: { type: "string", description: "Sealed poi.db" },
		"resolve-db": { type: "string", description: "WOF admin shards" },
		"candidate-db": { type: "string", description: "Byte-range candidate.db" },
		coverage: { type: "string", description: "Sealed coverage layer for the absence lane" },
		out: { type: "string", description: "Write the receipt JSON here" },
		json: { type: "boolean", default: false, description: "Print JSON" },
	},
} as const satisfies CommandSpec

interface Options {
	locale: string
	weightsCache?: string
	db?: string
	resolveDB?: string
	candidateDB?: string
	coverage?: string
	out?: string
	json: boolean
}

const EvalPhase2Decision: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { printPhase2Receipt, runPhase2Decision } = await import("../../eval-harness/phase-2-decision/run.ts")

			const receipt = await runPhase2Decision({
				locale: options.locale,
				weightsCacheRoot: options.weightsCache,
				db: options.db,
				resolveDB: options.resolveDB,
				candidateDB: options.candidateDB,
				coverageDatabasePath: options.coverage,
			})

			if (options.out) {
				await writeLocalJSONFile(receipt, options.out)
			}

			if (!options.json) {
				printPhase2Receipt(receipt)
			}

			return { receipt }
		},
		() => 0
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (options.json && state.status === "done") {
		return <Text>{JSON.stringify(state.result.receipt, null, 2)}</Text>
	}

	return null
}

export default EvalPhase2Decision
