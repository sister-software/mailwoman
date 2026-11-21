// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { isOrtsteilStreet, ortsteilStreetComponents, ortsteilSurface } from "#de/recipes/ortsteil"

describe("streetless hamlets", () => {
	it("reads a street that spells one of its locality's Ortsteile as a hamlet, under either WOF fold", () => {
		expect(isOrtsteilStreet("Loga", ["Holschdubrau", "Loga"])).toBe(true)
		expect(isOrtsteilStreet("Göda", ["Goeda"])).toBe(true)
		expect(isOrtsteilStreet("Hauptstraße", ["Loga"])).toBe(false)
		expect(isOrtsteilStreet("Loga", undefined)).toBe(false)
	})

	it("keeps the hamlet as the street when a house number follows it", () => {
		const components = { street: "Kotten", house_number: "5", postcode: "02997", locality: "Wittichenau" }

		expect(ortsteilStreetComponents(components)).toEqual(components)
	})

	it("tags a numberless hamlet dependent_locality beside its municipality", () => {
		expect(ortsteilStreetComponents({ street: "Kotten", postcode: "02997", locality: "Wittichenau" })).toEqual({
			dependent_locality: "Kotten",
			postcode: "02997",
			locality: "Wittichenau",
		})
	})
})

describe("ortsteilSurface", () => {
	it("takes the German name whose fold equals the ASCII spr label, not a co-located feature's", () => {
		expect(
			ortsteilSurface("Bocklemuend", ["Jüdischer Friedhof Bocklemünd", "Bocklemünd", "Menara-Garten"], "Köln")
		).toBe("Bocklemünd")

		expect(ortsteilSurface("Buerrig", ["Wasserturm Leverkusen-Bürrig", "Bürrig"], "Leverkusen")).toBe("Bürrig")
	})

	it("matches WOF's other fold too — the plain diacritic strip", () => {
		expect(ortsteilSurface("Schoneberg", ["Schöneberg"], "Berlin")).toBe("Schöneberg")
		expect(ortsteilSurface("Schoenberg", ["Schönberg"], "Bad Brambach")).toBe("Schönberg")
	})

	it("keeps the spr label when no German name folds to it", () => {
		expect(ortsteilSurface("Beuel", ["Beuel"], "Bonn")).toBe("Beuel")
		expect(ortsteilSurface("Aue", [], "Wuppertal")).toBe("Aue")
	})

	it("drops a leading <city>- prefix, which no envelope carries once the city is its own line", () => {
		expect(ortsteilSurface("Köln-Nippes", ["Köln-Nippes"], "Köln")).toBe("Nippes")
		expect(ortsteilSurface("Koeln-Nippes", ["Köln-Nippes"], "Köln")).toBe("Nippes")
	})

	it("keeps a name that is only the prefix", () => {
		expect(ortsteilSurface("Köln-", ["Köln-"], "Köln")).toBe("Köln-")
	})
})
