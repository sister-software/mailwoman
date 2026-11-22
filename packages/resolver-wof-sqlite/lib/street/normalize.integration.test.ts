// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import {
	canonicalizeRouteKey,
	normalizeHouseNumberForKey,
	normalizeLocalityForKey,
	normalizeLocalityForKeyLocale,
	normalizeStreetForKey,
	normalizeStreetForKeyLocale,
	parseStreetLocale,
	streetKeyVariants,
	streetLocaleForSurface,
	stripLocalityQualifier,
} from "#street"

const LOCALE = {
	us: parseStreetLocale("us"),
	en: parseStreetLocale("en"),
	es: parseStreetLocale("es"),
	fr: parseStreetLocale("fr"),
	de: parseStreetLocale("de"),
	it: parseStreetLocale("it"),
	nl: parseStreetLocale("nl"),
	pl: parseStreetLocale("pl"),
	vn: parseStreetLocale("vn"),
	id: parseStreetLocale("id"),
	zh: parseStreetLocale("zh"),
	und: parseStreetLocale("und"),
}

/**
 * The keys a reader of a United States database probes for a street.
 */
const usVariants = (street: string) => streetKeyVariants(street, LOCALE.us)

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

describe("streetKeyVariants on a county road", () => {
	const SPELLINGS = (route: string) =>
		["county road", "county highway", "county", "cth", "co road", "cr"].map((d) => `${d} ${route}`)

	it("probes every stored spelling of a lettered or numbered county road", () => {
		for (const written of ["County Rd CW", "County Road CW", "CTH CW", "County Hwy CW", "Cty Rd CW", "Co Rd CW"]) {
			expect(usVariants(written)).toEqual(expect.arrayContaining(SPELLINGS("cw")))
		}

		for (const written of ["CR 240", "CR-240", "County Road 240", "Co Rd 240"]) {
			expect(usVariants(written)).toEqual(expect.arrayContaining(SPELLINGS("240")))
		}
	})

	it("leaves a county-named street and a bare Colorado route alone", () => {
		expect(usVariants("County Line Rd")).toEqual(["county line road"])
		expect(usVariants("CO-5")).toContain("state highway 5")
		expect(usVariants("CO-5")).not.toContain("county road 5")
	})
})

describe("streetKeyVariants", () => {
	it("keeps a plain name single-variant", () => {
		expect(usVariants("East 13 Mile Road")).toEqual(["east 13 mile road"])
		expect(usVariants("Main St")).toEqual(["main street"])
	})

	it("collapses the doubled-type tail and canonicalizes what remains", () => {
		expect(usVariants("Saint Pauls PL St")).toEqual([
			"saint pauls pl street",
			"saint pauls place",
			"st pauls pl street",
			"st pauls place",
		])
	})

	it("swaps a leading saint↔st in both directions", () => {
		expect(usVariants("Saint Pauls Pl")).toEqual(["saint pauls place", "st pauls place"])
		expect(usVariants("St Pauls Pl")).toEqual(["st pauls place", "saint pauls place"])
	})

	it("probes a numbered street with and without its ordinal suffix", () => {
		expect(usVariants("48th St")).toEqual(["48th street", "48 street"])
		expect(usVariants("48 St")).toEqual(["48 street", "48th street"])
		expect(usVariants("West 11 Street")).toEqual(["west 11 street", "west 11th street"])

		const route = usVariants("US Route 9")

		expect(route[0]).toBe("us route 9")
		expect(route).not.toContain("us route 9th")
		expect(route).toContain("east united states highway 9")
	})

	it("never touches a street genuinely named with a type word", () => {
		expect(usVariants("Street Road")).toEqual(["street road"])
		expect(usVariants("Broadway")).toEqual(["broadway"])
	})

	it("stays single-variant for non-US locales", () => {
		expect(streetKeyVariants("Rue Saint Honoré", LOCALE.fr)).toHaveLength(1)
	})
})

