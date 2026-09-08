/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { framingZoom } from "@mailwoman/planetary/map/camera"
import { expect, test } from "vitest"

test.each([
	[1250, 3], // Mare Imbrium
	[300, 3],
	[299.9, 5],
	[100, 5],
	[85.29, 7], // Tycho
	[30, 7],
	[29.9, 9],
	[1.2, 9],
	[0, 9],
	[undefined, 9],
])("a %s km feature is framed at zoom %d", (diameterKm, zoom) => {
	expect(framingZoom(diameterKm)).toBe(zoom)
})

/**
 * The clamp exists because framing past the terrain archive's depth is what turned a selected crater into a grey blur:
 * Tycho earns zoom 7 against an archive that stops at 5, and an unclamped small feature asks for 9.
 */
test.each([
	// [diameterKm, maxTerrainZoom, expected]
	[85.29, 5, 6], // Tycho on a zoom-5 archive: one level of over-zoom, not two
	[85.29, 6, 7], // the same feature on a deeper archive keeps its earned zoom
	[1.2, 5, 6], // a small crater cannot ask for 9
	[1.2, 6, 7],
	[undefined, 5, 6], // an unknown diameter is clamped like any other
	[1250, 5, 3], // a clamp never pushes a wide feature IN
	[1250, 6, 3],
])("a %s km feature against a zoom-%d archive frames at %d", (diameterKm, maxTerrainZoom, expected) => {
	expect(framingZoom(diameterKm, maxTerrainZoom)).toBe(expected)
})

test("without an archive depth the framing is unclamped", () => {
	expect(framingZoom(1.2)).toBe(9)
	expect(framingZoom(1.2, undefined)).toBe(9)
})
