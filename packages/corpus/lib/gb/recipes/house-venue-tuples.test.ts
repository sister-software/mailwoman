/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The GB house-venue tuple reader takes the `gb-os-open` adapter's rows and refuses Price Paid Data input
 *   (#2635).
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import { GB_OS_OPEN_ADAPTER_ID } from "#gb/adapters/os-open/adapter"
import { GB_TUPLE_LICENSE, RefusedGBTupleSourceError, sampleGBHouseVenueTuples } from "#gb/recipes/house-venue-tuples"
import { PyRandom } from "#training/pyrandom"

function osOpenRow(postcode: string, street = "Wellington Street", overrides: Record<string, unknown> = {}) {
	return {
		raw: `56 ${street}, Leeds ${postcode}`,
		components: { house_number: "56", street, locality: "Leeds", postcode },
		country: "GB",
		locale: "en-GB",
		source: GB_OS_OPEN_ADAPTER_ID,
		source_id: `gb-os-open-${postcode.replace(" ", "").toLowerCase()}`,
		license: GB_TUPLE_LICENSE,
		...overrides,
	}
}

describe("sampleGBHouseVenueTuples", () => {
	it("refuses the Price Paid Data tuples CSV", async () => {
		await using scratch = await temporaryDirectory("mailwoman-gb-tuples-")
		const path = scratch.path("gb-tuples.csv").toString()

		await writeLocalTextFile("NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE\n9,High Street,,Leeds,,LS1 1BA\n", path)

		await expect(sampleGBHouseVenueTuples(10, new PyRandom(0), path)).rejects.toThrow(/Price Paid Data/)
	})

	it("refuses a row from another source and a row without the OGL license", async () => {
		await using scratch = await temporaryDirectory("mailwoman-gb-tuples-")
		const other = scratch.path("other", "canonical.jsonl").toString()
		const unlicensed = scratch.path("unlicensed", "canonical.jsonl").toString()

		await writeLocalTextFile(
			[osOpenRow("LS1 1BA"), osOpenRow("LS2 7HZ", "Park Lane", { source: "synth-gb", license: "OpenAddresses" })].map(
				(row) => stringifyJSON(row)
			),
			other
		)

		await writeLocalTextFile([stringifyJSON(osOpenRow("LS1 1BA", undefined, { license: "" }))], unlicensed)

		await expect(sampleGBHouseVenueTuples(10, new PyRandom(0), other)).rejects.toThrow(RefusedGBTupleSourceError)
		await expect(sampleGBHouseVenueTuples(10, new PyRandom(0), other)).rejects.toThrow(/synth-gb/)
		await expect(sampleGBHouseVenueTuples(10, new PyRandom(0), unlicensed)).rejects.toThrow(/OGL-UK-3\.0/)
	})

	it("names the path of a missing file rather than answering no tuples", async () => {
		await using scratch = await temporaryDirectory("mailwoman-gb-tuples-")
		const path = scratch.path("canonical.jsonl").toString()

		await expect(sampleGBHouseVenueTuples(10, new PyRandom(0), path)).rejects.toThrow(path)
	})

	it("reads adapter rows into tuples stamped with their source", async () => {
		await using scratch = await temporaryDirectory("mailwoman-gb-tuples-")
		const path = scratch.path("canonical.jsonl").toString()

		await writeLocalTextFile(
			[osOpenRow("LS1 1BA"), osOpenRow("LS2 7HZ", "Park Lane")].map((row) => stringifyJSON(row)),
			path
		)

		const tuples = (await sampleGBHouseVenueTuples(10, new PyRandom(0), path)).toSorted((a, b) =>
			a.postcode.localeCompare(b.postcode)
		)

		expect(tuples.map((tuple) => [tuple.street, tuple.postcode])).toEqual([
			["Wellington Street", "LS1 1BA"],
			["Park Lane", "LS2 7HZ"],
		])

		expect(new Set(tuples.map((tuple) => `${tuple.source}|${tuple.country}|${tuple.region}`))).toEqual(
			new Set([`${GB_OS_OPEN_ADAPTER_ID}|GB|`])
		)
	})
})
