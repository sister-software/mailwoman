/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	GEONAMES_ID_BASE,
	GEONAMES_POSTAL_ID_BASE,
	OVERTURE_ID_BASE,
} from "@mailwoman/core/resolver/synthetic-id-ranges"
import { placeIDProvenance, PlaceIDSource, syntheticIDNote } from "@mailwoman/dev-mcp/place-id-provenance"
import { describe, expect, it } from "vitest"

describe("placeIDProvenance", () => {
	it("classifies a real WOF id and links it", () => {
		const provenance = placeIDProvenance(890_463_199)

		expect(provenance.id_source).toBe(PlaceIDSource.WOF)
		expect(provenance.wof_id).toBe(890_463_199)
		expect(provenance.wof_url).toBe(`https://spelunker.whosonfirst.org/id/${890_463_199}`)
	})

	it("classifies the Overture-minted ids that LOOK like WOF ids", () => {
		// Turkey has no WOF repo, so both ids come from the Overture divisions backfill and neither resolves on spelunker.
		for (const id of [8_114_738_869_649, 8_837_168_432_019]) {
			const provenance = placeIDProvenance(id)

			expect(provenance.id_source).toBe(PlaceIDSource.Overture)
			expect(provenance.wof_id).toBeNull()
			expect(provenance.wof_url).toBeNull()
		}
	})

	it("separates the two GeoNames folds, which reserve different spans", () => {
		expect(placeIDProvenance(GEONAMES_ID_BASE).id_source).toBe(PlaceIDSource.GeoNames)
		expect(placeIDProvenance(GEONAMES_POSTAL_ID_BASE).id_source).toBe(PlaceIDSource.GeoNamesPostal)
	})

	it("puts each boundary in the band that starts at it, with no gap", () => {
		// A ladder written with the wrong comparison misclassifies exactly these boundary ids,
		// which is why they are asserted rather than sampled.
		expect(placeIDProvenance(OVERTURE_ID_BASE).id_source).toBe(PlaceIDSource.Overture)
		expect(placeIDProvenance(OVERTURE_ID_BASE - 1).id_source).toBe(PlaceIDSource.WOF)
		expect(placeIDProvenance(GEONAMES_ID_BASE - 1).id_source).toBe(PlaceIDSource.Overture)
		expect(placeIDProvenance(GEONAMES_POSTAL_ID_BASE - 1).id_source).toBe(PlaceIDSource.GeoNames)
	})

	it("keeps the bases ascending, since the ladder assumes it", () => {
		expect(OVERTURE_ID_BASE).toBeLessThan(GEONAMES_ID_BASE)
		expect(GEONAMES_ID_BASE).toBeLessThan(GEONAMES_POSTAL_ID_BASE)
	})
})

describe("syntheticIDNote", () => {
	it("is absent when every id is a real WOF id", () => {
		expect(syntheticIDNote([890_463_199, 101_750_505])).toBeUndefined()
	})

	it("names the counts per fold on a mixed set", () => {
		const note = syntheticIDNote([890_463_199, 8_114_738_869_649, 8_837_168_432_019, GEONAMES_ID_BASE])

		expect(note).toContain("2 overture")
		expect(note).toContain("1 geonames")
		expect(note).toContain("spelunker")
	})

	it("is absent for an empty set rather than claiming a clean one", () => {
		expect(syntheticIDNote([])).toBeUndefined()
	})
})
