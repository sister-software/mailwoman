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
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { runParityEval } from "../../eval-harness/parity-corpus.ts"

export const description = "Parity-corpus eval — rescued v1 gold vs a checkpoint (plan-2 swap floors)"

const OptionsSchema = zod.object({
	locale: zod.string().optional().default("en-US").describe("Weights package locale (default en-US)"),
	model: zod.string().optional().describe("Candidate model.onnx (omit for the shipped default)"),
	tokenizer: zod.string().optional().describe("Candidate tokenizer.model"),
	card: zod.string().optional().describe("Candidate model-card.json (label vocab for --model)"),
	fixtures: zod
		.string()
		.optional()
		.describe(
			"Fixture JSONL override (default: the ratified triaged corpus; pass parity-corpus.jsonl for the pre-triage v1 denominator)"
		),
	weightsCache: zod
		.string()
		.optional()
		.describe(
			"Grade a candidate laid out package-shaped under <dir>/node_modules/@mailwoman/neural-weights-<locale> " +
				"(feeds anchor/gazetteer/calibration siblings — PREFER over --model for candidates; the explicit-path " +
				"branch grades a channel-starved model)"
		),
	streetMorphology: zod
		.boolean()
		.optional()
		.default(false)
		.describe("Probe 0: decode-time street-morphology emission bias (libpostal street_types, all locales)"),
	failing: zod.coerce
		.number()
		.int()
		.min(0)
		.max(50)
		.optional()
		.default(0)
		.describe("List the first N disagreeing inputs per floor label"),
})

export { OptionsSchema as options }

const EvalParity: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		async () =>
			(
				await runParityEval({
					locale: options.locale,
					modelPath: options.model,
					tokenizerPath: options.tokenizer,
					modelCardPath: options.card,
					fixturesPath: options.fixtures,
					weightsCacheRoot: options.weightsCache,
					streetMorphology: options.streetMorphology,
					failing: options.failing,
				})
			).exitCode,
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The runner narrates its tables + verdict on stdout.
	return null
}

export default EvalParity
