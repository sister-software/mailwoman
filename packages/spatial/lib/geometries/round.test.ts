// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { roundCoordinate, roundGeometryCoordinates } from "#geometries/round"

describe("roundCoordinate", () => {
	it("rounds to the given places and moves a value by at most half a step", () => {
		expect(roundCoordinate(38.44869712345678, 6)).toBe(38.448697)
		expect(Math.abs(roundCoordinate(1.0000005, 6) - 1.0000005)).toBeLessThanOrEqual(5e-7 + 1e-12)
	})

	it("writes negative zero as zero", () => {
		expect(Object.is(roundCoordinate(-0.0000001, 6), 0)).toBe(true)
	})
})

describe("roundGeometryCoordinates", () => {
	it("rounds every position of a multipolygon and keeps the nesting", () => {
		const coordinates = [
			[
				[
					[0.12345678, 1.23456789],
					[2.5, 3.5],
					[0.12345678, 1.23456789],
				],
			],
		]

		expect(roundGeometryCoordinates(coordinates, 6)).toEqual({
			coordinates: [
				[
					[
						[0.123457, 1.234568],
						[2.5, 3.5],
						[0.123457, 1.234568],
					],
				],
			],
			collapsed: false,
		})
	})

	it("reports neighbors that rounding made equal", () => {
		const ring = [
			[0, 0],
			[1.0000001, 1],
			[1.0000002, 1],
			[0, 0],
		]

		expect(roundGeometryCoordinates([ring], 6).collapsed).toBe(true)
	})

	it("does not report neighbors that were already equal", () => {
		expect(
			roundGeometryCoordinates(
				[
					[0, 0],
					[0, 0],
					[1, 1],
				],
				6
			).collapsed
		).toBe(false)
	})

	it("rounds a point", () => {
		expect(roundGeometryCoordinates([-90.18399100000001, 38.4], 6).coordinates).toEqual([-90.183991, 38.4])
	})
})
