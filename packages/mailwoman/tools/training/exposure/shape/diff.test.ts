// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import type { TrainShapeCount } from "../train-shapes.ts"
import { compareShapeDistributions, shapeDistribution, ShapeView } from "./diff.ts"

const row = (country: string, spanTags: string[], rows: number): TrainShapeCount => ({
	source: "invented-house-venue",
	country,
	spanTags,
	rows,
})

describe("compareShapeDistributions", () => {
	const before = [
		row("IN", ["venue", "street", "locality", "region", "postcode"], 50),
		row("IN", ["venue", "street", "locality", "postcode", "region"], 50),
		row("MX", ["street", "postcode", "locality", "region"], 100),
	]

	test("marks a country collapsed to one admin-tail order as moved", () => {
		const after = [
			row("IN", ["venue", "street", "locality", "postcode", "region"], 100),
			row("MX", ["street", "postcode", "locality", "region"], 101),
		]

		const differences = compareShapeDistributions(
			shapeDistribution(before, ShapeView.AdminTail),
			shapeDistribution(after, ShapeView.AdminTail),
			ShapeView.AdminTail,
			0.05
		)

		expect(differences.map((d) => [d.country, d.moved])).toEqual([
			["IN", true],
			["MX", false],
		])

		expect(differences[0]!.orders).toContainEqual({
			order: "locality region postcode",
			before: 50,
			after: 0,
			beforeShare: 0.5,
			afterShare: 0,
		})
	})

	test("lists nothing when both sides hold the same counts", () => {
		const same = shapeDistribution(before, ShapeView.Sequence)

		expect(compareShapeDistributions(same, same, ShapeView.Sequence, 0)).toEqual([])
	})
})
