/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { renderAdminTail } from "#synthesizers/tail"

describe("renderAdminTail", () => {
	const parts = { locality: "Oxford", region: "Oxfordshire", postcode: "OX1 4AA" }

	it("renders each country's order and keeps only the parts the layout prints", () => {
		expect(renderAdminTail("US", parts)).toEqual({ raw: "Oxford, Oxfordshire OX1 4AA", components: parts })

		expect(renderAdminTail("FR", parts)).toEqual({
			raw: "OX1 4AA Oxford",
			components: { postcode: "OX1 4AA", locality: "Oxford" },
		})

		expect(renderAdminTail("GB", parts)?.raw).toBe("Oxford, OX1 4AA")
		expect(renderAdminTail("VE", parts)?.raw).toBe("Oxford OX1 4AA, Oxfordshire")
	})

	it("appends a country the caller supplies and skips an empty part", () => {
		const tail = renderAdminTail("US", { ...parts, postcode: "", country: "USA" })

		expect(tail?.raw).toBe("Oxford, Oxfordshire, USA")
		expect(tail?.components.postcode).toBeUndefined()
	})

	it("returns null when the codex has no layout for the country", () => {
		expect(renderAdminTail("ZZ", parts)).toBeNull()
	})
})
