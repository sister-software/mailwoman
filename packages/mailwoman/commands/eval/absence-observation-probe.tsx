/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval absence-observation-probe` — the pre-registered negative-evidence probe (#1965). Runs
 *   the frozen rows through the same pipeline construction the POI query board uses, asks the absence
 *   route what it makes of each answer, and prints each row's registered outcome beside the observed one.
 *
 *   The command chooses nothing. Rows, expected outcomes and the coverage layer all come from
 *   `probe-definition.json`, which the loader refuses to hand over if its content hash has moved.
 *
 *   Nothing is injected into the runtime pipeline for the absence work: the pipeline answers, and the
 *   route reads the finished answer. The semantic phrase route (#1929) IS injected, because the
 *   activity-phrased rows cannot reach a category without it.
 *
 *   The coverage layer is BUILD-LOCAL (ODbL), so it is not committed and not published. Without it the run
 *   refuses at construction rather than reporting an empty board — see
 *   `docs/superpowers/specs/2026-08-27-exclusion-grade-coverage-pilot.md` for the build command.
 *
 *   Report-only by design: the exit code is non-zero only when the HARNESS broke — a moved ruler, a
 *   missing coverage layer, a missing database. A recorded BREACHED is a result, not a crash, and it is
 *   the result the asymmetry claim is graded on.
 */

import { writeFileSync } from "@mailwoman/platform/fs"
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
				writeFileSync(options.out, `${JSON.stringify(receipt, null, "\t")}\n`)
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
