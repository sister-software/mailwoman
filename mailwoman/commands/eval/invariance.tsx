/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval invariance` — the INVARIANCE MINI-SUITE: a standing, seconds-cheap
 *   metamorphic-invariance check (comma-drop / abbreviation-swap / case-fold / lowercase /
 *   whitespace-jitter / trailing-punct / idempotence) over `eval-harness/invariance/suite.jsonl`, meant
 *   to run in EVERY probe grade so distribution-shift collateral surfaces at 2k-probe cost instead of
 *   ship-prep cost. Compares decoded PARSE COMPONENTS only (no resolver) — cheap by construction. Exit
 *   nonzero on any LOST pair, or when the DEGRADED count exceeds `--max-degraded`. `--baseline` switches
 *   to regression mode: a violation the baseline ALSO exhibits on the same pair is reported but doesn't
 *   fail the gate — the shape probe grading uses to diff a candidate against v385.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { runInvarianceCommand } from "../../eval-harness/invariance/command.ts"

export const description =
	"Metamorphic invariance mini-suite (comma-drop/abbrev/case/idempotence) — standing probe guard"

const OptionsSchema = zod.object({
	suite: zod.string().optional().describe("Alternate suite.jsonl path (default: the shipped fixture)"),
	model: zod.string().optional().describe("Candidate ONNX (requires --tokenizer + --model-card)"),
	tokenizer: zod.string().optional().describe("Candidate tokenizer path"),
	modelCard: zod.string().optional().describe("Candidate model-card path"),
	weightsCache: zod
		.string()
		.optional()
		.describe(
			"Package-shaped candidate weights dir (<root>/node_modules/@mailwoman/neural-weights-<locale>) — #718-safe, alternative to --model"
		),
	locale: zod.string().optional().describe("Locale tag for weights-package resolution (default en-US)"),
	maxDegraded: zod.number().optional().describe("Fail if the NEW-violation DEGRADED count exceeds this (default 0)"),
	baseline: zod
		.string()
		.optional()
		.describe("Baseline ONNX for regression mode (requires --baseline-tokenizer + --baseline-model-card)"),
	baselineTokenizer: zod.string().optional().describe("Baseline tokenizer path"),
	baselineModelCard: zod.string().optional().describe("Baseline model-card path"),
	baselineWeightsCache: zod
		.string()
		.optional()
		.describe("Package-shaped baseline weights dir — alternative to --baseline + the two flags above"),
})

export { OptionsSchema as options }

const EvalInvariance: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		() => runInvarianceCommand(options),
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The runner narrates its own report + verdict lines — rendering anything here would duplicate it.
	return null
}

export default EvalInvariance
