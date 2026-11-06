// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { isGLBLandmark, landmarkBounds, landmarkCovering, type Landmark } from "#landmarks"
import { publishProblems, STRUCTURE_SOURCE_REGISTER } from "#register"

import landmarks from "../data/landmarks.json" with { type: "json" }

const LANDMARKS = landmarks as Landmark[]

describe("data/landmarks.json", () => {
	it("gives each landmark a unique lowercase hyphenated id", () => {
		const ids = LANDMARKS.map(({ id }) => id)

		expect(new Set(ids).size).toBe(ids.length)

		for (const id of ids) {
			expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		}
	})

	it("states each landmark's Wikidata item and OSM element", () => {
		for (const { wikidata, osm } of LANDMARKS) {
			expect(wikidata).toMatch(/^Q\d+$/)
			expect(osm).toMatch(/^(?:node|way|relation)\/\d+$/)
		}
	})

	it("publishes each converted model under a register source whose decision permits publishing", () => {
		for (const landmark of LANDMARKS.filter(isGLBLandmark)) {
			const source = STRUCTURE_SOURCE_REGISTER.sources.find(({ sourceID }) => sourceID === landmark.model.source)

			expect(source, landmark.id).toBeDefined()
			expect(publishProblems(source!), landmark.id).toEqual([])
			expect(landmark.model.path).toBe(`landmarks/${landmark.id}.glb`)
		}
	})
})

describe("landmarkCovering", () => {
	const eiffel = LANDMARKS.find(({ id }) => id === "eiffel-tower")!

	it("covers a point inside the suppression radius and leaves one outside it", () => {
		const degrees = eiffel.suppressRadius / 110_540

		expect(landmarkCovering(LANDMARKS, eiffel.anchor[0], eiffel.anchor[1] + degrees * 0.9)?.id).toBe("eiffel-tower")
		expect(landmarkCovering(LANDMARKS, eiffel.anchor[0], eiffel.anchor[1] + degrees * 1.1)).toBeNull()
	})

	it("encloses the suppression circle in landmarkBounds", () => {
		const [west, south, east, north] = landmarkBounds(eiffel)

		expect(landmarkCovering(LANDMARKS, west + 1e-7, eiffel.anchor[1])?.id).toBe("eiffel-tower")
		expect(landmarkCovering(LANDMARKS, west - 1e-6, eiffel.anchor[1])).toBeNull()
		expect(landmarkCovering(LANDMARKS, eiffel.anchor[0], north - 1e-7)?.id).toBe("eiffel-tower")
		expect(east - eiffel.anchor[0]).toBeCloseTo(eiffel.anchor[0] - west, 12)
		expect(north - eiffel.anchor[1]).toBeCloseTo(eiffel.anchor[1] - south, 12)
	})

	it("shortens a degree of longitude by the cosine of the latitude", () => {
		// A degree of longitude at 48.86 degrees north is about 0.66 of a degree of latitude,
		// so the same offset in degrees that reaches past the radius northward stays inside it eastward.
		const degrees = (eiffel.suppressRadius / 110_540) * 1.2

		expect(landmarkCovering(LANDMARKS, eiffel.anchor[0], eiffel.anchor[1] + degrees)).toBeNull()
		expect(landmarkCovering(LANDMARKS, eiffel.anchor[0] + degrees, eiffel.anchor[1])?.id).toBe("eiffel-tower")
	})
})
