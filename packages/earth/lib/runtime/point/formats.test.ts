// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { decodePlusCode } from "@mailwoman/spatial/open-location-code"
import { pointFromText } from "@mailwoman/spatial/point/reading"
import { expect, test } from "vitest"

import { describePoint, h3ResolutionForZoom } from "#runtime/point/formats"

// The White House, the point the coordinate-format tests in `@mailwoman/spatial` are pinned to.
const LAT = 38.8977
const LON = -77.0365

test("every encoding of a point reads back to the point", async () => {
	const formats = await describePoint(LAT, LON, 12)
	const byLabel = new Map(formats.map((format) => [format.label, format.value]))

	expect([...byLabel.keys()]).toEqual(["Coordinates", "DMS", "Plus code", "H3", "Geohash", "MGRS"])
	expect(formats.every((format) => typeof format.hint === "string")).toBe(true)
	expect(formats.find((format) => format.label === "H3")?.hint).toBe("H3 cell at resolution 8")

	expect(pointFromText(byLabel.get("Coordinates")!)).toMatchObject({
		kind: "coordinates",
		latitude: LAT,
		longitude: LON,
	})

	const dms = pointFromText(byLabel.get("DMS")!)

	if (dms?.kind !== "coordinates") throw new Error("the DMS row did not read as coordinates")

	expect(dms.latitude).toBeCloseTo(LAT, 4)
	expect(dms.longitude).toBeCloseTo(LON, 4)

	// The plus code row reads back through the recognizer.
	// It validates the text the encoder wrote.
	const plus = pointFromText(byLabel.get("Plus code")!)

	if (plus?.kind !== "plus_code") throw new Error("the plus code row did not read as a plus code")

	const cell = decodePlusCode(plus.code)!

	expect(cell.lat).toBeCloseTo(LAT, 4)
	expect(cell.lon).toBeCloseTo(LON, 4)

	expect(pointFromText(byLabel.get("H3")!)).toMatchObject({ kind: "h3" })
	expect(byLabel.get("Geohash")!.startsWith("dqc")).toBe(true)
	expect(byLabel.get("MGRS")!.startsWith("18S")).toBe(true)
})

test("the H3 resolution follows the zoom and stays within H3's range", () => {
	expect(h3ResolutionForZoom(0)).toBe(0)
	expect(h3ResolutionForZoom(4)).toBe(0)
	expect(h3ResolutionForZoom(12)).toBe(8)
	expect(h3ResolutionForZoom(16.4)).toBe(12)
	expect(h3ResolutionForZoom(22)).toBe(15)
})

test("MGRS is left out beyond its latitude range", async () => {
	const formats = await describePoint(-85, 0, 3)

	expect(formats.map((format) => format.label)).not.toContain("MGRS")
})
