// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { resolveOptsFrom } from "#tools/eval-harness/oa/resolver/parse-rig"

describe("resolveOptsFrom — the oa-resolver switch pins", () => {
	it("passes no option for a production pin, so the resolver's defaults decide", () => {
		const opts = resolveOptsFrom({ adminCoherence: "production", postcodeCountryCoherence: "production" }, "none")

		expect(opts).not.toHaveProperty("adminCoherence")
		expect(opts).not.toHaveProperty("postcodeCountryCoherence")
		expect(resolveOptsFrom({}, "none")).not.toHaveProperty("adminCoherence")
	})

	it("passes an on or off pin as an explicit value", () => {
		expect(resolveOptsFrom({ adminCoherence: "off", postcodeCountryCoherence: "on" }, "none")).toMatchObject({
			adminCoherence: false,
			postcodeCountryCoherence: true,
		})
	})
})