describe("streetLocaleForSurface (the Québec surface router)", () => {
	it("routes a French-lead surface to fr under an en base — the CA bilingual case", () => {
		expect(streetLocaleForSurface("boul Saint-Laurent", LOCALE.en)).toBe("fr")
		expect(streetLocaleForSurface("Rue Gabrielle-Roy", LOCALE.en)).toBe("fr")
		expect(streetLocaleForSurface("Allée des Becs-Scie", LOCALE.en)).toBe("fr")
		expect(streetLocaleForSurface("Ch. de la Côte-des-Neiges", LOCALE.en)).toBe("fr")
	})

	it("keeps English surfaces on en — trailing types and digit-lead never match", () => {
		expect(streetLocaleForSurface("Laurell Road", LOCALE.en)).toBe("en")
		expect(streetLocaleForSurface("Fifth Avenue", LOCALE.en)).toBe("en")
		expect(streetLocaleForSurface("Grosvenor Place", LOCALE.en)).toBe("en")
		expect(streetLocaleForSurface("1 Avenue NE", LOCALE.en)).toBe("en")

		expect(streetLocaleForSurface("Main St", LOCALE.en)).toBe("en")
	})

	it("only an en base re-routes — fr/de/nl extracts already speak their own rules, us stays untouched", () => {
		expect(streetLocaleForSurface("Rue de Rivoli", LOCALE.fr)).toBe("fr")
		expect(streetLocaleForSurface("Rue Quelconque", LOCALE.de)).toBe("de")
		expect(streetLocaleForSurface("Rue Something", LOCALE.us)).toBe("us")
	})

	it("routing composes with the fold: both ends of the CA abbreviation-variance class key identically", () => {
		const build = normalizeStreetForKeyLocale(
			"Boulevard Saint-Laurent",
			streetLocaleForSurface("Boulevard Saint-Laurent", LOCALE.en)
		)

		const query = normalizeStreetForKeyLocale("boul St-Laurent", streetLocaleForSurface("boul St-Laurent", LOCALE.en))

		expect(build).toBe("boulevard saint laurent")
		expect(query).toBe(build)
	})
})

describe("normalizeStreetForKeyLocale — the pl/vn/id branches (the 2026-08-19 coverage lane)", () => {
	it("pl: folds ł (the non-decomposing letter) and STRIPS the leading type — OSM Poland tags streets bare", () => {
		expect(normalizeStreetForKeyLocale("ul. Świętokrzyska", LOCALE.pl)).toBe("swietokrzyska")
		expect(normalizeStreetForKeyLocale("ulica Świętokrzyska", LOCALE.pl)).toBe("swietokrzyska")
		expect(normalizeStreetForKeyLocale("Świętokrzyska", LOCALE.pl)).toBe("swietokrzyska")
		expect(normalizeStreetForKeyLocale("Marszałkowska", LOCALE.pl)).toBe("marszalkowska")
		expect(normalizeStreetForKeyLocale("al. Jerozolimskie", LOCALE.pl)).toBe("jerozolimskie")
		expect(normalizeStreetForKeyLocale("Plac Zamkowy", LOCALE.pl)).toBe("zamkowy")

		expect(normalizeStreetForKeyLocale("Ulica", LOCALE.pl)).toBe("ulica")
	})

	it("vn: folds BOTH đ (d-with-stroke) and ð (eth) — OSM mixes the codepoints inside one value", () => {
		expect(normalizeStreetForKeyLocale("Đường Trần Hưng Đạo", LOCALE.vn)).toBe("duong tran hung dao")

		expect(normalizeStreetForKeyLocale("\u0110ường Trần Hưng \u00D0ạo", LOCALE.vn)).toBe("duong tran hung dao")
		expect(normalizeStreetForKeyLocale("Duong Tran Hung Dao", LOCALE.vn)).toBe("duong tran hung dao")
		expect(normalizeStreetForKeyLocale("Phố Huế", LOCALE.vn)).toBe("pho hue")
	})

	it("id: expands the jalan/gang abbreviations", () => {
		expect(normalizeStreetForKeyLocale("Jl. Thamrin", LOCALE.id)).toBe("jalan thamrin")
		expect(normalizeStreetForKeyLocale("Jalan Thamrin", LOCALE.id)).toBe("jalan thamrin")
		expect(normalizeStreetForKeyLocale("Gg. Waru", LOCALE.id)).toBe("gang waru")
	})

	it("the letter maps stay OUT of the other locales — built extracts keep their keys", () => {
		expect(normalizeStreetForKeyLocale("Łuckastraße", LOCALE.de)).toBe("łuckastrasse")
	})
})

