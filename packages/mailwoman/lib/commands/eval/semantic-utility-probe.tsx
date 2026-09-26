/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rows, comparator, metric arithmetic, baseline, and thresholds all come from `probe-definition.json`, which the loader
 *   refuses to hand over if its content hash has moved.
 *
 *   `--semantic-observation` builds the one semantic observation route and injects it into the pipeline this run
 *   constructs; without it the run is the un-injected pipeline whatever `--arm` is called, and the receipt records which
 *   of the two happened because a dropped route and a route that changed no answer produce the same numbers.
 *
 *   Report-only by design: the exit code is non-zero only when the harness broke, so a recorded stop-redesign is a result
 *   rather than a failure.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "Pre-registered geographic-model semantic-utility probe (#1928)"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "semantic-utility-probe",
	description,
	options: {
		locale: { type: "string", default: "en-US", description: "Weights package locale" },
		"weights-cache": { type: "string", description: "Candidate weights dir" },
		db: { type: "string", description: "Sealed poi.db" },
		"resolve-db": { type: "string", description: "WOF admin databases" },
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

const EvalSemanticUtilityProbe = harnessCommand(
	spec,
	async (options) => {
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
	{ exitCode: () => 0, json: ({ receipt }, options) => (options.json ? receipt : undefined) }
)

export default EvalSemanticUtilityProbe
