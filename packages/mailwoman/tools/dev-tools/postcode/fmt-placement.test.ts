/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { COUNTRY_POSTCODE_FORMAT_SOURCES } from "@mailwoman/postcode/country-formats/data"
import { describe, expect, test } from "vitest"

import { postcodePlacementOf } from "./fmt-placement.ts"

const specsDirectory = resolvePackageDirectory("@mailwoman/core")("data", "chromium-i18n", "ssl-address")

describe("postcodePlacementOf", () => {
	test.each([
		["FR", "before_locality"],
		["IT", "before_locality"],
		["DE", "before_locality"],
		["BR", "after_locality"],
		["CA", "after_locality"],
		["NZ", "after_locality"],
	] as const)("reads %s's libaddressinput fmt as %s, and the generated table agrees", async (code, placement) => {
		const { fmt } = await readLocalJSONFile<{ fmt?: string }>(specsDirectory(`${code}.json`))

		expect(postcodePlacementOf(fmt)).toBe(placement)
		expect(COUNTRY_POSTCODE_FORMAT_SOURCES[code]?.postcodePlacement).toBe(placement)
	})

	test("states no order for a layout that prints only one of the two fields", () => {
		expect(postcodePlacementOf("〒%Z%n%S%n%A%n%O%n%N")).toBeNull()
		expect(postcodePlacementOf("%N%n%O%n%A%n%C")).toBeNull()
		expect(postcodePlacementOf(undefined)).toBeNull()
	})

	test("reads the order across a line break", () => {
		expect(postcodePlacementOf("%O%n%N%n%A%n%D%n%C-%S%n%Z")).toBe("after_locality")
		expect(postcodePlacementOf("%N%n%O%n%A%n%Z%n%C")).toBe("before_locality")
	})
})
