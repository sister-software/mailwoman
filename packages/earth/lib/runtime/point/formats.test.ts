// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { decodePlusCode } from "@mailwoman/spatial/open-location-code"
import { parsePointQuery } from "@mailwoman/spatial/point-query"
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

	expect(parsePointQuery(byLabel.get("Coordinates")!)).toMatchObject({ kind: "coordinates", lat: LAT, lon: LON })

	const dms = parsePointQuery(byLabel.get("DMS")!)

	if (dms?.kind !== "coordinates") throw new Error("the DMS row did not read as coordinates")

	expect(dms.lat).toBeCloseTo(LAT, 4)
	expect(dms.lon).toBeCloseTo(LON, 4)

	const cell = decodePlusCode(byLabel.get("Plus code")!)!

	expect(cell.lat).toBeCloseTo(LAT, 4)
	expect(cell.lon).toBeCloseTo(LON, 4)

	expect(parsePointQuery(byLabel.get("H3")!)).toMatchObject({ kind: "h3" })
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
