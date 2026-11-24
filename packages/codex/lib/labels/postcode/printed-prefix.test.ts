// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { withoutRepeatedPrefix, withPrintedPrefix } from "#labels/postcode/printed-prefix"

describe("withPrintedPrefix", () => {
	it("prints the prefix before a bare value", () => {
		expect(withPrintedPrefix("HR-", "21000")).toBe("HR-21000")
		expect(withPrintedPrefix("〒", "733-0025")).toBe("〒733-0025")
	})

	it("keeps a value that already carries the prefix, in any case and with any separator", () => {
		expect(withPrintedPrefix("HR-", "HR-21000")).toBe("HR-21000")
		expect(withPrintedPrefix("HR-", "hr 21000")).toBe("hr 21000")
		expect(withPrintedPrefix("FO-", "FO100")).toBe("FO100")
		expect(withPrintedPrefix("L-", "L-1471")).toBe("L-1471")
		expect(withPrintedPrefix("LV-", "LV–1050")).toBe("LV–1050")
		expect(withPrintedPrefix("〒", "〒733-0025")).toBe("〒733-0025")
	})

	it("keeps one copy of a prefix the value repeats", () => {
		expect(withPrintedPrefix("LT-", "LT-LT-06321")).toBe("LT-06321")
		expect(withPrintedPrefix("〒", "〒〒733-0025")).toBe("〒733-0025")
	})

	it("reads the prefix only when digits follow it", () => {
		expect(withPrintedPrefix("L-", "LU1471")).toBe("L-LU1471")
	})
})

describe("withoutRepeatedPrefix", () => {
	it("writes a repeated code once where the layout prints none", () => {
		expect(withoutRepeatedPrefix("FI-FI-21250")).toBe("FI-21250")
		expect(withoutRepeatedPrefix("L-L-1471")).toBe("L-1471")
		expect(withoutRepeatedPrefix("FOFO100")).toBe("FO100")
	})

	it("leaves a postcode whose area doubles a letter", () => {
		expect(withoutRepeatedPrefix("LL11 1AA")).toBe("LL11 1AA")
		expect(withoutRepeatedPrefix("SS1 1AA")).toBe("SS1 1AA")
	})
})
