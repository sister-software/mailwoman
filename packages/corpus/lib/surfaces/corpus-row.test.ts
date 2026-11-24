// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { isSlot, type AddressAtom } from "@mailwoman/codex/address/layout"
import { layoutForCountry } from "@mailwoman/codex/address/layouts"
import { describe, expect, it } from "vitest"

import { formatCorpusRow } from "#surfaces/corpus-row"

/**
 * The share of drawn renders Croatia's layout states for its bare domestic postcode.
 */
function croatianBareShare(): number {
	const slots = layoutForCountry("HR")!.lines.flat() as AddressAtom[]
	const postcode = slots.find((atom) => isSlot(atom) && atom.tag === "postcode")

	if (!postcode || !isSlot(postcode) || !postcode.otherForms) throw new Error("HR has no postcode forms")

	return postcode.otherForms.find((form) => form.prefix === "")!.share
}

describe("formatCorpusRow", () => {
	const rows = Array.from({ length: 2000 }, (_, index) => ({
		house_number: String(index + 1),
		street: "Krapinska",
		postcode: "HR-10000",
		locality: "ZAGREB",
	}))

	it("renders one row in one form on every call", () => {
		for (const components of rows.slice(0, 50)) {
			const reordered = Object.fromEntries(Object.entries(components).toReversed())

			expect(formatCorpusRow(components, "HR", { singleLine: true })!.raw).toBe(
				formatCorpusRow(reordered, "HR", { singleLine: true })!.raw
			)
		}
	})

	it("renders Croatia's bare domestic form in the share its layout states", () => {
		const rendered = rows.map((components) => formatCorpusRow(components, "HR", { singleLine: true })!)
		const bare = rendered.filter((row) => row.raw.endsWith(" 10000 ZAGREB"))
		const prefixed = rendered.filter((row) => row.raw.endsWith(" HR-10000 ZAGREB"))

		expect(bare.length + prefixed.length).toBe(rows.length)

		expect(new Set(bare.map((row) => row.components.postcode))).toEqual(new Set(["10000"]))
		expect(new Set(prefixed.map((row) => row.components.postcode))).toEqual(new Set(["HR-10000"]))

		// Five binomial standard deviations of 2,000 draws at an even share is 0.056.
		expect(Math.abs(bare.length / rows.length - croatianBareShare())).toBeLessThan(0.056)
	})
})
