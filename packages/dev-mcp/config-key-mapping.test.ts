/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two config vocabularies must stay in step, and nothing else can check it.
 *
 *   `EngineConfig` is the CLI's snake_case; `GeocodeSessionOptions` is camelCase. `resolveConfig` translates, and
 *   `EFFECTIVE_KEY_FOR` names the same translation for `confound.ts`. A lever added to one and not the other compiles
 *   and passes every other test — and silently makes every correctly-declared comparison grade itself ambiguous, which
 *   is a defect in a verdict rather than in a number, so no measurement fails either.
 */

import { describe, expect, it } from "vitest"

import { EFFECTIVE_KEY_FOR, effectiveKeyFor, resolveConfig } from "./engine-registry.ts"
import { ENGINE_CONFIG_SCHEMA } from "./tool-kit.ts"

describe("EFFECTIVE_KEY_FOR", () => {
	it("covers every key the tool schema accepts", () => {
		// The schema is what a caller can actually type, so it is the population that matters — not the TS interface,
		// which a `satisfies` clause already checks at compile time.
		const schemaKeys = Object.keys(ENGINE_CONFIG_SCHEMA.shape).toSorted()
		const mapped = Object.keys(EFFECTIVE_KEY_FOR)

		expect(schemaKeys.filter((key) => !mapped.includes(key))).toEqual([])
	})

	it("maps onto keys resolveConfig actually produces", () => {
		// Every lever set to a NON-default value, so nothing lands on the conditional-spread branches and drops out.
		const resolved = resolveConfig({
			locale: "en-GB",
			country_scope: "none",
			default_country: "GB",
			bias: "51,0",
			candidate_db: "/tmp/c.db",
			resolve_db: "/tmp/r.db",
			data_root: "/tmp/root",
			gazetteer_prior: false,
			place_country: false,
			place_country_threshold: 0.9,
			postcode_country_coherence: false,
			fork_entity: false,
			locale_country_prior: true,
			postcode_shape_coherence: false,
			postcode_containment_coherence: false,
			admin_containment_rerank: true,
			poi_venue_tier: true,
			trace: true,
		})

		const produced = Object.keys(resolved)
		const missing = Object.values(EFFECTIVE_KEY_FOR).filter((key) => !produced.includes(key))

		expect(missing).toEqual([])
	})

	it("passes through a declaration that is not a config key at all", () => {
		// `["engine"]` is the correct declaration for a cross-engine comparison, where no config key can express the
		// variable. Rejecting it would refuse the one honest declaration for that case.
		expect(effectiveKeyFor("engine")).toBe("engine")
		expect(effectiveKeyFor("tree_fingerprint")).toBe("tree_fingerprint")
	})

	it("translates the CLI spelling a caller is documented to use", () => {
		expect(effectiveKeyFor("place_country")).toBe("placeCountry")
		expect(effectiveKeyFor("gazetteer_prior")).toBe("gazetteerPrior")
		expect(effectiveKeyFor("candidate_db")).toBe("candidateDB")
	})
})
