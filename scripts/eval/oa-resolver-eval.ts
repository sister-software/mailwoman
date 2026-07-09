/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   NOTE(phase5a): forwarding shim. The OpenAddresses real-point resolver eval now lives at
 *   `mailwoman/eval-harness/oa-resolver-eval.ts` behind `mailwoman eval oa-resolver`. This shim
 *   keeps the STANDING PROBES that spawn `node scripts/eval/oa-resolver-eval.ts` as a child process
 *   working unchanged — `de-order-eval.ts` (a promotion-gate battery leg), `honest-eval.ts`,
 *   `eval-de-coverage.ts`, and `de-pip-eval.ts` — until the probe triage repoints or retires them.
 *   It parses the same argv the old script did and calls the module; output is byte-identical
 *   because the module owns every printed line. Do not add logic here.
 */

import { parseArgs } from "node:util"

import { runIfScript } from "@mailwoman/core/scripting"

import { oaResolverEval } from "../../mailwoman/eval-harness/oa-resolver-eval.ts"

async function main(): Promise<void> {
	// Loose scan parity with the retired local argv helpers: unknown flags tolerated.
	const { values: rawValues } = parseArgs({
		options: {
			"ablate-to-anchor": { type: "boolean" },
			"address-points": { type: "string" },
			"admin-coherence": { type: "boolean" },
			"anchor-min-conf": { type: "string" },
			"anchor-off": { type: "boolean" },
			"anchor-rerank": { type: "boolean" },
			assembled: { type: "boolean" },
			"candidate-db": { type: "string" },
			cascade: { type: "boolean" },
			"city-state-fallback": { type: "boolean" },
			"data-root": { type: "string" },
			"default-country": { type: "string" },
			"errors-json": { type: "string" },
			eval: { type: "string" },
			"hierarchy-completion": { type: "boolean" },
			interpolation: { type: "string" },
			limit: { type: "string" },
			model: { type: "string" },
			"model-anchor-lookup": { type: "string" },
			"model-card": { type: "string" },
			"no-admin-coherence": { type: "boolean" },
			"normalize-case": { type: "boolean" },
			"out-json": { type: "string" },
			"out-md": { type: "string" },
			"out-resolved": { type: "string" },
			"out-rows": { type: "string" },
			"place-country": { type: "boolean" },
			"place-country-hard": { type: "boolean" },
			"place-country-hard-all": { type: "boolean" },
			"postal-city-alias-db": { type: "string" },
			"postcode-anchor": { type: "boolean" },
			"postcode-shards": { type: "string" },
			"raw-case": { type: "boolean" },
			tokenizer: { type: "string" },
			wof: { type: "string" },
		},
		strict: false,
		allowPositionals: true,
	})
	// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
	const values = rawValues as Record<string, string | boolean | undefined>

	await oaResolverEval({
		ablateToAnchor: values["ablate-to-anchor"] as boolean | undefined,
		addressPoints: values["address-points"] as string | undefined,
		adminCoherence: values["admin-coherence"] as boolean | undefined,
		// The old script defaulted via `Number(values["anchor-min-conf"] || "0.5")` — same math here.
		anchorMinConf: Number((values["anchor-min-conf"] as string | undefined) || "0.5"),
		anchorOff: values["anchor-off"] as boolean | undefined,
		anchorRerank: values["anchor-rerank"] as boolean | undefined,
		assembled: values["assembled"] as boolean | undefined,
		candidateDb: values["candidate-db"] as string | undefined,
		cascade: values["cascade"] as boolean | undefined,
		cityStateFallback: values["city-state-fallback"] as boolean | undefined,
		dataRoot: values["data-root"] as string | undefined,
		defaultCountry: values["default-country"] as string | undefined,
		errorsJson: values["errors-json"] as string | undefined,
		eval: values["eval"] as string | undefined,
		hierarchyCompletion: values["hierarchy-completion"] as boolean | undefined,
		interpolation: values["interpolation"] as string | undefined,
		// `Number(values["limit"] || "0")` parity: absent/0 → all rows (the module maps 0 → Infinity).
		limit: Number((values["limit"] as string | undefined) || "0"),
		model: values["model"] as string | undefined,
		modelAnchorLookup: values["model-anchor-lookup"] as string | undefined,
		modelCard: values["model-card"] as string | undefined,
		noAdminCoherence: values["no-admin-coherence"] as boolean | undefined,
		normalizeCase: values["normalize-case"] as boolean | undefined,
		outJson: values["out-json"] as string | undefined,
		outMd: values["out-md"] as string | undefined,
		outResolved: values["out-resolved"] as string | undefined,
		outRows: values["out-rows"] as string | undefined,
		placeCountry: values["place-country"] as boolean | undefined,
		placeCountryHard: values["place-country-hard"] as boolean | undefined,
		placeCountryHardAll: values["place-country-hard-all"] as boolean | undefined,
		postalCityAliasDb: values["postal-city-alias-db"] as string | undefined,
		postcodeAnchor: values["postcode-anchor"] as boolean | undefined,
		postcodeShards: values["postcode-shards"] as string | undefined,
		rawCase: values["raw-case"] as boolean | undefined,
		tokenizer: values["tokenizer"] as string | undefined,
		wof: values["wof"] as string | undefined,
	})
}

runIfScript(import.meta, main)
