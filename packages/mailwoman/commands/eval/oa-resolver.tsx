/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval oa-resolver` — the OpenAddresses real-point resolver eval (the non-circular
 *   accuracy track + the neural-vs-Pelias head-to-head). Markdown report on stdout; self-emits via
 *   `--out-md` (eval figures are never hand-typed into docs). See the eval-harness module docstring
 *   for the two-tier metric and every arm's rationale.
 */

import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "OpenAddresses real-point resolver eval — non-circular, neural vs v0 (Pelias)"

const booleanOption = (optionDescription: string) =>
	({ type: "boolean", default: false, description: optionDescription }) as const

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "oa-resolver",
	description,
	options: {
		eval: { type: "string", description: "Eval JSONL" },
		limit: { type: "number", description: "Row cap" },
		model: { type: "string", description: "Candidate ONNX" },
		tokenizer: { type: "string", description: "Candidate tokenizer" },
		"model-card": { type: "string", description: "Candidate model card" },
		"model-anchor-lookup": { type: "string", description: "Anchor lookup" },
		wof: { type: "string", description: "WOF shards" },
		"default-country": { type: "string", description: "Default country" },
		"ablate-to-anchor": booleanOption("Disable gazetteer and conventions"),
		"anchor-off": booleanOption("Disable anchor input"),
		"normalize-case": booleanOption("Force normalizeCase on"),
		"raw-case": booleanOption("Force normalizeCase off"),
		"admin-coherence": booleanOption("Force admin coherence on"),
		"admin-coherence-off": booleanOption("Force admin coherence off"),
		"postcode-country-coherence": booleanOption("Force postcode-country coherence on"),
		"postcode-country-coherence-off": booleanOption("Force postcode-country coherence off"),
		"hierarchy-completion": booleanOption("Enable hierarchy completion"),
		"postcode-anchor": booleanOption("Add anchor-coordinate arm"),
		"postcode-shards": { type: "string", description: "Postcode shards" },
		"anchor-min-conf": { type: "number", description: "Anchor trust floor" },
		"anchor-rerank": booleanOption("Enable anchor rerank"),
		"address-points": { type: "string", description: "Address-point shard" },
		interpolation: { type: "string", description: "Interpolation shard" },
		cascade: booleanOption("Grade coordinate cascade"),
		"data-root": { type: "string", description: "Shard root" },
		"candidate-db": { type: "string", description: "Candidate backend" },
		"postal-city-alias-db": { type: "string", description: "Postal-city alias database" },
		assembled: booleanOption("Add assembled arms"),
		"admin-fst": { type: "string", description: "Per-locale FST" },
		"place-country": booleanOption("Enable coarse placer"),
		"place-country-hard": booleanOption("Enable safe hard filter"),
		"place-country-hard-all": booleanOption("Enable unrestricted hard filter"),
		"out-md": { type: "string", description: "Markdown output" },
		"out-json": { type: "string", description: "Aggregate JSON" },
		"errors-json": { type: "string", description: "Failure JSON" },
		"out-resolved": { type: "string", description: "Resolved locality dump" },
		"out-rows": { type: "string", description: "Outcome rows" },
	},
} as const satisfies CommandSpec

interface Options {
	eval?: string
	limit?: number
	model?: string
	tokenizer?: string
	modelCard?: string
	modelAnchorLookup?: string
	wof?: string
	defaultCountry?: string
	ablateToAnchor: boolean
	anchorOff: boolean
	normalizeCase: boolean
	rawCase: boolean
	adminCoherence: boolean
	adminCoherenceOff: boolean
	postcodeCountryCoherence: boolean
	postcodeCountryCoherenceOff: boolean
	hierarchyCompletion: boolean
	postcodeAnchor: boolean
	postcodeShards?: string
	anchorMinConf?: number
	anchorRerank: boolean
	addressPoints?: string
	interpolation?: string
	cascade: boolean
	dataRoot?: string
	candidateDB?: string
	postalCityAliasDB?: string
	assembled: boolean
	adminFst?: string
	placeCountry: boolean
	placeCountryHard: boolean
	placeCountryHardAll: boolean
	outMd?: string
	outJSON?: string
	errorsJSON?: string
	outResolved?: string
	outRows?: string
}

const EvalOAResolver: ParsedCommandComponent<Options> = ({ options }) => {
	const { adminCoherenceOff, adminFst, postcodeCountryCoherenceOff, ...rest } = options

	const state = useCommandTask(async () => {
		const { oaResolverEval } = await import("../../eval-harness/oa-resolver-eval.ts")

		return await oaResolverEval({
			...rest,
			noAdminCoherence: adminCoherenceOff,
			noPostcodeCountryCoherence: postcodeCountryCoherenceOff,
			// CLI kebab derivation forces the lowercase-acronym prop above; the harness option keeps
			// the house spelling, so the rename happens here rather than in the eval's own contract.
			...(adminFst ? { adminFST: adminFst } : {}),
		})
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The eval prints its own markdown report on stdout.
	return null
}

export default EvalOAResolver
