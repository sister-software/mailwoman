/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { COUNTRY_POSTCODE_FORMAT_SOURCES } from "@mailwoman/postcode/country-formats/data"
import { Globerator } from "spliterator/node/fs"
import { describe, expect, test } from "vitest"

import { placementInFormat, POSTCODE_LAYOUTS_PATH, postcodeSideOfAdminBlock } from "./fmt-placement.ts"

const specsDirectory = resolvePackageDirectory("@mailwoman/core")("data", "chromium-i18n", "ssl-address")

describe("placementInFormat", () => {
	test.each([
		["FR", "before_locality"],
		["IT", "before_locality"],
		["DE", "before_locality"],
		["BR", "after_locality"],
		["CA", "after_locality"],
		["NZ", "after_locality"],
	] as const)("reads %s's libaddressinput fmt as %s, and the generated table agrees", async (code, placement) => {
		const { fmt } = await readLocalJSONFile<{ fmt?: string }>(specsDirectory(`${code}.json`))

		expect(placementInFormat(fmt)).toBe(placement)
		expect(COUNTRY_POSTCODE_FORMAT_SOURCES[code]?.postcodePlacement).toBe(placement)
	})

	test("states no order for a layout that prints only one of the two fields", () => {
		expect(placementInFormat("〒%Z%n%S%n%A%n%O%n%N")).toBeNull()
		expect(placementInFormat("%N%n%O%n%A%n%C")).toBeNull()
		expect(placementInFormat(undefined)).toBeNull()
	})

	test("reads the order across a line break", () => {
		expect(placementInFormat("%O%n%N%n%A%n%D%n%C-%S%n%Z")).toBe("after_locality")
		expect(placementInFormat("%N%n%O%n%A%n%Z%n%C")).toBe("before_locality")
	})
})

describe("postcodeSideOfAdminBlock", () => {
	test.each([
		["%N%n%O%n%A%n%C %S %Z", "after"],
		["%N%n%O%n%A%n%C, %S %Z", "after"],
		["%Z%n%S%n%C%n%A%n%O%n%N", "before"],
		["%N%n%O%n%A%n%Z %C", "before"],
		["%N%n%O%n%A%n%C %Z%n%S", "between"],
	] as const)("reads %j as %s", (fmt, side) => {
		expect(postcodeSideOfAdminBlock(fmt)).toBe(side)
	})

	test("states no side for a layout with no locality field or no postcode", () => {
		expect(postcodeSideOfAdminBlock("〒%Z%n%S%n%A%n%O%n%N")).toBeNull()
		expect(postcodeSideOfAdminBlock("%N%n%O%n%A%n%C")).toBeNull()
	})

	test("the generated JSON the augmentation reads agrees with every libaddressinput layout", async () => {
		const committed = await readLocalJSONFile<{ countries: Record<string, string | null> }>(
			repoRootPathBuilder(...POSTCODE_LAYOUTS_PATH)
		)

		const expected: Record<string, string | null> = {}

		for (const file of await Globerator.files("json", {
			cwd: specsDirectory,
			absolute: false,
			recursive: false,
		}).toSorted()) {
			const { fmt } = await readLocalJSONFile<{ fmt?: string }>(specsDirectory(file))

			if (fmt?.includes("%Z")) {
				expected[file.replace(/\.json$/, "")] = postcodeSideOfAdminBlock(fmt)
			}
		}

		expect(committed.countries).toEqual(expected)
		expect(["GI", "JP", "KY", "SG"].map((code) => committed.countries[code])).toEqual([null, null, null, null])
	})
})
