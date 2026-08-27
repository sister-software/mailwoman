/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The datum guard, against real `projinfo --summary` output.
 *
 *   Both fixtures below came off the SAME machine and the SAME command, minutes apart: the first before
 *   `uk_os_OSTN15_NTv2_OSGBtoETRS.tif` was installed and the second after. The difference in the output is
 *   six words; the difference in the artifact is 3.4 metres over every coordinate in England.
 */

import { assessDatumTransformation } from "@mailwoman/flood/sdk/ingest"
import { describe, expect, it } from "vitest"

/**
 * `projinfo -s EPSG:27700 -t EPSG:4326 --summary`, with the OSTN15 grid ABSENT.
 */
const GRID_MISSING = `Candidate operations found: 2
Note: using '--spatial-test intersects' would bring more results (9)
unknown id, Inverse of British National Grid + OSGB36 to WGS 84 (9), 1 m, United Kingdom (UK) - offshore to boundary of UKCS within 49°45'N to 61°N and 9°W to 2°E; onshore Great Britain (England, Wales and Scotland). Isle of Man onshore., at least one grid missing
unknown id, Inverse of British National Grid + Ballpark geographic offset from OSGB36 to WGS 84, unknown accuracy, World, has ballpark transformation
`

/**
 * The same command with the grid INSTALLED. The only change is the missing trailing clause.
 */
const GRID_PRESENT = `Candidate operations found: 2
Note: using '--spatial-test intersects' would bring more results (9)
unknown id, Inverse of British National Grid + OSGB36 to WGS 84 (9), 1 m, United Kingdom (UK) - offshore to boundary of UKCS within 49°45'N to 61°N and 9°W to 2°E; onshore Great Britain (England, Wales and Scotland). Isle of Man onshore.
unknown id, Inverse of British National Grid + Ballpark geographic offset from OSGB36 to WGS 84, unknown accuracy, World, has ballpark transformation
`

/**
 * A source-target pair PROJ can only bridge by guessing.
 */
const BALLPARK_ONLY = `Candidate operations found: 1
unknown id, Ballpark geographic offset from Unknown datum to WGS 84, unknown accuracy, World, has ballpark transformation
`

describe("assessDatumTransformation", () => {
	it("refuses when the best operation's grid is not installed", () => {
		const verdict = assessDatumTransformation(GRID_MISSING)

		expect(verdict.usable).toBe(false)
		expect(verdict.reason).toMatch(/grid is not installed/u)
		expect(verdict.best).toMatch(/OSGB36 to WGS 84/u)
	})

	it("accepts the same operation once the grid is there", () => {
		const verdict = assessDatumTransformation(GRID_PRESENT)

		expect(verdict.usable).toBe(true)
		expect(verdict.best).toMatch(/1 m/u)
	})

	it("refuses a ballpark-only pair, which is a guess wearing a coordinate's clothes", () => {
		expect(assessDatumTransformation(BALLPARK_ONLY).usable).toBe(false)
	})

	it("refuses output naming no candidate at all", () => {
		expect(assessDatumTransformation("Candidate operations found: 0\n").usable).toBe(false)
	})
})
