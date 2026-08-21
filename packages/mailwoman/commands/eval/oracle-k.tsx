/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval oracle-k` — oracle-recall@k over segment-level k-best decodes (#727 stage-2
 *   instrumentation). Measures the k-best rerank headroom the top-1 gates can't see: how often the
 *   gold value appears ANYWHERE in the top-k whole-segmentation hypotheses decoded from the current
 *   model's emissions. Informational (always exits 0) — the standing floors stay on `eval parity`.
 */

import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Largest useful hypothesis set for the bounded oracle probe.
 */
const MAX_ORACLE_HYPOTHESES = 50

export const description = "Oracle-recall@k — k-best segment-decode headroom over the parity corpus (#727 stage-2)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "oracle-k",
	description,
	options: {
		locale: { type: "string", default: "en-US", description: "Weights package locale (default en-US)" },
		"weights-cache": {
			type: "string",
			description: "Package-shaped candidate weights dir (mirrors eval parity --weights-cache)",
		},
		fixtures: { type: "string", description: "Fixture JSONL override (default: the ratified triaged parity corpus)" },
		"golden-dir": {
			type: "string",
			description: "Golden dev dir for the transition-bigram estimate (default data/eval/golden/v0.1.2/dev)",
		},
		k: {
			type: "number",
			default: 10,
			validate: (value) => Number.isInteger(value) && value >= 1 && value <= MAX_ORACLE_HYPOTHESES,
			validationMessage: "--k must be an integer between 1 and 50.",
			description: "Hypotheses kept per input",
		},
		"assert-baseline": {
			type: "string",
			description: "Registered baseline profile (v264, v301) — refuse to report if the instruments read wrong",
		},
	},
} as const satisfies CommandSpec

interface Options {
	locale: string
	weightsCache?: string
	fixtures?: string
	goldenDir?: string
	k: number
	assertBaseline?: string
}

const EvalOracleK: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { runOracleK } = await import("../../eval-harness/oracle-k.ts")

			return (
				await runOracleK({
					locale: options.locale,
					weightsCacheRoot: options.weightsCache,
					fixturesPath: options.fixtures,
					goldenDir: options.goldenDir,
					k: options.k,
					assertBaseline: options.assertBaseline,
				})
			).exitCode
		},
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The runner narrates its table on stdout.
	return null
}

export default EvalOracleK
