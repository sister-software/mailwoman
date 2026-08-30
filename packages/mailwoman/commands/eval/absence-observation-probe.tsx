import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Pre-registered coverage-qualified absence-observation probe (#1965)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "absence-observation-probe",
	description,
	options: {
		locale: { type: "string", default: "en-US", description: "Weights package locale" },
		"weights-cache": { type: "string", description: "Candidate weights dir" },
		coverage: { type: "string", description: "Sealed coverage layer; default is the definition's own file" },
		db: { type: "string", description: "Sealed poi.db; default is the coverage layer itself" },
		"resolve-db": { type: "string", description: "WOF database for anchor resolution" },
		"candidate-db": { type: "string", description: "Byte-range candidate.db" },
		out: { type: "string", description: "Write the receipt JSON here" },
		json: { type: "boolean", default: false, description: "Print JSON" },
	},
} as const satisfies CommandSpec

interface Options {
	locale: string
	weightsCache?: string
	coverage?: string
	db?: string
	resolveDB?: string
	candidateDB?: string
	out?: string
	json: boolean
}

const EvalAbsenceObservationProbe: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { printAbsenceProbeReceipt, runAbsenceObservationProbe } =
				await import("../../eval-harness/absence-observation/run.ts")

			const receipt = await runAbsenceObservationProbe({
				locale: options.locale,
				weightsCacheRoot: options.weightsCache,
				coverageDatabasePath: options.coverage,
				db: options.db,
				resolveDB: options.resolveDB,
				candidateDB: options.candidateDB,
			})

			if (options.out) {
				await writeLocalJSONFile(receipt, options.out)
			}

			if (!options.json) {
				printAbsenceProbeReceipt(receipt)
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

export default EvalAbsenceObservationProbe
