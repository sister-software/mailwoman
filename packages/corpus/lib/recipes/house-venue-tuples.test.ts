/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The house-venue tuples assembler runs the samplers in order on one generator and copies a country from an
 *   earlier file without drawing.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import {
	assembleHouseVenueTuples,
	type HouseVenueSampler,
	type HouseVenueTuple,
	readCarriedTuples,
} from "#recipes/house-venue-tuples"

const tuple = (country: string, street: string): HouseVenueTuple => ({
	locality: "L",
	region: "",
	postcode: "1",
	country,
	street,
	houseNumber: "1",
})

/**
 * A sampler that records one draw per tuple, so the test reads the shared generator's position.
 */
const drawing =
	(country: string): HouseVenueSampler =>
	async (count, rng) =>
		Array.from({ length: count }, () => tuple(country, String(rng.randrange(1000))))

describe("assembleHouseVenueTuples", () => {
	it("draws each country after the one before it, and a carried country draws nothing", async () => {
		await using scratch = await temporaryDirectory("mailwoman-house-venue-")
		const earlier = scratch.path("earlier.jsonl").toString()

		await writeLocalTextFile(
			[tuple("XA", "carried"), tuple("XB", "other")].map((entry) => stringifyJSON(entry)),
			earlier
		)

		const samplers = [
			["xa", drawing("XA")],
			["xb", drawing("XB")],
		] as const

		const sampled = await assembleHouseVenueTuples({ budgets: { xa: 2, xb: 2 }, seed: 5, samplers })

		const carried = await assembleHouseVenueTuples({
			budgets: { xa: 2, xb: 2 },
			seed: 5,
			samplers,
			carry: ["xa"],
			carryFrom: earlier,
		})

		expect(carried[0]![1].map((entry) => entry.street)).toEqual(["carried"])
		// When XA is copied rather than sampled, XB draws the same streets it drew when both samplers ran.
		expect(carried[1]![1].map((entry) => entry.street)).toEqual(sampled[0]![1].map((entry) => entry.street))
	})

	it("refuses a carry with no file to carry from", async () => {
		await expect(assembleHouseVenueTuples({ carry: ["fr"] })).rejects.toThrow(/--carry-from/)
	})
})

describe("readCarriedTuples", () => {
	it("names the path of a missing file and refuses a file without the country", async () => {
		await using scratch = await temporaryDirectory("mailwoman-house-venue-")
		const missing = scratch.path("absent.jsonl").toString()
		const other = scratch.path("other.jsonl").toString()

		await writeLocalTextFile([stringifyJSON(tuple("FR", "x"))], other)

		await expect(readCarriedTuples(missing, "gb")).rejects.toThrow(missing)
		await expect(readCarriedTuples(other, "gb")).rejects.toThrow(/holds no GB tuple/)
	})
})
