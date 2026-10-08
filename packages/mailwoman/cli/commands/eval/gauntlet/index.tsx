/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   No flags self-checks the shipped default. `--candidate` adds the held-out candidate-vs-prod z-test. `--layer`
 *   runs a single layer with its own verdict and exit code. A non-zero exit blocks the ship (releasing.md).
 *
 *   `--layer ablation` is a measurement rather than a check: it deletes each asserted component from each corpus row and
 *   reports what the deletion cost per (component, locale), never joining the combined verdict or blocking a ship.
 *
 *   Each ablation variant is graded against a per-row graceful-degradation ladder rather than the undeleted anchor, so
 *   coarsening to a rung the surviving components still justify passes. The ladder accepts abstention under untenable ambiguity. The check also
 *   a substitution fails at every rung. See `eval-harness/gauntlet/ablation-expectation.ts`.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "The Gauntlet check — regression + metamorphic + held-out, one verdict"

/**
 * The values of a resolver pin flag.
 */
const PIN_CHOICES = ["on", "off"] as const

type PinChoice = (typeof PIN_CHOICES)[number]

/**
 * The `runGauntlet` field one pin flag sets, or an empty object when the flag is unset.
 */
function pinFor<Key extends string>(key: Key, choice: PinChoice | undefined): Partial<Record<Key, boolean>> {
	if (choice === undefined) return {}

	return { [key]: choice === "on" } as Partial<Record<Key, boolean>>
}

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
		"postcode-country-coherence": {
			type: "string",
			choices: PIN_CHOICES,
			description: "Pin postcode-country coherence; unset grades the production default",
		},
		"gazetteer-prior": {
			type: "string",
			choices: PIN_CHOICES,
			description: "Pin the gazetteer FST prior; unset grades the production default",
		},
		"admin-containment-rerank": {
			type: "string",
			choices: PIN_CHOICES,
			description: "Pin the containment rerank; unset grades the production default",
		},
		"span-rescore-require-context-remainder": {
			type: "string",
			choices: PIN_CHOICES,
			description:
				"Pin the refusal of a span-rescore sub-span that drops a word of the name; unset grades the production default",
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
		const {
			postcodeCountryCoherence,
			gazetteerPrior,
			adminContainmentRerank,
			spanRescoreRequireContextRemainder,
			components,
			...rest
		} = options

		const { runGauntlet } = await import("#tools/eval-harness/gauntlet/run")

		return (
			await runGauntlet({
				...rest,
				weightsCacheRoot: options.weightsCache,
				// An absent flag must stay absent (→ every ablatable tag), so an empty
				// string never becomes an empty filter.
				// That would silently measure no rows and print a map of one header row.
				...(components ? { components: extractDelimited(components) } : {}),
				// An unset flag leaves its switch unpinned, so the run grades the production default.
				...pinFor("postcodeCountryCoherence", postcodeCountryCoherence),
				...pinFor("gazetteerPrior", gazetteerPrior),
				...pinFor("adminContainmentRerank", adminContainmentRerank),
				...pinFor("spanRescoreRequireContextRemainder", spanRescoreRequireContextRemainder),
				// Three readings rather than two states, so there is no off spelling:
				// an absent flag is the production default.
				// That default takes a `placeID` at face value and never lifts the brake.
				...(options.spanRescoreWeakResolution ? { spanRescoreWeakResolution: options.spanRescoreWeakResolution } : {}),
			})
		).exitCode
	},
	{ exitCode: (exitCode) => exitCode }
)

export default EvalGauntlet
