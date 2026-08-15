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
 *
 *   `--layer ablation` is the exception: it is a MEASUREMENT, not a gate. It deletes each asserted
 *   component from each corpus row and reports what the deletion cost per (component, locale) — the
 *   load-bearing map. It never joins the combined verdict and cannot block a ship.
 *
 *   Since 2026-08-05 that measurement is NORMATIVE: each variant is graded against a per-row
 *   graceful-degradation ladder rather than against the undeleted anchor, so coarsening to a rung the
 *   surviving components still justify PASSES, abstaining under untenable ambiguity PASSES, and a
 *   substitution fails at every rung. See `eval-harness/gauntlet/ablation-expectation.ts`.
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

export const description = "The Gauntlet gate — regression + metamorphic + held-out, one verdict"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "gauntlet",
	description,
	options: {
		candidate: { type: "string", description: "Candidate ONNX" },
		source: { type: "string", default: "fr", description: "Held-out truth source" },
		tokenizer: { type: "string", description: "Candidate tokenizer" },
		card: { type: "string", description: "Candidate model card" },
		"weights-cache": { type: "string", description: "Candidate weights dir" },
		layer: {
			type: "string",
			choices: ["regression", "metamorphic", "holdout", "ablation"],
			description: "Single layer",
		},
		n: { type: "number", default: 300, description: "Held-out sample size" },
		out: { type: "string", description: "Ablation artifact dir" },
		components: { type: "string", description: "Components to delete" },
		limit: { type: "number", description: "Case limit" },
		"postcode-country-coherence": { type: "boolean", default: false, description: "Force coherence on" },
		"postcode-country-coherence-off": { type: "boolean", default: false, description: "Force coherence off" },
		"gazetteer-prior": { type: "boolean", default: false, description: "Feed the gazetteer FST prior (#1497)" },
	},
} as const satisfies CommandSpec

interface Options {
	candidate?: string
	source: string
	tokenizer?: string
	card?: string
	weightsCache?: string
	layer?: "regression" | "metamorphic" | "holdout" | "ablation"
	n: number
	out?: string
	components?: string
	limit?: number
	postcodeCountryCoherence: boolean
	postcodeCountryCoherenceOff: boolean
	gazetteerPrior: boolean
}

const EvalGauntlet: ParsedCommandComponent<Options> = ({ options }) => {
	// `postcodeCountryCoherenceOff` is a CLI-only spelling of the OFF half of one tri-state; it is destructured
	// out so it never reaches `runGauntlet` as a field of its own.
	const { postcodeCountryCoherenceOff, components, ...rest } = options

	const state = useCommandTask(
		async () => {
			const { runGauntlet } = await import("../../eval-harness/gauntlet/run.ts")

			return (
				await runGauntlet({
					...rest,
					weightsCacheRoot: options.weightsCache,
					// ablation only. An absent flag must stay absent (→ every ablatable tag), so an empty string
					// never becomes an empty filter — which would silently measure nothing and print a map of one
					// header row.
					...(components
						? {
								components: components
									.split(",")
									.map((c) => c.trim())
									.filter(Boolean),
							}
						: {}),
					// An UNSET flag must stay unset, not become an explicit pin either way. The schema supplies its
					// `false` default for BOTH halves, and forwarding one verbatim would pin the lever forever — which is
					// exactly how the 2026-08-05 default-on flip could have gone unnoticed by the standard gate. Neither
					// flag set keeps "no flag" meaning "grade whatever production does".
					postcodeCountryCoherence: options.postcodeCountryCoherence
						? true
						: postcodeCountryCoherenceOff
							? false
							: undefined,
					// #1497: one-sided on purpose. The prior is OFF on this path today — `classifier.parse` reads `fst`
					// from opts only and the geocode path passed none — so there is no production default to preserve
					// and no OFF half to spell.
					...(options.gazetteerPrior ? { gazetteerPrior: true } : {}),
				})
			).exitCode
		},
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The layers narrate their own verdict lines on stdout.
	return null
}

export default EvalGauntlet
