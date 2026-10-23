/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { applyChannelPins, type SoftFeatures } from "#soft-features"

const FIRED = {
	features: [
		[1, 0],
		[0, 1],
		[0, 0],
	],
	confidence: [1, 1, 0],
}

function built(): SoftFeatures {
	return {
		anchor: { features: [[0.2], [0], [0]], confidence: [0.2, 0, 0] },
		gazetteer: FIRED,
		country: null,
		streetType: { features: [[1], [0], [0]], confidence: [1, 0, 0] },
		localitySurface: FIRED,
	}
}

describe("applyChannelPins", () => {
	it("returns the channels unchanged when no pin is set", () => {
		const soft = built()

		expect(applyChannelPins(soft, undefined)).toBe(soft)
		expect(applyChannelPins(soft, {})).toBe(soft)
		expect(applyChannelPins(soft, { gazetteer: "production" })).toBe(soft)
	})

	it("feeds zeros of the same shape for a channel pinned off", () => {
		const pinned = applyChannelPins(built(), { locality_surface: "off" })

		expect(pinned.localitySurface).toEqual({
			features: [
				[0, 0],
				[0, 0],
				[0, 0],
			],
			confidence: [0, 0, 0],
		})

		// A zeroed channel is still a fed channel: the reading is silent rather than absent.
		expect(pinned.localitySurface).not.toBeNull()
	})

	it("leaves every other channel as built", () => {
		const soft = built()
		const pinned = applyChannelPins(soft, { street_type: "off" })

		expect(pinned.anchor).toBe(soft.anchor)
		expect(pinned.gazetteer).toBe(soft.gazetteer)
		expect(pinned.country).toBeNull()
		expect(pinned.localitySurface).toBe(soft.localitySurface)
		expect(pinned.streetType?.confidence).toEqual([0, 0, 0])
	})

	it("keeps an unconfigured channel absent rather than inventing a zero channel for it", () => {
		const pinned = applyChannelPins(built(), { country: "off" })

		expect(pinned.country).toBeNull()
	})

	it("pins every channel at once", () => {
		const pinned = applyChannelPins(built(), {
			anchor: "off",
			gazetteer: "off",
			country: "off",
			street_type: "off",
			locality_surface: "off",
		})

		for (const channel of [pinned.anchor, pinned.gazetteer, pinned.streetType, pinned.localitySurface]) {
			expect(channel?.confidence.every((value) => value === 0)).toBe(true)
			expect(channel?.features.every((row) => row.every((value) => value === 0))).toBe(true)
		}
	})
})
