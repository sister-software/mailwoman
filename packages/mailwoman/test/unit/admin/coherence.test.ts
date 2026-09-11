/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit coverage for the #1717 stage-1 admin-coherence verdicts: all four verdicts per component,
 *   the shared-fold matching behavior (case + diacritics — asserted against what
 *   `normalizeLocalityForKey` actually does, not what one might assume), the stated v1 bound
 *   (variant forms read `contradicted`), and the additive threading through `toGauntletResult`.
 */

import { assessAdminCoherence, type AdminCoherenceWinner } from "mailwoman/admin-coherence"
import { toGauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import type { GeocodeResult } from "mailwoman/geocode"
import { describe, expect, it } from "vitest"

/**
 * The #1717 shape: a locality winner from the candidate tier — carries a `resolver_country` stamp but NO ancestor chain
 * (candidate.db has no ancestors table).
 */
const weimarTexas: AdminCoherenceWinner = { tag: "locality", countryCode: "US" }

describe("assessAdminCoherence — region verdicts", () => {
	it("unstated when the parse produced no region qualifier", () => {
		expect(assessAdminCoherence({}, weimarTexas).region).toBe("unstated")
		expect(assessAdminCoherence({ region: "   " }, weimarTexas).region).toBe("unstated")
	})

	it("unverifiable when the winner carries no region-class ancestry (the candidate-tier finding)", () => {
		// `Weimar, Thüringen` → Weimar TX: the qualifier was parsed, the winner has no ancestry of
		// that class to check it against. This must NOT read as confirmed or contradicted.
		expect(assessAdminCoherence({ region: "Thüringen" }, weimarTexas).region).toBe("unverifiable")
	})

	it("confirmed on a fold-equal region ancestor — case and diacritics are folded", () => {
		// The shared fold lowercases and strips diacritics: "Thüringen" ≡ "thuringen" ≡ "THÜRINGEN".
		const winner: AdminCoherenceWinner = {
			tag: "locality",
			countryCode: "DE",
			ancestry: [{ placetype: "region", name: "thuringen" }],
		}

		expect(assessAdminCoherence({ region: "Thüringen" }, winner).region).toBe("confirmed")
		expect(assessAdminCoherence({ region: "THÜRINGEN" }, winner).region).toBe("confirmed")
	})

	it("contradicted when region-class ancestry exists and none of it fold-matches", () => {
		const winner: AdminCoherenceWinner = {
			tag: "locality",
			countryCode: "US",
			ancestry: [{ placetype: "region", name: "Texas" }],
		}

		expect(assessAdminCoherence({ region: "Thüringen" }, winner).region).toBe("contradicted")
	})

	it("contradicted on a cross-language variant form — the stated v1 bound", () => {
		// "Thüringen" folds to "thuringen", the stored exonym "Thuringia" to "thuringia": fold
		// equality cannot bridge the variant, and v1 deliberately does not consult the gazetteer's
		// alias table. Documented in the module docstring; this test pins the bound.
		const winner: AdminCoherenceWinner = {
			tag: "locality",
			countryCode: "DE",
			ancestry: [{ placetype: "region", name: "Thuringia" }],
		}

		expect(assessAdminCoherence({ region: "Thüringen" }, winner).region).toBe("contradicted")
	})

	it("confirmed across the codex subdivision table: abbreviation vs full state name, either side", () => {
		const abbreviated: AdminCoherenceWinner = {
			tag: "locality",
			countryCode: "US",
			ancestry: [{ placetype: "region", name: "IL" }],
		}

		const full: AdminCoherenceWinner = {
			tag: "locality",
			countryCode: "US",
			ancestry: [{ placetype: "region", name: "Illinois" }],
		}

		expect(assessAdminCoherence({ region: "Illinois" }, abbreviated).region).toBe("confirmed")
		expect(assessAdminCoherence({ region: "IL" }, full).region).toBe("confirmed")
	})

	it("confirmed against any placetype in the region band (county answers for a county-grade qualifier)", () => {
		const winner: AdminCoherenceWinner = {
			tag: "locality",
			countryCode: "GB",
			ancestry: [{ placetype: "county", name: "Lancashire" }],
		}

		expect(assessAdminCoherence({ region: "Lancashire" }, winner).region).toBe("confirmed")
	})

	it("self-confirmation: a region-tagged winner IS the region qualifier's resolution", () => {
		// The resolver's own (alias-aware) binding is the evidence — re-checking "Thüringen" against
		// the resolved name "Thuringia" under fold-equality would misread every alias hit.
		const winner: AdminCoherenceWinner = { tag: "region", countryCode: "DE" }

		expect(assessAdminCoherence({ region: "Thüringen" }, winner).region).toBe("confirmed")
	})

	it("the mislabel bridge: a COUNTRY name in the region slot confirms against country-class evidence", () => {
		// "Batumi, Georgia" parses region="Georgia" and resolves Batumi GE — the region band (Adjara)
		// cannot match, but the winner's country-class evidence can, and `contradicted` would be the
		// wrong claim about the geography. The bridge runs through the SAME winnerCountryKeys the
		// country verdict reads, so the two verdicts can never disagree about country evidence.
		const batumi: AdminCoherenceWinner = {
			tag: "locality",
			countryCode: "GE",
			ancestry: [
				{ placetype: "region", name: "Adjara" },
				{ placetype: "country", name: "Georgia" },
			],
		}

		expect(assessAdminCoherence({ region: "Georgia" }, batumi).region).toBe("confirmed")

		// The bridge inherits the module's pure-codex bound: "Moscow, Russia" resolves Москва RU, but
		// codex's table holds only "Russian Federation" for RU (matchCountry("Russia") is null), so the
		// bridge cannot vouch and the verdict stays contradicted rather than over-claiming — exactly
		// the posture the country verdict itself takes on the same pair.
		const moskva: AdminCoherenceWinner = {
			tag: "locality",
			countryCode: "RU",
			ancestry: [
				{ placetype: "region", name: "Москва" },
				{ placetype: "country", name: "Россия" },
			],
		}

		expect(assessAdminCoherence({ region: "Russia" }, moskva).region).toBe("contradicted")
	})

	it("the bridge is MONOTONE: a non-country region qualifier still reads exactly as before", () => {
		// A genuine wrong-instance row must stay contradicted — the bridge only fires when the parsed
		// region genuinely names the winner's own country.
		const georgetownTexas: AdminCoherenceWinner = {
			tag: "locality",
			countryCode: "US",
			ancestry: [
				{ placetype: "region", name: "Texas" },
				{ placetype: "country", name: "United States" },
			],
		}

		expect(assessAdminCoherence({ region: "Penang" }, georgetownTexas).region).toBe("contradicted")

		// And with NO region-class ancestry and no country match, the faithful verdict stays
		// unverifiable — the bridge never converts an unanswerable question into a decided one.
		const bare: AdminCoherenceWinner = { tag: "locality", countryCode: "US" }

		expect(assessAdminCoherence({ region: "Thüringen" }, bare).region).toBe("unverifiable")
	})
})

describe("assessAdminCoherence — country verdicts", () => {
	it("unstated when the parse produced no country qualifier", () => {
		expect(assessAdminCoherence({ region: "Thüringen" }, weimarTexas).country).toBe("unstated")
	})

	it("confirmed via the codex country tables: surface form, endonym, alpha-3 all meet the ISO stamp", () => {
		const germany: AdminCoherenceWinner = { tag: "locality", countryCode: "DE" }

		expect(assessAdminCoherence({ country: "Germany" }, germany).country).toBe("confirmed")
		expect(assessAdminCoherence({ country: "Deutschland" }, germany).country).toBe("confirmed")
		expect(assessAdminCoherence({ country: "DEU" }, germany).country).toBe("confirmed")
		expect(assessAdminCoherence({ country: "de" }, germany).country).toBe("confirmed")
	})

	it("contradicted when the parsed country resolves to a different ISO country than the winner's stamp", () => {
		expect(assessAdminCoherence({ country: "Germany" }, weimarTexas).country).toBe("contradicted")
	})

	it("confirmed against a country-placetype ancestor by name when no ISO stamp exists", () => {
		const winner: AdminCoherenceWinner = {
			tag: "locality",
			ancestry: [{ placetype: "country", name: "United States" }],
		}

		expect(assessAdminCoherence({ country: "USA" }, winner).country).toBe("confirmed")
	})

	it("unverifiable when the winner has neither an ISO stamp nor country-class ancestry", () => {
		const winner: AdminCoherenceWinner = { tag: "locality" }

		expect(assessAdminCoherence({ country: "Germany" }, winner).country).toBe("unverifiable")
	})

	it("self-confirmation: a country-tagged winner IS the country qualifier's resolution", () => {
		const winner: AdminCoherenceWinner = { tag: "country", countryCode: "DE" }

		expect(assessAdminCoherence({ country: "Deutschland" }, winner).country).toBe("confirmed")
	})

	it("contradicted on an uncurated endonym — the stated v1 bound for the country side", () => {
		// "Alemania" is not in the codex surface forms for DE, so neither the ISO channel nor the
		// fold can vouch for it against a DE winner. The module never silently over-claims.
		const germany: AdminCoherenceWinner = { tag: "locality", countryCode: "DE" }

		expect(assessAdminCoherence({ country: "Alemania" }, germany).country).toBe("contradicted")
	})
})

describe("toGauntletResult threading (additive optional field)", () => {
	const baseResult: GeocodeResult = {
		input: "Weimar, Thüringen",
		components: { locality: "Weimar", region: "Thüringen" },
		lat: 29.7,
		lon: -96.78,
		resolution_tier: "admin",
		epistemic_status: "observed",
		uncertainty_m: null,
		locality: "Weimar",
		region: "Thüringen",
		postcode: null,
		house_number: null,
		street: null,
		venue: null,
		dependent_locality: null,
		unit: null,
		countryCode: "US",
		hierarchy: [{ tag: "locality", value: "Weimar", name: "Weimar", lat: 29.7, lon: -96.78 }],
		candidates: [{ name: "Weimar", tag: "locality", lat: 29.7, lon: -96.78, countryCode: "US" }],
		postcode_country_scope: null,
		intent_markers: [],
	}

	it("carries admin_coherence through verbatim when present", () => {
		const projected = toGauntletResult({
			...baseResult,
			admin_coherence: { region: "unverifiable", country: "unstated" },
		})

		expect(projected.admin_coherence).toEqual({ region: "unverifiable", country: "unstated" })
	})

	it("omits the field entirely when the result has none (additive — absence stays absence)", () => {
		const projected = toGauntletResult(baseResult)

		expect(projected.admin_coherence).toBeUndefined()
		expect("admin_coherence" in projected).toBe(false)
	})
})

describe("regionVerdict — the fold-bound closures (2026-08-18)", () => {
	it("confirms an Irish county qualifier through the Co. prefix", () => {
		// Five Irish board rows read contradicted on the first census because `Co. Westmeath` folds with the prefix
		// intact while WOF stores `Westmeath`.
		const report = assessAdminCoherence(
			{ region: "Co. Westmeath" },
			{ tag: "locality", countryCode: "IE", ancestry: [{ placetype: "region", name: "Westmeath" }] }
		)

		expect(report.region).toBe("confirmed")
	})

	it("keeps County Durham matching itself — the stripped variant is added, never substituted", () => {
		const report = assessAdminCoherence(
			{ region: "County Durham" },
			{ tag: "locality", countryCode: "GB", ancestry: [{ placetype: "county", name: "County Durham" }] }
		)

		expect(report.region).toBe("confirmed")
	})

	it("confirms an AU state code against its full ancestry name, scoped by the winner's country", () => {
		const report = assessAdminCoherence(
			{ region: "WA" },
			{ tag: "locality", countryCode: "AU", ancestry: [{ placetype: "region", name: "Western Australia" }] }
		)

		expect(report.region).toBe("confirmed")
	})

	it("does not let the AU expansion leak into a US winner — WA stays Washington there", () => {
		const report = assessAdminCoherence(
			{ region: "WA" },
			{ tag: "locality", countryCode: "US", ancestry: [{ placetype: "region", name: "Western Australia" }] }
		)

		// A US winner whose ancestry claims Western Australia is genuinely incoherent; the scoped table must not
		// bridge it.
		expect(report.region).toBe("contradicted")
	})

	it("still contradicts an honest mismatch — the closures only widen matching, never verdicts", () => {
		const report = assessAdminCoherence(
			{ region: "Co. Donegal" },
			{ tag: "locality", countryCode: "US", ancestry: [{ placetype: "region", name: "Virginia" }] }
		)

		expect(report.region).toBe("contradicted")
	})
})

describe("regionVerdict — trailing qualifier", () => {
	it("confirms a Province-suffixed qualifier against the bare stored name", () => {
		// The one genuine fold false-alarm in the 2026-08-18 sixteen-row triage: San José Province vs stored San José.
		const report = assessAdminCoherence(
			{ region: "San José Province" },
			{ tag: "locality", countryCode: "CR", ancestry: [{ placetype: "region", name: "San José" }] }
		)

		expect(report.region).toBe("confirmed")
	})
})
