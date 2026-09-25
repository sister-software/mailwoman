import {
	canonicalizeRouteKey,
	normalizeHouseNumberForKey,
	normalizeLocalityForKey,
	normalizeLocalityForKeyLocale,
	normalizeStreetForKey,
	normalizeStreetForKeyLocale,
	streetKeyVariants,
	streetLocaleForSurface,
	stripLocalityQualifier,
} from "@mailwoman/resolver-wof-sqlite/street"
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
		expect(normalizeStreetForKey("N")).toBe("n")
	})

	it("keeps numbered streets as digits and folds case/punct/diacritics", () => {
		expect(normalizeStreetForKey("5th Ave")).toBe("5th avenue")
		expect(normalizeStreetForKey("  CALLE   José.  ")).toBe("calle jose")
	})

	it("Folds a spelled ordinal before a street suffix to digit form", () => {
		expect(normalizeStreetForKey("Tenth St")).toEqual(normalizeStreetForKey("10th Street"))
		expect(normalizeStreetForKey("Fifth Avenue")).toEqual(normalizeStreetForKey("5th Ave"))
		expect(normalizeStreetForKey("Twentieth St")).toBe("20th street")
	})

	it("does NOT fold an ordinal WORD that is not followed by a street suffix", () => {
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

		expect(canonicalizeRouteKey(normalizeStreetForKey("Route 100"))).toBe("route 100")
	})
})

describe("stripLocalityQualifier (query-side fallback)", () => {
	it("strips an OA locality qualifier to the gazetteer base name", () => {
		expect(stripLocalityQualifier("Kraubath/Mur")).toBe("Kraubath")
		expect(stripLocalityQualifier("St.Kanzian/Klopeiner See")).toBe("St.Kanzian")
		expect(stripLocalityQualifier("Hart b.Graz")).toBe("Hart")
		expect(stripLocalityQualifier("Feistritz o.Bleiburg")).toBe("Feistritz")
		expect(stripLocalityQualifier("Lenk im Simmental")).toBe("Lenk")
		expect(stripLocalityQualifier("Roche VD")).toBe("Roche")
		expect(stripLocalityQualifier("Odense S")).toBe("Odense")
		expect(stripLocalityQualifier("Hurup Thy")).toBe("Hurup")
	})

	it("returns '' when nothing is stripped (no wasted re-probe)", () => {
		expect(stripLocalityQualifier("Paris")).toBe("")
		expect(stripLocalityQualifier("San Francisco")).toBe("")

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
		expect(normalizeStreetForKeyLocale("ul. Świętokrzyska", "pl")).toBe("swietokrzyska")
		expect(normalizeStreetForKeyLocale("ulica Świętokrzyska", "pl")).toBe("swietokrzyska")
		expect(normalizeStreetForKeyLocale("Świętokrzyska", "pl")).toBe("swietokrzyska")
		expect(normalizeStreetForKeyLocale("Marszałkowska", "pl")).toBe("marszalkowska")
		expect(normalizeStreetForKeyLocale("al. Jerozolimskie", "pl")).toBe("jerozolimskie")
		expect(normalizeStreetForKeyLocale("Plac Zamkowy", "pl")).toBe("zamkowy")

		expect(normalizeStreetForKeyLocale("Ulica", "pl")).toBe("ulica")
	})

	it("vn: folds BOTH đ (d-with-stroke) and ð (eth) — OSM mixes the codepoints inside one value", () => {
		expect(normalizeStreetForKeyLocale("Đường Trần Hưng Đạo", "vn")).toBe("duong tran hung dao")

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
		expect(normalizeStreetForKeyLocale("Łuckastraße", "de")).toBe("łuckastrasse")
	})
})

