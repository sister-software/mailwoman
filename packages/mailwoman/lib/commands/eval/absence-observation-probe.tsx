/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rows, expected outcomes, and the coverage layer all come from `probe-definition.json`, which the loader refuses to
 *   hand over if its content hash has moved.
 *
 *   No route is injected into the runtime pipeline for the absence work; the semantic phrase route is injected because
 *   the activity-phrased rows cannot reach a category without it.
 *
 *   The coverage layer is build-local (ODbL) and uncommitted, so a run without it refuses at construction rather than
 *   reporting an empty board; its build command is in
 *   `docs/superpowers/specs/2026-08-27-exclusion-grade-coverage-pilot.md`.
 *
 *   Report-only by design: the exit code is non-zero only when the harness broke, so a recorded breach is a result
 *   rather than a crash.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "Pre-registered coverage-qualified absence-observation probe (#1965)"

/**
 * Native command-line interface consumed by the filesystem command router.
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

const EvalAbsenceObservationProbe = harnessCommand(
	spec,
	async (options) => {
		const { printAbsenceProbeReceipt, runAbsenceObservationProbe } =
			await import("#eval-harness/absence-observation/run")

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
	{ exitCode: () => 0, json: ({ receipt }, options) => (options.json ? receipt : undefined) }
)

export default EvalAbsenceObservationProbe
