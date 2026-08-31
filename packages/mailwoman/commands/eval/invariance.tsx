/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval invariance` — the INVARIANCE MINI-SUITE: a standing, seconds-cheap
 *   metamorphic-invariance check (comma-drop / abbreviation-swap / case-fold / lowercase /
 *   whitespace-jitter / trailing-punct / idempotence) over `eval-harness/invariance/suite.jsonl`, meant
 *   to run in EVERY probe grade so distribution-shift collateral surfaces at 2k-probe cost instead of
 *   ship-prep cost. Compares decoded PARSE COMPONENTS only (no resolver) — cheap by construction. Parses
 *   run through the PRODUCTION runtime pipeline (`createRuntimePipeline`), per-row locale from each
 *   fixture row's country, weights-package FST auto-loaded (#1516). Exit nonzero on any LOST pair, or
 *   when the DEGRADED count exceeds `--max-degraded`. `--baseline` switches to regression mode: a
 *   violation the baseline ALSO exhibits on the same pair is reported but doesn't fail the gate — the
 *   shape probe grading uses to diff a candidate against v385. Two more regression-mode classes never
 *   fail the gate: GAINED pairs (the candidate holds what the baseline violated) and gained-capability
 *   residuals (a row whose critical components the baseline never parsed at all).
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description =
	"Metamorphic invariance mini-suite (comma-drop/abbrev/case/idempotence) — standing probe guard"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "invariance",
	description,
	options: {
		suite: { type: "string", description: "Alternate suite.jsonl path (default: the shipped fixture)" },
		model: { type: "string", description: "Candidate ONNX (requires --tokenizer + --model-card)" },
		tokenizer: { type: "string", description: "Candidate tokenizer path" },
		"model-card": { type: "string", description: "Candidate model-card path" },
		"weights-cache": { type: "string", description: "Package-shaped candidate weights directory" },
		locale: { type: "string", description: "Locale tag for weights-package resolution (default en-US)" },
		"max-degraded": {
			type: "number",
			description: "Fail if the new-violation degraded count exceeds this (default 0)",
		},
		baseline: { type: "string", description: "Baseline ONNX for regression mode" },
		"baseline-tokenizer": { type: "string", description: "Baseline tokenizer path" },
		"baseline-model-card": { type: "string", description: "Baseline model-card path" },
		"baseline-weights-cache": { type: "string", description: "Package-shaped baseline weights directory" },
	},
} as const satisfies CommandSpec

interface Options {
	suite?: string
	model?: string
	tokenizer?: string
	modelCard?: string
	weightsCache?: string
	locale?: string
	maxDegraded?: number
	baseline?: string
	baselineTokenizer?: string
	baselineModelCard?: string
	baselineWeightsCache?: string
}

const EvalInvariance: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { runInvarianceCommand } = await import("#eval-harness/invariance/command")

			return await runInvarianceCommand(options)
		},
		(exitCode) => exitCode
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	// The runner narrates its own report + verdict lines — rendering anything here would duplicate it.
	return null
}

export default EvalInvariance
