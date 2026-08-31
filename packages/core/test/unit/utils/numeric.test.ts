/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { clamp } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

describe("clamp", () => {
	it("keeps a value inside the closed interval", () => {
		expect(clamp(5, 0, 10)).toBe(5)
		expect(clamp(-1, 0, 10)).toBe(0)
		expect(clamp(11, 0, 10)).toBe(10)
		expect(clamp(0, 0, 0)).toBe(0)
	})
})
