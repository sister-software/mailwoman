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

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

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
		"gazetteer-prior": { type: "boolean", default: false, description: "Force the gazetteer FST prior on" },
		"gazetteer-prior-off": { type: "boolean", default: false, description: "Force the gazetteer FST prior off" },
		"admin-containment-rerank": { type: "boolean", default: false, description: "Force the containment rerank on" },
		"admin-containment-rerank-off": {
			type: "boolean",
			default: false,
			description: "Force the containment rerank off",
		},
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
	gazetteerPriorOff: boolean
	adminContainmentRerank: boolean
	adminContainmentRerankOff: boolean
}

const EvalGauntlet: ParsedCommandComponent<Options> = ({ options }) => {
	// The `*Off` names are CLI-only spellings of the OFF half of a tri-state; they are destructured out so neither
	// ever reaches `runGauntlet` as a field of its own.
	const { postcodeCountryCoherenceOff, gazetteerPriorOff, adminContainmentRerankOff, components, ...rest } = options

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
									.filter((component) => component.length > 0),
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
					// #1497: two-sided since the 2026-08-16 default-on promotion. There IS a production default to
					// preserve now, so an unset flag must stay unset rather than pinning the lever either way.
					gazetteerPrior: options.gazetteerPrior ? true : gazetteerPriorOff ? false : undefined,
					// #1717 stage 2: two-sided from day one (the #1706 one-sided-forwarding class) — the OFF pin
					// grades the production default explicitly, and no flag stays "grade whatever production does".
					adminContainmentRerank: options.adminContainmentRerank ? true : adminContainmentRerankOff ? false : undefined,
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
