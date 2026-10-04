/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { BackboneState } from "@mailwoman/corpus/source-register"
import { describe, expect, it } from "vitest"

import {
	type ExposureReport,
	jurisdictionFeatures,
	jurisdictionProperties,
	type JurisdictionInputs,
} from "#tools/coverage/jurisdictions"
import type { NaturalEarthUnit } from "#tools/coverage/natural-earth"

const exposure: ExposureReport = {
	schema: "mailwoman.exposure/v1",
	inputs: {},
	jurisdictions: {
		FR: {
			stages: { realized_draws: { total: 75 } },
			phenomena: {
				"postcode-precedes-locality": { realized_draws: { before: 60, after: 15 } },
				"house-number-precedes-street": { realized_draws: { before: 75 } },
			},
		},
		GF: { stages: { realized_draws: { total: 25 } }, phenomena: {} },
	},
	address_systems: { systems: [{ id: 1, rows: { realized_draws: 100 } }] },
}

const inputs: JurisdictionInputs = {
	exposure,
	jurisdictions: [
		{ iso2: "FR", name: "France", backboneState: BackboneState.Verified },
		{ iso2: "GF", name: "French Guiana", backboneState: BackboneState.VerifiedPartial },
		{ iso2: "AQ", name: "Antarctica", backboneState: BackboneState.Exceptional },
	],
	sources: new Map([["FR", { total: 9, eligible: 3 }]]),
	systems: { $comment: "", systems: [{ id: 1, key: "street locality" }], members: [{ country: "FR", script: "local", system: 1 }] },
	admitted: new Set(["FR"]),
	board: new Map([["FR", { rows: 4, passed: 3 }]]),
}

describe("jurisdictionProperties", () => {
	const properties = jurisdictionProperties(inputs)

	it("reads draws, shares and shape forms from the realized-draws report", () => {
		const france = properties.get("FR")!

		expect(france.draws).toBe(75)
		expect(france.draw_share).toBe(0.75)
		expect(france.shape_forms).toBe(3)
		expect(france["postcode_first_share"]).toBe(0.8)
		expect(france["house_number_first_share"]).toBe(1)
		expect(france["address_system"]).toBe(1)
		expect(france["address_system_draws"]).toBe(100)
		expect(france.admitted).toBe(true)
		expect(france.board_checking_rows).toBe(3)
	})

	it("omits a share it has no rows for, rather than writing a zero", () => {
		const guiana = properties.get("GF")!

		expect(guiana.draws).toBe(25)
		expect("postcode_first_share" in guiana).toBe(false)
		expect("address_system" in guiana).toBe(false)
	})

	it("keeps a register jurisdiction the run never drew from, at zero draws", () => {
		expect(properties.get("AQ")!.draws).toBe(0)
	})
})

describe("jurisdictionFeatures", () => {
	const geometry = { type: "Polygon" as const, coordinates: [] }

	const units: NaturalEarthUnit[] = [
		{ type: "Feature", properties: { ISO_A2: "-99", ISO_A2_EH: "FR", ADM0_A3: "FRA", NAME: "France" }, geometry },
		{ type: "Feature", properties: { ISO_A2: "-99", ISO_A2_EH: "-99", ADM0_A3: "BRT", NAME: "Bir Tawil" }, geometry },
	]

	it("joins each owned unit, counts the unowned ones and lists jurisdictions with no unit", () => {
		const joined = jurisdictionFeatures(units, jurisdictionProperties(inputs))

		expect(joined.features.map((feature) => feature.properties.iso2)).toEqual(["FR"])
		expect(joined.unownedUnits).toEqual(["Bir Tawil"])
		expect(joined.unmappedJurisdictions).toEqual(["AQ", "GF"])
	})
})
