/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Verify that CLI configuration keys map to the effective session options used by confound checks.
 */

import { EFFECTIVE_KEY_FOR, effectiveKeyFor, resolveConfig } from "@mailwoman/dev-mcp/engine/registry"
import { ENGINE_CONFIG_SCHEMA } from "@mailwoman/dev-mcp/tool-kit"
import { describe, expect, it } from "vitest"

describe("EFFECTIVE_KEY_FOR", () => {
	it("covers every key the tool schema accepts", () => {
		// Check the user-facing schema, not only the TypeScript interface.
		const schemaKeys = Object.keys(ENGINE_CONFIG_SCHEMA.shape).toSorted()
		const mapped = Object.keys(EFFECTIVE_KEY_FOR)

		expect(schemaKeys.filter((key) => !mapped.includes(key))).toEqual([])
	})

	it("maps onto keys resolveConfig actually produces", () => {
		// Set every optional key to a non-default value so conditional fields are included.
		const resolved = resolveConfig({
			locale: "en-GB",
			country_scope: "none",
			default_country: "GB",
			bias: "51,0",
			candidate_db: "/tmp/c.db",
			resolve_db: "/tmp/r.db",
			data_root: "/tmp/root",
			weights_cache: "/tmp/candidate",
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
			capital_tier: true,
			variant_alias_exemption: true,
			trace: true,
			diagnose_unreachable: true,
		})

		const produced = Object.keys(resolved)
		const missing = Object.values(EFFECTIVE_KEY_FOR).filter((key) => !produced.includes(key))

		expect(missing).toEqual([])
	})

	it("keeps `diagnose_unreachable` OUT of the tool schema on purpose", () => {
		// This diagnostic does not change answers and must remain outside comparison pins.
		expect(Object.keys(ENGINE_CONFIG_SCHEMA.shape)).not.toContain("diagnose_unreachable")
		expect(Object.keys(EFFECTIVE_KEY_FOR)).toContain("diagnose_unreachable")
	})

	it("passes through a declaration that is not a config key at all", () => {
		// Cross-engine comparisons declare `engine`, which is not an EngineConfig key.
		expect(effectiveKeyFor("engine")).toBe("engine")
		expect(effectiveKeyFor("tree_fingerprint")).toBe("tree_fingerprint")
	})

	it("translates the CLI spelling a caller is documented to use", () => {
		expect(effectiveKeyFor("place_country")).toBe("placeCountry")
		expect(effectiveKeyFor("gazetteer_prior")).toBe("gazetteerPrior")
		expect(effectiveKeyFor("candidate_db")).toBe("candidateDB")
	})
})
