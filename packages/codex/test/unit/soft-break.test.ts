/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A soft break is a line break down the page and a space on one line, and Great Britain is the layout that needs it.
 *
 *   Royal Mail prints the post town and the postcode on separate lines. Written on one line Great Britain puts a space
 *   between them — `27 Minories, London EC3N 1DE` — which is the form #1366 pinned and the majority register in
 *   attested data: `wof-postalcode` carries 10,282,560 GB rows without the comma against 3,265,642 with. One join per
 *   system cannot say both, and before the soft break the single-line render answered `London, EC3N 1DE`.
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
		// The mark names the break preceding the postcode line, so it applies to
		// whatever line survives above it.
		// This case moved with the mark: it read `27 Minories, EC3N 1DE` before.
		// Nobody has measured which form dominates a GB address written with no post town —
		// the 10,282,560-to-3,265,642 count is over rows carrying both — so this case
		// pins the behavior and claims nothing about the register.
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
		// `evaluateLines` drops the empty locality line and renumbers what survives.
		// The mark names the line a break precedes, so it travels with the postcode
		// rather than landing on the break above it.
		const rendering = renderAddress(layout, { street: "Minories", postcode: "EC3N 1DE" })

		expect(joinRendering(rendering, ", ", " ")).toBe("Minories EC3N 1DE")
	})
})
