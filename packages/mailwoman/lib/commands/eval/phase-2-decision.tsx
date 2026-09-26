/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Lanes, checks, denominators, bars, artifact pins, and the one marker query all come from
 *   `decision-definition.json`, which the loader refuses to hand over if its content hash has moved.
 *
 *   A blocked lane is printed with what it will measure once unblocked and is scored nowhere.
 *
 *   Report-only by design: the exit code is non-zero only when the harness broke, so a recorded decision is a result
 *   rather than a failure.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "Pre-registered phase-2 decision ruler (#1967)"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "phase-2-decision",
	description,
	options: {
		locale: { type: "string", default: "en-US", description: "Weights package locale" },
		"weights-cache": { type: "string", description: "Candidate weights dir" },
		db: { type: "string", description: "Sealed poi.db" },
		"resolve-db": { type: "string", description: "WOF admin databases" },
		"candidate-db": { type: "string", description: "Byte-range candidate.db" },
		coverage: { type: "string", description: "Sealed coverage layer for the absence lane" },
		out: { type: "string", description: "Write the receipt JSON here" },
		json: { type: "boolean", default: false, description: "Print JSON" },
	},
} as const satisfies CommandSpec

const EvalPhase2Decision = harnessCommand(
	spec,
	async (options) => {
		const { printPhase2Receipt, runPhase2Decision } = await import("#eval-harness/phase-2-decision/run")

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
	{ exitCode: () => 0, json: ({ receipt }, options) => (options.json ? receipt : undefined) }
)

export default EvalPhase2Decision
