/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests that CLI configuration keys map to the session option names that confound checks read.
 */

import { EFFECTIVE_KEY_FOR, effectiveKeyFor, resolveConfig } from "@mailwoman/dev-mcp/engine/registry"
import { ENGINE_CONFIG_SCHEMA } from "@mailwoman/dev-mcp/tool-kit"
import { describe, expect, it } from "vitest"

describe("EFFECTIVE_KEY_FOR", () => {
	it("covers every key the tool schema accepts", () => {
		// The tool schema is what callers validate against, so the check reads it directly.
		const schemaKeys = Object.keys(ENGINE_CONFIG_SCHEMA.shape).toSorted()
		const mapped = Object.keys(EFFECTIVE_KEY_FOR)

		expect(schemaKeys.filter((key) => !mapped.includes(key))).toEqual([])
	})

	it("maps onto keys resolveConfig actually produces", () => {
		// Every key gets a non-default value, so `resolveConfig` emits its conditional fields too.
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
		// This diagnostic never changes answers, so it stays out of the comparison pins.
		expect(Object.keys(ENGINE_CONFIG_SCHEMA.shape)).not.toContain("diagnose_unreachable")
		expect(Object.keys(EFFECTIVE_KEY_FOR)).toContain("diagnose_unreachable")
	})

	it("passes through a declaration that is not a config key at all", () => {
		// A cross-engine comparison declares `engine`, which has no `EngineConfig` mapping.
		expect(effectiveKeyFor("engine")).toBe("engine")
		expect(effectiveKeyFor("tree_fingerprint")).toBe("tree_fingerprint")
	})

	it("translates the CLI spelling a caller is documented to use", () => {
		expect(effectiveKeyFor("place_country")).toBe("placeCountry")
		expect(effectiveKeyFor("gazetteer_prior")).toBe("gazetteerPrior")
		expect(effectiveKeyFor("candidate_db")).toBe("candidateDB")
	})
})
