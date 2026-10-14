/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { defaultCheckOutDirName } from "#dev-mcp/spawn-tools"

describe("defaultCheckOutDirName", () => {
	it("names the out-dir by the launch instant and a counter, so two launches never share one", () => {
		const at = new Date("2026-10-14T19:15:00.000Z")

		const first = defaultCheckOutDirName(at)
		const second = defaultCheckOutDirName(at)

		expect(first).toMatch(/^mwdev-check-2026-10-14T19-15-00-000-\d+$/u)
		expect(second).not.toBe(first)
	})
})
