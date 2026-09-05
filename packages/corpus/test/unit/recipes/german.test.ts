/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `german` — the Ortsteil surface (#1946). WOF's `spr.name` for a German neighbourhood is the ASCII-folded label,
 *   and the `names` table carries the German spelling beside labels for co-located features; the recipe has to pick the
 *   spelling a German types, and drop the `<city>-` prefix WOF sometimes writes.
 */

import { ortsteilSurface } from "@mailwoman/corpus/recipes/german"
import { describe, expect, it } from "vitest"

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