describe("normalizeStreetForKeyLocale — the it branch (ANNCSU rooftop keying)", () => {
	it("it: KEEPS the leading type, where pl drops it", () => {
		// Dropping a recognized type merges 3.941% of Italy's distinct (comune, street)
		// pairs against 0.131% of Poland's.
		// These are two of Italy's.
		expect(normalizeStreetForKeyLocale("Via Bevegni", "it")).toBe("via bevegni")
		expect(normalizeStreetForKeyLocale("Salita Bevegni", "it")).toBe("salita bevegni")

		expect(normalizeStreetForKeyLocale("Via dei Pioppi", "it")).toBe("via dei pioppi")
		expect(normalizeStreetForKeyLocale("Vicolo dei Pioppi", "it")).toBe("vicolo dei pioppi")
	})

	it("it: expands an abbreviated leading type, so a typed query reaches the stored key", () => {
		// ANNCSU writes the type out, so the map serves the query side.
		expect(normalizeStreetForKeyLocale("V.le Roma", "it")).toBe("viale roma")
		expect(normalizeStreetForKeyLocale("VIALE ROMA", "it")).toBe("viale roma")

		expect(normalizeStreetForKeyLocale("P.zza Garibaldi", "it")).toBe("piazza garibaldi")
		expect(normalizeStreetForKeyLocale("Piazza Garibaldi", "it")).toBe("piazza garibaldi")

		expect(normalizeStreetForKeyLocale("Str. Provinciale", "it")).toBe("strada provinciale")
		expect(normalizeStreetForKeyLocale("C.so Vittorio Emanuele", "it")).toBe("corso vittorio emanuele")
	})

	it("it: the three spellings of località reach one key", () => {
		// The register writes all three.
		// The shared fold strips the accent and the apostrophe, so the `it` branch adds no
		// extra normalization here and this test is what catches the fold changing under it.
		expect(normalizeStreetForKeyLocale("LOCALITA' Governatori", "it")).toBe("localita governatori")
		expect(normalizeStreetForKeyLocale("Località Governatori", "it")).toBe("localita governatori")
		expect(normalizeStreetForKeyLocale("Localita Governatori", "it")).toBe("localita governatori")
		expect(normalizeStreetForKeyLocale("Loc. Governatori", "it")).toBe("localita governatori")
	})

	it("it: an elision apostrophe inside a name behaves the same on both sides", () => {
		// The fold drops the apostrophe rather than splitting the token, on the stored key
		// and the query alike, so an elision keeps the two sides meeting.
		expect(normalizeStreetForKeyLocale("Via dell'Argine", "it")).toBe("via dellargine")
		expect(normalizeStreetForKeyLocale("VIA DELL ARGINE", "it")).toBe("via dell argine")
	})

	it("it: a bare name with no type keeps its single token", () => {
		// The expansion reads the first token only when another follows it,
		// so a one-word name matching the map stays a name.
		expect(normalizeStreetForKeyLocale("Lungarno", "it")).toBe("lungarno")
		expect(normalizeStreetForKeyLocale("Str", "it")).toBe("str")
	})
})

describe("the zh branch — the Taiwanese register's Han keys", () => {
	it("keys a street as its Han fold: no whitespace, kanji section numerals as written", () => {
		expect(normalizeStreetForKeyLocale("重慶南路一段", "zh")).toBe("重慶南路一段")
		expect(normalizeStreetForKeyLocale("重慶南路 一段", "zh")).toBe("重慶南路一段")

		expect(normalizeStreetForKeyLocale("中山路２段", "zh")).toBe("中山路2段")
	})

	it("keys 臺 and 台 as one locality: the register writes 臺北市, a query 台北市", () => {
		expect(normalizeLocalityForKeyLocale("臺北市中正區", "zh")).toBe("台北市中正區")
		expect(normalizeLocalityForKeyLocale("台北市 中正區", "zh")).toBe("台北市中正區")

		expect(normalizeLocalityForKey("臺北市")).toBe("臺北市")
		expect(normalizeLocalityForKeyLocale("Paris", "fr")).toBe("paris")
	})

	it("keys the number without the register's 號 and without full width", () => {
		expect(normalizeHouseNumberForKey("１２２號", "zh")).toBe("122")
		expect(normalizeHouseNumberForKey("122號", "zh")).toBe("122")
		expect(normalizeHouseNumberForKey("122", "zh")).toBe("122")
		expect(normalizeHouseNumberForKey("14之12號", "zh")).toBe("14之12")
		expect(normalizeHouseNumberForKey("14號之12", "zh")).toBe("14之12")
		expect(normalizeHouseNumberForKey("３０號之１９", "zh")).toBe("30之19")
		expect(normalizeHouseNumberForKey("30附40號", "zh")).toBe("30附40")
		expect(normalizeHouseNumberForKey("30號附40", "zh")).toBe("30附40")
		expect(normalizeHouseNumberForKey("５５之２３附１號", "zh")).toBe("55之23附1")

		expect(normalizeHouseNumberForKey(" 12A ", "us")).toBe("12a")
		expect(normalizeHouseNumberForKey("3 a", "fr")).toBe("3 a")
	})
})