describe("normalizeStreetForKeyLocale — the es branch (Spanish rooftop keying)", () => {
	it("es: KEEPS the leading type, which Spain needs more than Italy does", () => {
		// The removal of a recognized type merges 7.977% of Spain's distinct (municipio, street)
		// pairs against Italy's 3.941%, and `Calle Mayor` with `Plaza Mayor` is why.
		expect(normalizeStreetForKeyLocale("Calle Mayor", LOCALE.es)).toBe("calle mayor")
		expect(normalizeStreetForKeyLocale("Plaza Mayor", LOCALE.es)).toBe("plaza mayor")
		expect(normalizeStreetForKeyLocale("Avenida Mayor", LOCALE.es)).toBe("avenida mayor")
	})

	it("es: expands only the abbreviations that mean one token in every language the register writes", () => {
		expect(normalizeStreetForKeyLocale("Ctra. de Burgos", LOCALE.es)).toBe("carretera de burgos")
		expect(normalizeStreetForKeyLocale("CARRETERA DE BURGOS", LOCALE.es)).toBe("carretera de burgos")
		expect(normalizeStreetForKeyLocale("Rbla. de Catalunya", LOCALE.es)).toBe("rambla de catalunya")
	})

	it("es: leaves c/, av and pl unexpanded, since each names two stored tokens", () => {
		// The register includes `calle` beside `carrer`, `avenida` beside `avinguda`,
		// and `plaza` beside `plaça`.
		// A broader key would point a query to the wrong token in the other region,
		// so an abbreviation misses instead.
		// `streetKeyVariants` is where a street name with several keys belongs.
		expect(normalizeStreetForKeyLocale("C/ Mayor", LOCALE.es)).toBe("c/ mayor")
		expect(normalizeStreetForKeyLocale("Av. Diagonal", LOCALE.es)).toBe("av diagonal")

		expect(normalizeStreetForKeyLocale("Carrer Mayor", LOCALE.es)).toBe("carrer mayor")
		expect(normalizeStreetForKeyLocale("Avinguda Diagonal", LOCALE.es)).toBe("avinguda diagonal")
	})

	it("es: the cedilla and the comma the register writes both fold away", () => {
		// `plaça` on 39,585 rows and a trailing comma on `aldea,` are both in the register.
		expect(normalizeStreetForKeyLocale("Plaça de Catalunya", LOCALE.es)).toBe("placa de catalunya")
		expect(normalizeStreetForKeyLocale("Aldea, Sograndio", LOCALE.es)).toBe("aldea sograndio")
	})
})

