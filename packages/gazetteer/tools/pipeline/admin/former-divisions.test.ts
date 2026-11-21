// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The former-division linking rule: only containment evidence links a division, a code a current
 *   division still holds links no place, and a WOF record's placetype decides the tag over the GeoNames level.
 */

import { describe, expect, it } from "vitest"

import {
	AdminCodeState,
	adminCodeStates,
	buildFormerDivisions,
	type CeasedWOFDivision,
	type GeonamesHistoricalDivision,
} from "#tools/pipeline/admin/former-divisions"

function historical(
	geonamesID: number,
	name: string,
	featureCode: string,
	codes: string[]
): GeonamesHistoricalDivision {
	return {
		geonamesID,
		name,
		asciiName: name,
		featureCode,
		level: Number(featureCode.slice(3, 4)),
		country: "GB",
		codes,
		latitude: 51,
		longitude: -2,
	}
}

// Avon sits at ADM1H with England's code.
// A current ADM1 still holds that code.
const AVON = historical(2_656_749, "Avon", "ADM1H", ["ENG", "", "", ""])
// A district whose code no current ADM2 holds, as Northern Ireland's old districts are.
const STRABANE = historical(2_636_745, "Strabane District", "ADM2H", ["NIR", "T4", "", ""])

const CURRENT = [
	{ geonamesID: 6_269_131, level: 1, codes: ["ENG", "", "", ""] },
	{ geonamesID: 2_641_364, level: 1, codes: ["NIR", "", "", ""] },
	{ geonamesID: 3_333_134, level: 2, codes: ["ENG", "B7", "", ""] },
]

const AVON_WOF: CeasedWOFDivision = {
	id: 9_895_008_294,
	name: "Avon",
	names: ["Avon"],
	placetype: "county",
	country: "GB",
	geonamesID: 2_656_749,
	supersededBy: [1_360_698_747, 1_360_698_775],
	latitude: 51.43333,
	longitude: -2.5,
}

describe("adminCodeStates", () => {
	it("reads a code a current division holds as shared and an unheld one as retired", () => {
		const states = adminCodeStates([AVON, STRABANE], CURRENT)

		expect(states.get(AVON.geonamesID)?.state).toBe(AdminCodeState.Shared)
		expect(states.get(STRABANE.geonamesID)).toEqual({ state: AdminCodeState.Retired, path: "NIR|T4" })
	})

	it("reads a code two historical divisions hold as ambiguous", () => {
		// GeoNames writes the placeholder `00` on every historical county of New Zealand.
		const akaroa = { ...historical(1, "Akaroa County", "ADM1H", ["00", "", "", ""]), country: "NZ" }
		const amuri = { ...historical(2, "Amuri County", "ADM1H", ["00", "", "", ""]), country: "NZ" }
		const states = adminCodeStates([akaroa, amuri], [])

		expect(states.get(1)?.state).toBe(AdminCodeState.Ambiguous)
		expect(states.get(2)?.state).toBe(AdminCodeState.Ambiguous)
	})
})

describe("buildFormerDivisions", () => {
	const { divisions, census } = buildFormerDivisions({
		geonames: new Map([["GB", { historical: [AVON, STRABANE], current: CURRENT }]]),
		// Two current places still hold Strabane's code in their admin2 column.
		rowsCarryingCodes: new Map([["GB", new Map([["2:NIR|T4", [2_636_746, 2_636_747]]])]]),
		hierarchyChildren: new Map(),
		wofPlaces: new Map([
			[6_269_131, [{ id: 404_227_469, placetype: "macroregion", country: "GB" }]],
			[2_641_364, [{ id: 404_227_471, placetype: "macroregion", country: "GB" }]],
			[3_333_134, [{ id: 1_360_698_747, placetype: "county", country: "GB" }]],
			[2_636_746, [{ id: 101_869_979, placetype: "locality", country: "GB" }]],
			[2_636_747, []],
		]),
		ceased: [AVON_WOF],
		isCurrentWOF: (id) => id !== 1_360_698_775,
	})

	const avon = divisions.find((d) => d.name === "Avon")
	const strabane = divisions.find((d) => d.name === "Strabane District")

	it("links Avon by its WOF successors only, to the current ones, and tags it by its WOF placetype", () => {
		expect(avon?.links).toEqual([{ evidence: "wof_supersession", wofIDs: [1_360_698_747] }])
		expect(avon?.tag).toBe("subregion")
		expect(avon?.wofID).toBe(9_895_008_294)
	})

	it("links a retired code to the current places that carry it, tagged by the level's WOF placetype", () => {
		expect(strabane?.links).toEqual([{ evidence: "geonames_admin_codes", wofIDs: [101_869_979] }])
		expect(strabane?.tag).toBe("subregion")
	})

	it("counts both in the census", () => {
		expect(census).toHaveLength(1)
		expect(census[0]).toMatchObject({ country: "GB", wofCeased: 1, joined: 1, linkedAny: 2 })
	})
})
