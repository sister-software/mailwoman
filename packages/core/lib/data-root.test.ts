/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A snapshot's vintage is one path segment, so a vintage cannot place a snapshot outside its source's directory.
 */

import { describe, expect, it } from "vitest"

import { snapshotSourcePath } from "#data-root"

describe("snapshotSourcePath", () => {
	it("places a dated or released vintage under its source", () => {
		expect(snapshotSourcePath("juso-kr", "2026-08", "202608ALLMTCHG00.zip").toString()).toMatch(
			/\/snapshots\/juso-kr\/2026-08\/202608ALLMTCHG00\.zip$/u
		)

		expect(snapshotSourcePath("overture", "2026-05-20.0").toString()).toMatch(/\/snapshots\/overture\/2026-05-20\.0$/u)
	})

	it("refuses a vintage that would leave the source's directory", () => {
		for (const vintage of ["../2026-08", "2026/08", "", ".."]) {
			expect(() => snapshotSourcePath("juso-kr", vintage)).toThrow("is not a vintage")
		}
	})
})
