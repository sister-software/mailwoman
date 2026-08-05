/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval gauntlet` — THE Gauntlet gate: all three layers, one combined verdict (the
 *   full-pipeline integration net a model ship gates on; #566 lesson). No flags = self-check on the
 *   shipped default (regression + metamorphic); `--candidate` adds the held-out candidate-vs-prod
 *   z-test; `--layer` runs a single layer with the old standalone semantics (its own verdict + exit
 *   code). A non-zero exit blocks the ship (RELEASING.md).
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { runGauntlet } from "../../eval-harness/gauntlet/run.ts"

export const description = "The Gauntlet gate — regression + metamorphic + held-out, one verdict"

const OptionsSchema = zod.object({
	candidate: zod.string().optional().describe("Candidate ONNX (omit for the shipped-default self-check)"),
	source: zod.string().default("fr").describe("held-out: truth source (fr = BAN, us = FDIC)"),
	tokenizer: zod.string().optional().describe("Tokenizer-splice candidate: the candidate tokenizer"),
	card: zod.string().optional().describe("Tokenizer-splice candidate: the candidate model-card"),
	weightsCache: zod
		.string()
		.optional()
		.describe(
			"Package-shaped candidate weights dir (<root>/node_modules/@mailwoman/neural-weights-en-us) — #718-safe, mirrors eval parity --weights-cache; preferred for splice/multisplice candidates"
		),
	layer: zod
		.enum(["regression", "metamorphic", "holdout"])
		.optional()
		.describe("Run ONE layer instead of the combined gate"),
	n: zod.number().default(300).describe("held-out: fresh-draw sample size"),
	postcodeCountryCoherence: zod
		.boolean()
		.default(false)
		.describe("#42 tri-state resolver-lever pin: force postcode-country coherence ON (library default is ON)"),
	// NOTE: spelled `-off` rather than `--no-postcode-country-coherence` for the reason `eval oa-resolver`'s
	// `adminCoherenceOff` is — commander treats a literal `--no-x` flag as the negation of `--x` (same
	// attribute), which collapses the tri-state: the OFF pin would arrive indistinguishable from "unset".
	postcodeCountryCoherenceOff: zod
		.boolean()
		.default(false)
		.describe("#42 tri-state resolver-lever pin: force postcode-country coherence OFF (the pre-2026-08-05 default)"),
})

export { OptionsSchema as options }

const EvalGauntlet: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	// `postcodeCountryCoherenceOff` is a CLI-only spelling of the OFF half of one tri-state; it is destructured
	// out so it never reaches `runGauntlet` as a field of its own.
	const { postcodeCountryCoherenceOff, ...rest } = options

	const state = useCommandTask(
		async () =>
			(
				await runGauntlet({
					...rest,
					weightsCacheRoot: options.weightsCache,
					// An UNSET flag must stay unset, not become an explicit pin either way. Pastel gives the schema's
					// `false` default for BOTH halves, and forwarding one verbatim would pin the lever forever — which is
					// exactly how the 2026-08-05 default-on flip could have gone unnoticed by the standard gate. Neither
					// flag set keeps "no flag" meaning "grade whatever production does".
					postcodeCountryCoherence: options.postcodeCountryCoherence
						? true
						: postcodeCountryCoherenceOff
							? false
							: undefined,
				})
			).exitCode,
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The layers narrate their own verdict lines on stdout.
	return null
}

export default EvalGauntlet
