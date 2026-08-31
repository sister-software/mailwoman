/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval semantic-utility-probe` — the pre-registered geographic-model semantic-utility probe
 *   (#1928). Runs the frozen target and control rows through the same pipeline construction the POI
 *   query board uses, grades them with the board's own `gradeCase`, and prints the measured counts
 *   beside the frozen bars.
 *
 *   The command chooses nothing. Rows, comparator, metric arithmetic, baseline and thresholds all come
 *   from `probe-definition.json`, which the loader refuses to hand over if its content hash has moved.
 *   `--arm` labels which run a receipt describes; `--out` writes the receipt for the decision record.
 *
 *   `--semantic-observation` is what makes the second arm a second arm: it builds the one route (#1929)
 *   and injects it into the pipeline this run constructs. Without it the run is the un-injected pipeline,
 *   whatever `--arm` is called — and the receipt records which of the two actually happened, because a
 *   route dropped on the way in and a route that changed nothing produce the same numbers.
 *
 *   Report-only by design: the exit code is non-zero only when the HARNESS broke — a moved ruler, an
 *   unresolved control row, a missing database. A recorded STOP-REDESIGN is a result, not a failure.
 */

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
			const { printProbeReceipt, runSemanticUtilityProbe } = await import("#eval-harness/semantic-utility/run")

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
