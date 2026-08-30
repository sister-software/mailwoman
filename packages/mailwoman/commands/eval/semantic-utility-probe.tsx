import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Pre-registered geographic-model semantic-utility probe (#1928)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "semantic-utility-probe",
	description,
	options: {
		locale: { type: "string", default: "en-US", description: "Weights package locale" },
		"weights-cache": { type: "string", description: "Candidate weights dir" },
		db: { type: "string", description: "Sealed poi.db" },
		"resolve-db": { type: "string", description: "WOF admin shards" },
		"candidate-db": { type: "string", description: "Byte-range candidate.db" },
		arm: { type: "string", default: "baseline", description: "Arm label written into the receipt" },
		"semantic-observation": {
			type: "boolean",
			default: false,
			description: "Inject the one semantic observation route (#1929)",
		},
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
	arm: string
	semanticObservation: boolean
	out?: string
	json: boolean
}

const EvalSemanticUtilityProbe: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { printProbeReceipt, runSemanticUtilityProbe } = await import("../../eval-harness/semantic-utility/run.ts")

			const receipt = await runSemanticUtilityProbe({
				locale: options.locale,
				weightsCacheRoot: options.weightsCache,
				db: options.db,
				resolveDB: options.resolveDB,
				candidateDB: options.candidateDB,
				arm: options.arm,
				semanticObservation: options.semanticObservation,
			})

			if (options.out) {
				await writeLocalJSONFile(receipt, options.out)
			}

			if (!options.json) {
				printProbeReceipt(receipt)
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

export default EvalSemanticUtilityProbe
