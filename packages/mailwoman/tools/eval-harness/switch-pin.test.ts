/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { pinnedSwitch, switchPinEntry, SwitchPinSchema } from "#tools/eval-harness/switch-pin"

describe("switch pins", () => {
	it("resolve to the production value only when unpinned", () => {
		expect(pinnedSwitch("production", true)).toBe(true)
		expect(pinnedSwitch("production", false)).toBe(false)
		expect(pinnedSwitch("on", false)).toBe(true)
		expect(pinnedSwitch("off", true)).toBe(false)
	})

	it("contribute an entry only when pinned, so the consumer's defaults table decides otherwise", () => {
		expect(switchPinEntry("adminCoherence", "production")).toEqual({})
		expect(switchPinEntry("adminCoherence", "on")).toEqual({ adminCoherence: true })
		expect(switchPinEntry("adminCoherence", "off")).toEqual({ adminCoherence: false })
	})

	it("refuse any other spelling", () => {
		expect(SwitchPinSchema.safeParse("true").success).toBe(false)
	})
})
