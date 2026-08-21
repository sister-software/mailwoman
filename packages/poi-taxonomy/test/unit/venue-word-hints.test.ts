/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The venue-word hint table's integrity gate. The table is mined, so the committed artifact — not
 *   the generator — is what ships; these tests hold the committed rows to the bars the provenance
 *   block declares, and pin the exclusion families the composed measure exists to kill. A regenerate
 *   that widens a bar or leaks a toponym fails here, not in a consumer.
 */

import { readPackagedTable } from "@mailwoman/poi-taxonomy/packaged-data"
import { venueWordHint, venueWordHintCount, venueWordHintProvenance } from "@mailwoman/poi-taxonomy/venue-word-hints"
import type { VenueWordHintTable } from "@mailwoman/poi-taxonomy/venue-word-hints"
import { describe, expect, it } from "vitest"

const TABLE = readPackagedTable<VenueWordHintTable>("venue-word-hints.json")

describe("venue-word-hints table integrity", () => {
	it("every committed row honors the provenance block's own bars", () => {
		const { bars } = TABLE.provenance
		const violations: string[] = []

		for (const [token, hint] of Object.entries(TABLE.hints)) {
			if (hint.venueRatio < bars.venueRatioMin) {
				violations.push(`${token}: venueRatio ${hint.venueRatio}`)
			}

			if (hint.poiFreq < bars.poiFreqMin) {
				violations.push(`${token}: poiFreq ${hint.poiFreq}`)
			}

			if (hint.topClassShare < bars.topClassShareMin) {
				violations.push(`${token}: topClassShare ${hint.topClassShare}`)
			}

			if (hint.placeRatePPM > bars.placeRatePPMMax) {
				violations.push(`${token}: placeRatePPM ${hint.placeRatePPM}`)
			}

			if (hint.topClass === "other") {
				violations.push(`${token}: topClass "other"`)
			}
		}

		expect(violations).toEqual([])
	})

	it("the toponym family the composed measure exists to kill stays out", () => {
		// Venue-frequency alone admits famous place names (the f6 saturation finding: 'paris' out-ratios
		// 'comer'); the place-rate suppressor is what keeps them out. The street-fork family is the
		// falsifier's named false positives.
		for (const toponym of ["paris", "mexico", "augusta", "catherine", "savile", "alvear", "paulista"]) {
			expect(venueWordHint(toponym), toponym).toBeNull()
		}
	})

	it("class-decisive venue words carry their class", () => {
		expect(venueWordHint("cemetery")?.topClass).toBe("civic")
		expect(venueWordHint("kfc")?.topClass).toBe("food")
		expect(venueWordHint("teppanyaki")?.topClass).toBe("food")
	})

	it("lookup is case-insensitive and misses are null, never a throw", () => {
		expect(venueWordHint("KFC")).toEqual(venueWordHint("kfc"))
		expect(venueWordHint("zzzz-not-a-token")).toBeNull()
		expect(venueWordHint("")).toBeNull()
	})

	it("the table is the size the survey measured, within regeneration drift", () => {
		// 2,249 at the committed bars. A regenerate against a NEW survey artifact may move this — move
		// the pin with the provenance sourceMD5, deliberately.
		expect(venueWordHintCount()).toBe(2249)
		expect(venueWordHintProvenance().sourceMD5).toBe("a2ae6f4b29ee0ee45870273487d86e79")
	})
})
