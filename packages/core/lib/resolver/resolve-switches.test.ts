// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { RESOLVE_SWITCH_DEFAULTS, resolveSwitches } from "#resolver/types"

describe("resolveSwitches", () => {
	test("an empty option bag yields the defaults table", () => {
		expect(resolveSwitches({})).toEqual(RESOLVE_SWITCH_DEFAULTS)
	})

	test("an explicit value overrides the default of every switch, on or off", () => {
		for (const key of Object.keys(RESOLVE_SWITCH_DEFAULTS) as (keyof typeof RESOLVE_SWITCH_DEFAULTS)[]) {
			const flipped = !RESOLVE_SWITCH_DEFAULTS[key]

			expect(resolveSwitches({ [key]: flipped })[key], key).toBe(flipped)
		}
	})

	test("an explicit undefined falls back to the default", () => {
		expect(resolveSwitches({ adminCoherence: null }).adminCoherence).toBe(true)
	})
})
