/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1905: the GeoNames-anchored label-point choice. The rule table pins the census's four classes —
 *   the Washington shape (label wrong, geometric point at the settlement), the Chinese
 *   prefecture-city shape (label at the urban seat, centroid far), the anchorless record, and the
 *   agreeing pair — plus the lazy country-file lookup's absence semantics.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import {
	ANCHOR_DECISIVE_RATIO,
	choosePoint,
	createGeoNamesAnchorLookup,
	LABEL_GEOM_DISAGREEMENT_KM,
} from "mailwoman/gazetteer-pipeline/admin/label-point-adjudicator"
import { afterAll, describe, expect, it } from "vitest"

// The real Washington DC record (wof:85931779): geom: downtown, lbl: the district's southern tip,
// GeoNames anchor at the city.
const WASHINGTON_GEOM = { latitude: 38.904831, longitude: -77.016216 }
const WASHINGTON_LBL = { latitude: 38.82652, longitude: -77.01712 }
const WASHINGTON_ANCHOR = { latitude: 38.89511, longitude: -77.03637 }

describe("choosePoint (#1905)", () => {
	it("the Washington shape: a decisively closer geometric point overrides the label", () => {
		const chosen = choosePoint(WASHINGTON_GEOM, WASHINGTON_LBL, WASHINGTON_ANCHOR)

		expect(chosen.choice).toBe("geom-by-anchor")
		expect(chosen.latitude).toBe(WASHINGTON_GEOM.latitude)
		expect(chosen.longitude).toBe(WASHINGTON_GEOM.longitude)
	})

	it("the prefecture-city shape: a label at the urban seat survives a far centroid", () => {
		// Modeled on Tongliao, CN: the label sits at the seat beside the anchor, the centroid ~55 km out.
		const geom = { latitude: 43.9, longitude: 122.5 }
		const lbl = { latitude: 43.6125, longitude: 122.2653 }
		const anchor = { latitude: 43.6125, longitude: 122.2436 }

		const chosen = choosePoint(geom, lbl, anchor)

		expect(chosen.choice).toBe("lbl-by-anchor")
		expect(chosen.latitude).toBe(lbl.latitude)
	})

	it("no anchor → the label preference, unchanged", () => {
		const chosen = choosePoint(WASHINGTON_GEOM, WASHINGTON_LBL, undefined)

		expect(chosen.choice).toBe("lbl")
		expect(chosen.latitude).toBe(WASHINGTON_LBL.latitude)
	})

	it(`agreement within ${LABEL_GEOM_DISAGREEMENT_KM} km never consults the anchor`, () => {
		const geom = { latitude: 48.8566, longitude: 2.3522 }
		const lbl = { latitude: 48.86, longitude: 2.35 }
		// An anchor that would pick geom if consulted — it must not be.
		const chosen = choosePoint(geom, lbl, geom)

		expect(chosen.choice).toBe("lbl")
		expect(chosen.latitude).toBe(lbl.latitude)
	})

	it(`an anchor separating at less than ${ANCHOR_DECISIVE_RATIO}x keeps the label`, () => {
		// Both points ~equidistant from the anchor: no decisive read.
		const geom = { latitude: 50, longitude: 10 }
		const lbl = { latitude: 50, longitude: 10.2 }
		const anchor = { latitude: 50, longitude: 10.1 }

		expect(choosePoint(geom, lbl, anchor).choice).toBe("lbl")
	})
})

const GN_ROOT = await temporaryDirectory("mw-gn-anchor-")

// Two rows in the standard GeoNames country-file layout: id, name, asciiname, alternates, lat, lon, …
await writeLocalTextFile(
	[
		"4140963\tWashington\tWashington\t\t38.89511\t-77.03637\tP\tPPLC\tUS",
		"999\tElsewhere\tElsewhere\t\t10\t20\tP\tPPL\tUS",
	].join("\n"),
	GN_ROOT.resolve("US.txt")
)

afterAll(() => GN_ROOT[Symbol.asyncDispose]())

describe("createGeoNamesAnchorLookup (#1905)", () => {
	it("resolves an id from the country file, tolerating numeric and string ids", async () => {
		const lookup = await createGeoNamesAnchorLookup(GN_ROOT.path)

		expect(await lookup("US", 4_140_963)).toEqual({ latitude: 38.89511, longitude: -77.03637 })
		expect(await lookup("US", "999")).toEqual({ latitude: 10, longitude: 20 })
	})

	it("an unknown id and a missing country file are both ABSENCE, never a zero point", async () => {
		const lookup = await createGeoNamesAnchorLookup(GN_ROOT.path)

		expect(await lookup("US", 123_456_789)).toBeUndefined()
		expect(await lookup("FR", 4_140_963)).toBeUndefined()
		expect(await lookup("", 4_140_963)).toBeUndefined()
	})
})
