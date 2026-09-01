/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The collision contract for the address-point normalizer (#476): variants that refer to the same
 *   street MUST normalize identically; distinct streets must not. Build-side and lookup-side both
 *   import the same function, so these tests are the whole correctness story for the keying.
 */

import {
	canonicalizeRouteKey,
	normalizeLocalityForKey,
	normalizeStreetForKey,
	normalizeStreetForKeyLocale,
	streetKeyVariants,
	streetLocaleForSurface,
	stripLocalityQualifier,
} from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { describe, expect, it } from "vitest"

describe("normalizeStreetForKey", () => {
	it("collides USPS suffix variants", () => {
		expect(normalizeStreetForKey("Main St")).toEqual(normalizeStreetForKey("Main Street"))
		expect(normalizeStreetForKey("Wacker Dr.")).toEqual(normalizeStreetForKey("Wacker Drive"))
		expect(normalizeStreetForKey("Fifth Ave")).toEqual(normalizeStreetForKey("Fifth Avenue"))
	})

	it("collides leading directional abbreviations (incl. compound + two-word forms)", () => {
		expect(normalizeStreetForKey("N Main St")).toEqual(normalizeStreetForKey("North Main Street"))
		expect(normalizeStreetForKey("SE Division St")).toEqual(normalizeStreetForKey("Southeast Division Street"))
		expect(normalizeStreetForKey("South East Division St")).toEqual(normalizeStreetForKey("SE Division Street"))
	})

	it("collides trailing directionals (3+ tokens)", () => {
		expect(normalizeStreetForKey("Main St N")).toEqual(normalizeStreetForKey("Main Street North"))
	})

	it("does NOT expand interior single-letter tokens (person initials)", () => {
		expect(normalizeStreetForKey("Martin L King Jr Blvd")).toContain(" l ")
	})

	it("does not collapse a bare directional-only name", () => {
		// "N" alone is a (weird but real) street name — single tokens are never expanded.
		expect(normalizeStreetForKey("N")).toBe("n")
	})

	it("keeps numbered streets as digits and folds case/punct/diacritics", () => {
		expect(normalizeStreetForKey("5th Ave")).toBe("5th avenue")
		expect(normalizeStreetForKey("  CALLE   José.  ")).toBe("calle jose")
	})

	it("folds a spelled ordinal before a street suffix to digit form (#723)", () => {
		expect(normalizeStreetForKey("Tenth St")).toEqual(normalizeStreetForKey("10th Street"))
		expect(normalizeStreetForKey("Fifth Avenue")).toEqual(normalizeStreetForKey("5th Ave"))
		expect(normalizeStreetForKey("Twentieth St")).toBe("20th street")
	})

	it("does NOT fold an ordinal WORD that is not followed by a street suffix", () => {
		// "First National Bank Rd" — "First" is a name prefix here, not an ordinal cross-street.
		expect(normalizeStreetForKey("First National Bank Rd")).toContain("first")
	})

	it("distinct streets stay distinct", () => {
		expect(normalizeStreetForKey("Main Street")).not.toEqual(normalizeStreetForKey("Maine Street"))
		expect(normalizeStreetForKey("North Main Street")).not.toEqual(normalizeStreetForKey("Main Street"))
	})
})

describe("normalizeLocalityForKey", () => {
	it("folds without street semantics", () => {
		expect(normalizeLocalityForKey("St. Albans")).toBe("st albans")
		expect(normalizeLocalityForKey("Montréal")).toBe("montreal")
	})
})

describe("canonicalizeRouteKey", () => {
	it("folds TIGER and E911/Overture route spellings to the same key", () => {
		// TIGER "State Rte 100" → normalizeStreetForKey → "state route 100" already; the E911
		// spelling needs the designator fold to meet it.
		expect(canonicalizeRouteKey(normalizeStreetForKey("State Rte 100"))).toBe("state route 100")
		expect(canonicalizeRouteKey(normalizeStreetForKey("VT ROUTE 100"))).toBe("state route 100")
		expect(canonicalizeRouteKey(normalizeStreetForKey("US Hwy 5"))).toBe("us route 5")
		expect(canonicalizeRouteKey(normalizeStreetForKey("US ROUTE 5"))).toBe("us route 5")
	})

	it("keeps the post-designator tail (letter suffixes, trailing directionals)", () => {
		expect(canonicalizeRouteKey(normalizeStreetForKey("State Rte 22A"))).toBe("state route 22a")
		expect(canonicalizeRouteKey(normalizeStreetForKey("VT ROUTE 22A"))).toBe("state route 22a")

		expect(canonicalizeRouteKey(normalizeStreetForKey("US Hwy 5 S"))).toEqual(
			canonicalizeRouteKey(normalizeStreetForKey("US ROUTE 5 S"))
		)
	})

	it("never folds non-route names", () => {
		expect(canonicalizeRouteKey(normalizeStreetForKey("State Street"))).toBe("state street")
		expect(canonicalizeRouteKey(normalizeStreetForKey("Old Route 100"))).toBe("old route 100")
		// Bare "Route N" stays unfolded — the designator (US vs state) is unknown.
		expect(canonicalizeRouteKey(normalizeStreetForKey("Route 100"))).toBe("route 100")
	})
})

describe("stripLocalityQualifier (query-side fallback)", () => {
	it("strips an OA locality qualifier to the gazetteer base name", () => {
		expect(stripLocalityQualifier("Kraubath/Mur")).toBe("Kraubath") // AT slash-qualifier
		expect(stripLocalityQualifier("St.Kanzian/Klopeiner See")).toBe("St.Kanzian")
		expect(stripLocalityQualifier("Hart b.Graz")).toBe("Hart") // abbreviated bei
		expect(stripLocalityQualifier("Feistritz o.Bleiburg")).toBe("Feistritz") // abbreviated ob
		expect(stripLocalityQualifier("Lenk im Simmental")).toBe("Lenk") // CH spelled qualifier
		expect(stripLocalityQualifier("Roche VD")).toBe("Roche") // CH canton code
		expect(stripLocalityQualifier("Odense S")).toBe("Odense") // DK postal direction
		expect(stripLocalityQualifier("Hurup Thy")).toBe("Hurup") // DK region suffix
	})

	it("returns '' when nothing is stripped (no wasted re-probe)", () => {
		expect(stripLocalityQualifier("Paris")).toBe("")
		expect(stripLocalityQualifier("San Francisco")).toBe("")
		// "am Main" is part of the canonical name — must NOT be over-stripped.
		expect(stripLocalityQualifier("Frankfurt am Main")).toBe("")
		expect(stripLocalityQualifier("New York")).toBe("")
		expect(stripLocalityQualifier("Foo an der")).toBe("")
		expect(stripLocalityQualifier("S")).toBe("")
	})

	it("handles long non-matching input without regex backtracking", () => {
		expect(stripLocalityQualifier(`Saint ${"a".repeat(100_000)}`)).toBe("")
	})
})

describe("streetKeyVariants", () => {
	it("keeps a plain name single-variant", () => {
		expect(streetKeyVariants("East 13 Mile Road")).toEqual(["east 13 mile road"])
		expect(streetKeyVariants("Main St")).toEqual(["main street"])
	})

	it("collapses the doubled-type tail and canonicalizes what remains", () => {
		expect(streetKeyVariants("Saint Pauls PL St")).toEqual([
			"saint pauls pl street",
			"saint pauls place",
			"st pauls pl street",
			"st pauls place",
		])
	})

	it("swaps a leading saint↔st in both directions", () => {
		expect(streetKeyVariants("Saint Pauls Pl")).toEqual(["saint pauls place", "st pauls place"])
		expect(streetKeyVariants("St Pauls Pl")).toEqual(["st pauls place", "saint pauls place"])
	})

	it("never touches a street genuinely named with a type word", () => {
		// Street Road (Bucks County PA) and a one-word name: no doubled-type signature, no saint.
		expect(streetKeyVariants("Street Road")).toEqual(["street road"])
		expect(streetKeyVariants("Broadway")).toEqual(["broadway"])
	})

	it("stays single-variant for non-US locales", () => {
		expect(streetKeyVariants("Rue Saint Honoré", "fr")).toHaveLength(1)
	})
})

describe("streetLocaleForSurface (the Québec surface router)", () => {
	it("routes a French-lead surface to fr under an en base — the CA bilingual case", () => {
		expect(streetLocaleForSurface("boul Saint-Laurent", "en")).toBe("fr")
		expect(streetLocaleForSurface("Rue Gabrielle-Roy", "en")).toBe("fr")
		expect(streetLocaleForSurface("Allée des Becs-Scie", "en")).toBe("fr")
		expect(streetLocaleForSurface("Ch. de la Côte-des-Neiges", "en")).toBe("fr")
	})

	it("keeps English surfaces on en — trailing types and digit-lead never match", () => {
		expect(streetLocaleForSurface("Laurell Road", "en")).toBe("en")
		expect(streetLocaleForSurface("Fifth Avenue", "en")).toBe("en")
		expect(streetLocaleForSurface("Grosvenor Place", "en")).toBe("en")
		expect(streetLocaleForSurface("1 Avenue NE", "en")).toBe("en")
		// "Main St": st abbreviates Street here, and the fr rules would expand it to saint — the
		// lead-anchored predicate is what keeps that fold away from English surfaces.
		expect(streetLocaleForSurface("Main St", "en")).toBe("en")
	})

	it("only an en base re-routes — fr/de/nl extracts already speak their own rules, us stays untouched", () => {
		expect(streetLocaleForSurface("Rue de Rivoli", "fr")).toBe("fr")
		expect(streetLocaleForSurface("Rue Quelconque", "de")).toBe("de")
		expect(streetLocaleForSurface("Rue Something", "us")).toBe("us")
	})

	it("routing composes with the fold: both ends of the CA abbreviation-variance class key identically", () => {
		const build = normalizeStreetForKeyLocale(
			"Boulevard Saint-Laurent",
			streetLocaleForSurface("Boulevard Saint-Laurent", "en")
		)

		const query = normalizeStreetForKeyLocale("boul St-Laurent", streetLocaleForSurface("boul St-Laurent", "en"))

		expect(build).toBe("boulevard saint laurent")
		expect(query).toBe(build)
	})
})

describe("normalizeStreetForKeyLocale — the pl/vn/id branches (the 2026-08-19 coverage lane)", () => {
	it("pl: folds ł (the non-decomposing letter) and STRIPS the leading type — OSM Poland tags streets bare", () => {
		// Typed, spelled and bare surfaces all key to the extract's bare form (22 of 5.56M rows carry "ulica").
		expect(normalizeStreetForKeyLocale("ul. Świętokrzyska", "pl")).toBe("swietokrzyska")
		expect(normalizeStreetForKeyLocale("ulica Świętokrzyska", "pl")).toBe("swietokrzyska")
		expect(normalizeStreetForKeyLocale("Świętokrzyska", "pl")).toBe("swietokrzyska")
		expect(normalizeStreetForKeyLocale("Marszałkowska", "pl")).toBe("marszalkowska")
		expect(normalizeStreetForKeyLocale("al. Jerozolimskie", "pl")).toBe("jerozolimskie")
		expect(normalizeStreetForKeyLocale("Plac Zamkowy", "pl")).toBe("zamkowy")
		// The type alone is a name, not a prefix — never stripped to nothing.
		expect(normalizeStreetForKeyLocale("Ulica", "pl")).toBe("ulica")
	})

	it("vn: folds BOTH đ (d-with-stroke) and ð (eth) — OSM mixes the codepoints inside one value", () => {
		expect(normalizeStreetForKeyLocale("Đường Trần Hưng Đạo", "vn")).toBe("duong tran hung dao")
		// The measured OSM mixture: U+0110 leading, U+00D0 (ETH) inside Đạo — the majority variant's key.
		expect(normalizeStreetForKeyLocale("\u0110ường Trần Hưng \u00D0ạo", "vn")).toBe("duong tran hung dao")
		expect(normalizeStreetForKeyLocale("Duong Tran Hung Dao", "vn")).toBe("duong tran hung dao")
		expect(normalizeStreetForKeyLocale("Phố Huế", "vn")).toBe("pho hue")
	})

	it("id: expands the jalan/gang abbreviations", () => {
		expect(normalizeStreetForKeyLocale("Jl. Thamrin", "id")).toBe("jalan thamrin")
		expect(normalizeStreetForKeyLocale("Jalan Thamrin", "id")).toBe("jalan thamrin")
		expect(normalizeStreetForKeyLocale("Gg. Waru", "id")).toBe("gang waru")
	})

	it("the letter maps stay OUT of the other locales — built extracts keep their keys", () => {
		// A Polish-named street in a de extract keys with ł intact, exactly as the extract was built.
		expect(normalizeStreetForKeyLocale("Łuckastraße", "de")).toBe("łuckastrasse")
	})
})
