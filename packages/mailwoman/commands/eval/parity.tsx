/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval parity` — the rescued v1 parity corpus (#1093) scored against a checkpoint,
 *   parse-only. Carries the plan-2 pre-registered floors (house_number/postcode ≥ 0.97, street
 *   family ≥ 0.90); a non-zero exit means the checkpoint does not yet clear the bar the HELD
 *   plan-2 production swaps re-run against. Per-country full-agreement table gauges the accent-
 *   mangle + fragment campaign's progress.
 */

import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Largest disagreement sample that keeps parity output reviewable.
 */
const MAX_REPORTED_DISAGREEMENTS = 50

export const description = "Parity-corpus eval — rescued v1 gold vs a checkpoint (plan-2 swap floors)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "parity",
	description,
	options: {
		locale: { type: "string", default: "en-US", description: "Weights package locale" },
		model: { type: "string", description: "Candidate model.onnx" },
		tokenizer: { type: "string", description: "Candidate tokenizer.model" },
		card: { type: "string", description: "Candidate model-card.json" },
		fixtures: { type: "string", description: "Fixture JSONL override" },
		"weights-cache": { type: "string", description: "Package-shaped candidate weights directory" },
		"street-morphology": { type: "boolean", default: false, description: "Enable street-morphology emission bias" },
		"gazetteer-prior": {
			type: "boolean",
			default: false,
			description: "Feed the gazetteer FST emission prior (#1497)",
		},
		"word-consistency": { type: "boolean", default: true, description: "Enable word-consistency healing" },
		failing: {
			type: "number",
			default: 0,
			validate: (value) => Number.isInteger(value) && value >= 0 && value <= MAX_REPORTED_DISAGREEMENTS,
			validationMessage: "--failing must be an integer between 0 and 50.",
			description: "List the first N disagreements per floor label",
		},
	},
} as const satisfies CommandSpec

interface Options {
	locale: string
	model?: string
	tokenizer?: string
	card?: string
	fixtures?: string
	weightsCache?: string
	streetMorphology: boolean
	gazetteerPriorOff: boolean
	wordConsistency: boolean
	failing: number
}

const EvalParity: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { runParityEval } = await import("../../eval-harness/parity-corpus.ts")

			return (
				await runParityEval({
					locale: options.locale,
					modelPath: options.model,
					tokenizerPath: options.tokenizer,
					modelCardPath: options.card,
					fixturesPath: options.fixtures,
					weightsCacheRoot: options.weightsCache,
					streetMorphology: options.streetMorphology,
					gazetteerPrior: options.gazetteerPriorOff ? false : undefined,
					wordConsistency: options.wordConsistency,
					failing: options.failing,
				})
			).exitCode
		},
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The runner narrates its tables + verdict on stdout.
	return null
}

export default EvalParity
