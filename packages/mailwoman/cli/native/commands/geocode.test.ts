/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { spec } from "#cli/native/commands/geocode"
import { GEOCODE_SESSION_DEFAULTS } from "#geocode/session"

describe("geocode command flags", () => {
	it("defaults --variant-alias-exemption to the session's default and offers both named values", () => {
		const flag = spec.options["variant-alias-exemption"]

		expect(flag.default).toBe(GEOCODE_SESSION_DEFAULTS.variantAliasExemption)
		expect([...flag.choices]).toEqual(["applied", "not_applied"])
	})
})