describe("normalizeStreetForKeyLocale — the it branch (ANNCSU rooftop keying)", () => {
	it("it: KEEPS the leading type, where pl drops it", () => {
		// The removal of a recognized type merges 3.941% of Italy's distinct
		// (comune, street) pairs against 0.131% of Poland's.
		// These are two of Italy's.
		expect(normalizeStreetForKeyLocale("Via Bevegni", LOCALE.it)).toBe("via bevegni")
		expect(normalizeStreetForKeyLocale("Salita Bevegni", LOCALE.it)).toBe("salita bevegni")

		expect(normalizeStreetForKeyLocale("Via dei Pioppi", LOCALE.it)).toBe("via dei pioppi")
		expect(normalizeStreetForKeyLocale("Vicolo dei Pioppi", LOCALE.it)).toBe("vicolo dei pioppi")
	})

	it("it: expands an abbreviated leading type, so a typed query reaches the stored key", () => {
		// ANNCSU writes the type out, so the map serves the query side.
		expect(normalizeStreetForKeyLocale("V.le Roma", LOCALE.it)).toBe("viale roma")
		expect(normalizeStreetForKeyLocale("VIALE ROMA", LOCALE.it)).toBe("viale roma")

		expect(normalizeStreetForKeyLocale("P.zza Garibaldi", LOCALE.it)).toBe("piazza garibaldi")
		expect(normalizeStreetForKeyLocale("Piazza Garibaldi", LOCALE.it)).toBe("piazza garibaldi")

		expect(normalizeStreetForKeyLocale("Str. Provinciale", LOCALE.it)).toBe("strada provinciale")
		expect(normalizeStreetForKeyLocale("C.so Vittorio Emanuele", LOCALE.it)).toBe("corso vittorio emanuele")
	})

	it("it: the three spellings of località reach one key", () => {
		// The register writes all three.
		// The shared fold strips the accent and the apostrophe, so the `it` branch adds no
		// extra normalization here and this test is what catches the fold changing under it.
		expect(normalizeStreetForKeyLocale("LOCALITA' Governatori", LOCALE.it)).toBe("localita governatori")
		expect(normalizeStreetForKeyLocale("Località Governatori", LOCALE.it)).toBe("localita governatori")
		expect(normalizeStreetForKeyLocale("Localita Governatori", LOCALE.it)).toBe("localita governatori")
		expect(normalizeStreetForKeyLocale("Loc. Governatori", LOCALE.it)).toBe("localita governatori")
	})

	it("it: an elision apostrophe inside a name behaves the same on both sides", () => {
		// The fold drops the apostrophe rather than splitting the token, on the stored key
		// and the query alike, so an elision keeps the two sides meeting.
		expect(normalizeStreetForKeyLocale("Via dell'Argine", LOCALE.it)).toBe("via dellargine")
		expect(normalizeStreetForKeyLocale("VIA DELL ARGINE", LOCALE.it)).toBe("via dell argine")
	})

	it("it: a bare name with no type keeps its single token", () => {
		// The expansion reads the first token only when another follows it,
		// so a one-word name matching the map stays a name.
		expect(normalizeStreetForKeyLocale("Lungarno", LOCALE.it)).toBe("lungarno")
		expect(normalizeStreetForKeyLocale("Str", LOCALE.it)).toBe("str")
	})
})

describe("the zh branch — the Taiwanese register's Han keys", () => {
	it("keys a street as its Han fold: no whitespace, kanji section numerals as written", () => {
		expect(normalizeStreetForKeyLocale("重慶南路一段", LOCALE.zh)).toBe("重慶南路一段")
		expect(normalizeStreetForKeyLocale("重慶南路 一段", LOCALE.zh)).toBe("重慶南路一段")

		expect(normalizeStreetForKeyLocale("中山路２段", LOCALE.zh)).toBe("中山路2段")
	})

	it("keys 臺 and 台 as one locality: the register writes 臺北市, a query 台北市", () => {
		expect(normalizeLocalityForKeyLocale("臺北市中正區", LOCALE.zh)).toBe("台北市中正區")
		expect(normalizeLocalityForKeyLocale("台北市 中正區", LOCALE.zh)).toBe("台北市中正區")

		expect(normalizeLocalityForKey("臺北市")).toBe("臺北市")
		expect(normalizeLocalityForKeyLocale("Paris", LOCALE.fr)).toBe("paris")
	})

	it("keys the number without the register's 號 and without full width", () => {
		expect(normalizeHouseNumberForKey("１２２號", LOCALE.zh)).toBe("122")
		expect(normalizeHouseNumberForKey("122號", LOCALE.zh)).toBe("122")
		expect(normalizeHouseNumberForKey("122", LOCALE.zh)).toBe("122")
		expect(normalizeHouseNumberForKey("14之12號", LOCALE.zh)).toBe("14之12")
		expect(normalizeHouseNumberForKey("14號之12", LOCALE.zh)).toBe("14之12")
		expect(normalizeHouseNumberForKey("３０號之１９", LOCALE.zh)).toBe("30之19")
		expect(normalizeHouseNumberForKey("30附40號", LOCALE.zh)).toBe("30附40")
		expect(normalizeHouseNumberForKey("30號附40", LOCALE.zh)).toBe("30附40")
		expect(normalizeHouseNumberForKey("５５之２３附１號", LOCALE.zh)).toBe("55之23附1")

		expect(normalizeHouseNumberForKey(" 12A ", LOCALE.us)).toBe("12a")
		expect(normalizeHouseNumberForKey("3 a", LOCALE.fr)).toBe("3 a")
	})
})
