/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { type UnderseaAsset, type UnderseaAssetFeature, UnderseaIndex, underseaNameKey } from "#features"
import { underseaDisplayName, type UnderseaGeometryKind } from "#vocabulary"

const feature = (
	featureID: number,
	name: string,
	genericTerm: string,
	kind: UnderseaGeometryKind,
	labelPoint: [number, number]
): UnderseaAssetFeature => ({
	type: "Feature",
	id: featureID,
	geometry: { type: "Point", coordinates: labelPoint },
	properties: {
		featureID,
		name,
		genericTerm,
		displayName: underseaDisplayName(name, genericTerm),
		kind,
		labelPoint,
		bbox: [labelPoint[0], labelPoint[1], labelPoint[0], labelPoint[1]],
	},
})

const asset: UnderseaAsset = {
	type: "FeatureCollection",
	attribution: "fixture",
	sourceVintage: "2026-11-02",
	features: [
		feature(563, "Challenger", "Deep", "point", [142.591667, 11.373333]),
		feature(1, "Mariana", "Trench", "point", [147.5, 15.2]),
		feature(1, "Mariana", "Trench", "line", [147.505, 15.175]),
		feature(2, "Marianas", "Ridge", "polygon", [146, 17]),
		feature(3, "Mendocino", "Fracture Zone", "line", [-135, 40]),
	],
}

describe("underseaDisplayName", () => {
	test("joins the specific name and the generic term", () => {
		expect(underseaDisplayName("Challenger", "Deep")).toBe("Challenger Deep")
	})

	test("keeps a name that already ends with its generic term", () => {
		expect(underseaDisplayName("Sirena Deep", "Deep")).toBe("Sirena Deep")
	})
})

describe("UnderseaIndex", () => {
	const index = new UnderseaIndex(asset)

	test("matches a whole display name with case and diacritics folded", () => {
		expect(index.match("challenger DEEP").map((entry) => entry.featureID)).toEqual([563])
		expect(underseaNameKey("Mariána  Trench")).toBe(underseaNameKey("mariana trench"))
	})

	test("keeps one entry per gazetteer id, from the geometry kind that carries its extent", () => {
		const [trench, ...rest] = index.match("Mariana Trench")

		expect(rest).toEqual([])
		expect(trench?.kind).toBe("line")
		expect(trench?.labelPoint).toEqual([147.505, 15.175])
	})

	test("suggests by prefix in name order and refuses a prefix under three characters", () => {
		expect(index.suggest("mari", 5).map((entry) => entry.displayName)).toEqual(["Mariana Trench", "Marianas Ridge"])
		expect(index.suggest("ma", 5)).toEqual([])
		expect(index.suggest("mari", 1)).toHaveLength(1)
	})

	test("answers an empty list for a name it does not hold", () => {
		expect(index.match("Atlantis")).toEqual([])
	})
})
