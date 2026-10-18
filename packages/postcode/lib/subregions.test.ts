/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { Globerator } from "spliterator/node/fs"
import { describe, expect, it } from "vitest"

import { statesSubregionPrefixes, subregionsForPostcode } from "#subregions"

interface AddressMetadata {
	readonly sub_keys?: string
	readonly sub_zips?: string
	readonly sub_zipexs?: string
}

describe("the generated subregion table", () => {
	it("places every libaddressinput subregion example in its own subregion", async () => {
		const dir = resolvePackageDirectory("@mailwoman/core")("data", "chromium-i18n", "ssl-address")
		const misses: string[] = []
		let checked = 0

		for (const file of await Globerator.files("json", { cwd: dir, absolute: false, recursive: false }).toArray()) {
			const metadata = await readLocalJSONFile<AddressMetadata>(dir(file))

			if (!metadata.sub_zips || !metadata.sub_zipexs) continue
			const country = file.replace(/\.json$/u, "")
			const keys = metadata.sub_keys!.split("~")
			const examples = metadata.sub_zipexs.split("~")

			for (const [i, list] of examples.entries()) {
				if (!list || !metadata.sub_zips.split("~")[i]) continue

				for (const example of list.split(",")) {
					checked++

					if (!subregionsForPostcode(example, country).some((s) => s.key === keys[i])) {
						misses.push(`${country} ${keys[i]} ${example}`)
					}
				}
			}
		}

		expect(checked).toBeGreaterThan(0)
		expect(misses).toEqual([])
	})
})

describe("subregionsForPostcode", () => {
	it("reads the subregion a prefix states", () => {
		expect(subregionsForPostcode("35203", "US").map((s) => s.isoid)).toEqual(["AL"])
		expect(subregionsForPostcode("T2P 1J9", "CA").map((s) => s.isoid)).toEqual(["AB"])
		expect(subregionsForPostcode("92100", "IT").map((s) => s.key)).toEqual(["AG"])
	})

	it("ignores case and spacing", () => {
		expect(subregionsForPostcode("t2p1j9", "ca").map((s) => s.isoid)).toEqual(["AB"])
		expect(subregionsForPostcode("CP  2101", "SV").map((s) => s.key)).toEqual(["Ahuachapan"])
	})

	it("returns every subregion whose prefix overlaps", () => {
		// 2620 sits in both the ACT and NSW prefix lists.
		expect(
			subregionsForPostcode("2620", "AU")
				.map((s) => s.isoid)
				.toSorted()
		).toEqual(["ACT", "NSW"])
	})

	it("is empty where no stated prefix matches, and for a country that states none", () => {
		expect(subregionsForPostcode("00000", "US")).toEqual([])
		expect(statesSubregionPrefixes("US")).toBe(true)
		expect(statesSubregionPrefixes("GB")).toBe(false)
		expect(subregionsForPostcode("SW1A 1AA", "GB")).toEqual([])
	})
})
