// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { simplifyAreaGeometry } from "#geometries/simplify"

const square: [number, number][] = [
	[0, 0],
	[0.5, 0.0001],
	[1, 0],
	[1, 1],
	[0, 1],
	[0, 0],
]

describe("simplifyAreaGeometry", () => {
	it("drops a position inside the tolerance and keeps the ring closed", () => {
		const out = simplifyAreaGeometry({ type: "Polygon", coordinates: [square] }, 0.01)
		const ring = (out as { coordinates: number[][][] }).coordinates[0]!

		expect(ring).not.toContainEqual([0.5, 0.0001])
		expect(ring[0]).toEqual(ring.at(-1))
		expect(ring.length).toBeGreaterThanOrEqual(4)
	})

	it("keeps a position outside the tolerance", () => {
		const out = simplifyAreaGeometry({ type: "Polygon", coordinates: [square] }, 0.00001)

		expect((out as { coordinates: number[][][] }).coordinates[0]).toContainEqual([0.5, 0.0001])
	})

	it("keeps a small island's outer ring, and drops a small inner ring", () => {
		const island: [number, number][] = [
			[0, 0],
			[0.001, 0],
			[0.001, 0.001],
			[0, 0.001],
			[0.0005, 0.0005],
			[0, 0],
		]

		const out = simplifyAreaGeometry({ type: "Polygon", coordinates: [island, island] }, 1) as {
			coordinates: number[][][]
		}

		expect(out.coordinates).toHaveLength(1)
		expect(out.coordinates[0]!.length).toBeGreaterThanOrEqual(4)
	})

	it("bounds a densely drawn island that the tolerance collapses, and keeps its ring closed", () => {
		const positions = 200_000

		const island = Array.from({ length: positions + 1 }, (_, step): [number, number] => {
			const angle = ((step % positions) / positions) * 2 * Math.PI

			return [0.01 * Math.cos(angle), 0.01 * Math.sin(angle)]
		})

		const out = simplifyAreaGeometry({ type: "Polygon", coordinates: [island] }, 1) as {
			coordinates: number[][][]
		}

		expect(out.coordinates[0]).toHaveLength(8)
		expect(out.coordinates[0]![0]).toEqual(out.coordinates[0]!.at(-1))
	})

	it("simplifies each polygon of a multipolygon and rounds to the stated precision", () => {
		const out = simplifyAreaGeometry(
			{
				type: "MultiPolygon",
				coordinates: [
					[
						[
							[0.1234567, 0],
							[1, 0],
							[1, 1],
							[0.1234567, 0],
						],
					],
				],
			},
			0
		) as { coordinates: number[][][][] }

		expect(out.coordinates[0]![0]![0]).toEqual([0.12346, 0])
	})
})
