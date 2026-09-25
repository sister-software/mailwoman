/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests soft breaks, which render as a line break in multi-line output and as a space in single-line output.
 *
 *   Great Britain prints the post town and postcode on separate lines, but its single-line form is
 *   `27 Minories, London EC3N 1DE`.
 */

import { formatAddress } from "@mailwoman/codex/address-format"
import { addr, SLOTS, withSoftBreakBefore } from "@mailwoman/codex/address-layout"
import { joinRendering, renderAddress } from "@mailwoman/codex/address-render"
import { describe, expect, it } from "vitest"

const MINORIES = {
	house_number: "27",
	street: "Minories",
	locality: "London",
	postcode: "EC3N 1DE",
} as const

describe("GB's single-line form", () => {
	it("writes a space before the postcode and a comma after the street", () => {
		expect(formatAddress(MINORIES, "GB", { singleLine: true })).toBe("27 Minories, London EC3N 1DE")
	})

	it("keeps the post town and the postcode on their own lines down the page", () => {
		expect(formatAddress(MINORIES, "GB")).toBe("27 Minories\nLondon\nEC3N 1DE")
	})

	it("moves the postcode's separator when the post town is absent, and nothing else", () => {
		// The soft break belongs to the postcode line, so it follows whichever line precedes the postcode.
		// This case records current behavior.
		// Real usage without a post town has not been measured.
		expect(
			formatAddress({ house_number: "27", street: "Minories", postcode: "EC3N 1DE" }, "GB", {
				singleLine: true,
			})
		).toBe("27 Minories EC3N 1DE")
	})

	it("yields to an explicit separator, which asks for one string between every pair of lines", () => {
		expect(formatAddress(MINORIES, "GB", { singleLine: true, separator: " | " })).toBe(
			"27 Minories | London | EC3N 1DE"
		)
	})
})

describe("the systems that carry no soft break", () => {
	it("leaves the US comma-joined", () => {
		const us = {
			house_number: "1600",
			street: "Pennsylvania Ave NW",
			locality: "Washington",
			region: "DC",
			postcode: "20500",
		}

		expect(formatAddress(us, "US", { singleLine: true })).toBe("1600 Pennsylvania Ave NW, Washington, DC 20500")
	})

	it("leaves France writing its postcode before the commune on one line", () => {
		expect(formatAddress({ locality: "Lyon", postcode: "69001" }, "FR", { singleLine: true })).toBe("69001 Lyon")
	})
})

describe("withSoftBreakBefore", () => {
	it("marks the break before the line that starts with the named tag", () => {
		const layout = withSoftBreakBefore(
			addr`${SLOTS.street}
${SLOTS.locality}
${SLOTS.postcode}`,
			"postcode"
		)

		expect(layout.softBreakBefore?.has(2)).toBe(true)
		expect(layout.softBreakBefore?.has(1)).toBe(false)
	})

	it("returns the layout unchanged when no line starts with the tag", () => {
		const plain = addr`${SLOTS.street}
${SLOTS.locality}`

		expect(withSoftBreakBefore(plain, "postcode")).toBe(plain)
	})

	it("returns the layout unchanged when the tag starts the first line, which no break precedes", () => {
		const plain = addr`${SLOTS.postcode}
${SLOTS.locality}`

		expect(withSoftBreakBefore(plain, "postcode")).toBe(plain)
	})
})

describe("joinRendering", () => {
	const layout = withSoftBreakBefore(
		addr`${SLOTS.street}
${SLOTS.locality}
${SLOTS.postcode}`,
		"postcode"
	)

	it("replaces a soft break with its own separator", () => {
		const rendering = renderAddress(layout, { street: "Minories", locality: "London", postcode: "EC3N 1DE" })

		expect(joinRendering(rendering, ", ", " ")).toBe("Minories, London EC3N 1DE")
	})

	it("treats a soft break as an ordinary break for a caller that passes one separator", () => {
		const rendering = renderAddress(layout, { street: "Minories", locality: "London", postcode: "EC3N 1DE" })

		expect(joinRendering(rendering, ", ")).toBe("Minories, London, EC3N 1DE")
	})

	it("keeps the mark on the right break when a line above it renders nothing", () => {
		// `evaluateLines` drops the empty locality line.
		// The soft break stays with the postcode line.
		const rendering = renderAddress(layout, { street: "Minories", postcode: "EC3N 1DE" })

		expect(joinRendering(rendering, ", ", " ")).toBe("Minories EC3N 1DE")
	})
})
