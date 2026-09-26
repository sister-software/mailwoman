/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   No flags self-checks the shipped default, `--candidate` adds the held-out candidate-vs-prod z-test, and `--layer`
 *   runs a single layer with its own verdict and exit code; a non-zero exit blocks the ship (releasing.md).
 *
 *   `--layer ablation` is a measurement rather than a check: it deletes each asserted component from each corpus row and
 *   reports what the deletion cost per (component, locale), never joining the combined verdict or blocking a ship.
 *
 *   Each ablation variant is graded against a per-row graceful-degradation ladder rather than the undeleted anchor, so
 *   coarsening to a rung the surviving components still justify passes, abstaining under untenable ambiguity passes, and
 *   a substitution fails at every rung; see `eval-harness/gauntlet/ablation-expectation.ts`.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "The Gauntlet check — regression + metamorphic + held-out, one verdict"

/**
 * Native command-line interface consumed by the filesystem command router.
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
		"span-rescore-require-context-remainder": {
			type: "boolean",
			default: false,
			description: "A span-rescore sub-span may drop context, never a word of the name",
		},
		"span-rescore-require-context-remainder-off": {
			type: "boolean",
			default: false,
			description: "Force that refusal off",
		},
		"span-rescore-weak-resolution": {
			type: "string",
			choices: ["score", "containment", "either"],
			description: "Which reading of a weak resolution lifts the #685 brake",
		},
	},
} as const satisfies CommandSpec

// The layers narrate their own verdict lines on stdout, so there is no `json` output.
const EvalGauntlet = harnessCommand(
	spec,
	async (options) => {
		// The `*Off` names are CLI-only spellings of the off half of a tri-state,
		// destructured out so none reaches `runGauntlet` as its own field.
		const {
			postcodeCountryCoherenceOff,
			gazetteerPriorOff,
			adminContainmentRerankOff,
			spanRescoreRequireContextRemainderOff,
			components,
			...rest
		} = options

		const { runGauntlet } = await import("#eval-harness/gauntlet/run")

		return (
			await runGauntlet({
				...rest,
				weightsCacheRoot: options.weightsCache,
				// An absent flag must stay absent (→ every ablatable tag), so an empty string never becomes an
				// empty filter, which would silently measure no rows and print a map of one header row.
				...(components ? { components: extractDelimited(components) } : {}),
				// The schema supplies `false` for both halves of each tri-state pin,
				// so an unset flag must stay `undefined` rather than pinning the change either way:
				// "no flag" keeps meaning "grade whatever production does".
				postcodeCountryCoherence: options.postcodeCountryCoherence
					? true
					: postcodeCountryCoherenceOff
						? false
						: undefined,
				gazetteerPrior: options.gazetteerPrior ? true : gazetteerPriorOff ? false : undefined,
				adminContainmentRerank: options.adminContainmentRerank ? true : adminContainmentRerankOff ? false : undefined,
				spanRescoreRequireContextRemainder: options.spanRescoreRequireContextRemainder
					? true
					: spanRescoreRequireContextRemainderOff
						? false
						: undefined,
				// Three readings rather than two states, so there is no off spelling: an absent flag is
				// the production default, which takes a `placeID` at face value and never lifts the brake.
				...(options.spanRescoreWeakResolution ? { spanRescoreWeakResolution: options.spanRescoreWeakResolution } : {}),
			})
		).exitCode
	},
	{ exitCode: (exitCode) => exitCode }
)

export default EvalGauntlet
