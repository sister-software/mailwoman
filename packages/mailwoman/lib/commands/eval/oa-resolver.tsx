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

import { booleanOption, type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "OpenAddresses real-point resolver eval — non-circular, neural vs v0 (Pelias)"

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
		wof: { type: "string", description: "WOF databases" },
		"default-country": { type: "string", description: "Default country" },
		"ablate-to-anchor": booleanOption("Disable gazetteer and conventions"),
		"anchor-off": booleanOption("Disable anchor input"),
		"normalize-case": booleanOption("Force normalizeCase on"),
		"raw-case": booleanOption("Force normalizeCase off"),
		"admin-coherence": booleanOption("Force admin coherence on"),
		"admin-coherence-off": booleanOption("Force admin coherence off"),
		"postcode-country-coherence": booleanOption("Force postcode-country coherence on"),
		"postcode-country-coherence-off": booleanOption("Force postcode-country coherence off"),
		"postcode-consistency-off": booleanOption("Force postcode-disambiguated locality selection off"),
		"postcode-max-move-km": { type: "number", description: "Cap how far the postcode fallback may move a coordinate" },
		"span-rescore-require-context-remainder": booleanOption("A sub-span may drop context, never a word of the name"),
		"span-rescore-weak-resolution": {
			type: "string",
			choices: ["score", "containment", "either"],
			description: "Which reading of a weak resolution lifts the #685 brake",
		},
		"hierarchy-completion": booleanOption("Enable hierarchy completion"),
		"postcode-anchor": booleanOption("Add anchor-coordinate arm"),
		"postcode-databases": { type: "string", description: "Postcode databases" },
		"anchor-min-conf": { type: "number", description: "Anchor trust floor" },
		"anchor-rerank": booleanOption("Enable anchor rerank"),
		"address-points": { type: "string", description: "Address-point database" },
		interpolation: { type: "string", description: "Interpolation database" },
		cascade: booleanOption("Grade coordinate cascade"),
		"data-root": { type: "string", description: "Database root" },
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
		"lookup-memo": booleanOption("Answer a repeated gazetteer query from a per-run memo"),
		"profile-json": { type: "string", description: "Wall-time attribution JSON (profiling only)" },
	},
} as const satisfies CommandSpec

// The eval prints its own markdown report on stdout, so no `json`.
const EvalOAResolver = harnessCommand(spec, async (options) => {
	const {
		adminCoherenceOff,
		adminFst,
		postcodeConsistencyOff,
		postcodeCountryCoherenceOff,
		postcodeMaxMoveKM,
		...rest
	} = options

	const { oaResolverEval } = await import("#eval-harness/oa/resolver/eval")

	return await oaResolverEval({
		...rest,
		noAdminCoherence: adminCoherenceOff,
		noPostcodeConsistency: postcodeConsistencyOff,
		noPostcodeCountryCoherence: postcodeCountryCoherenceOff,
		// CLI kebab derivation forces the lowercase-acronym prop above; the harness option keeps
		// the house spelling, so the rename happens here rather than in the eval's own contract.
		...(adminFst ? { adminFST: adminFst } : {}),
		// Same derivation, and the same rename — `--postcode-max-move-km` names #2301's cap, whose option spells the
		// pass it caps. Spreading the derived name instead reaches no field, so the cap is accepted and never applied.
		...(postcodeMaxMoveKM === undefined ? {} : { postcodeConsistencyMaxMoveKm: postcodeMaxMoveKM }),
	})
})

export default EvalOAResolver
