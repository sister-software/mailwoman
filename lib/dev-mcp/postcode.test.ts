/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalBuffer, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { candidateSystemsForPostcode } from "@mailwoman/postcode/systems"
import { describe, expect, it } from "vitest"

import { lookupPostcodeRegions } from "#dev-mcp/postcode"
import { postcodeTool } from "#dev-mcp/tools/postcode"

const PORTLAND = ["US", "97202", "Portland", "Oregon", "OR", "Multnomah", "051", "", "", "45.484", "-122.6365", "4"]

describe("lookupPostcodeRegions", () => {
	it("preserves raw records and every matching administrative association", async () => {
		await using dir = await temporaryDirectory("postcode-tool-")
		const other = [...PORTLAND]
		other[5] = 'Another "county'
		const tail = [...PORTLAND]
		tail[1] = "97203"
		const records = [PORTLAND, other, tail]

		for (const system of candidateSystemsForPostcode("97202")) {
			const country = system.toUpperCase()
			const rows = country === "US" ? records : [[country, ...tail.slice(1)]]

			await writeLocalTextFile(
				rows.map((r) => r.join("\t")).join("\n") + "\n",
				dir.path("geonames-postal", `${country}.txt`)
			)
		}

		const result = await lookupPostcodeRegions("97202", dir.path.toString())
		expect(result.candidate_systems).toEqual(candidateSystemsForPostcode("97202"))
		expect(result.sources[0]).toMatchObject({ raw: [PORTLAND, other], rows_read: records.length, matching_rows: 2 })

		expect(result.table[0]).toMatchObject({
			country: "US",
			status: "matched",
			place: "Portland",
			admin1: { name: "Oregon", code: "OR" },
			admin2: { name: "Multnomah", code: "051" },
		})

		expect(result.table[1]).toMatchObject({ admin2: { name: 'Another "county' } })
		expect(result.table.find((r) => r.country === "DE")).toMatchObject({ status: "no_record", admin1: null })
	})

	it("reads a ZIP member through the tool handler and preserves source postcode text", async () => {
		await using dir = await temporaryDirectory("postcode-tool-")

		// The archive contains one GB.txt record for SW1A 1AA, London, England.
		const archive = Buffer.from(
			"UEsDBBQAAAAIAC+sVV2eHsrxPAAAAD8AAAAGAAAAR0IudHh0c3fiDA43dFQwdHTk9MnPS8nP43TNS89JzEvhdPVz53QvSk0sSS1SgEq5+3Bycpoa6ply6hroGXKacAEAUEsBAhQDFAAAAAgAL6xVXZ4eyvE8AAAAPwAAAAYAAAAAAAAAAAAAAIABAAAAAEdCLnR4dFBLBQYAAAAAAQABADQAAABgAAAAAAA=",
			"base64"
		)

		await writeLocalBuffer(archive, dir.path("geonames-postal", "GB.zip"))
		const result = await postcodeTool().handler({ postcode: "sw1a 1aa", data_root: dir.path.toString() })

		expect(result).toMatchObject({
			lookup_key: "SW1A 1AA",
			table: [{ country: "GB", postcode: "SW1A 1AA", place: "London", admin1: { name: "England", code: "ENG" } }],
		})
	})

	it("refuses missing, empty and malformed exports", async () => {
		await using dir = await temporaryDirectory("postcode-tool-")
		await expect(lookupPostcodeRegions("SW1A 1AA", dir.path.toString())).rejects.toThrow("neither")
		const path = dir.path("geonames-postal", "GB.txt")
		await writeLocalTextFile("", path)
		await expect(lookupPostcodeRegions("SW1A 1AA", dir.path.toString())).rejects.toThrow("contains no records")
		await writeLocalTextFile("GB\tSW1A 1AA\tLondon\n", path)
		await expect(lookupPostcodeRegions("SW1A 1AA", dir.path.toString())).rejects.toThrow("at row 1")
	})

	it("keeps leading zeroes and rejects non-string tool input", async () => {
		await using dir = await temporaryDirectory("postcode-tool-")

		for (const system of candidateSystemsForPostcode("00100")) {
			const country = system.toUpperCase()

			await writeLocalTextFile(
				[country, "00100", "Example", "", "", "", "", "", "", "", "", ""].join("\t") + "\n",
				dir.path("geonames-postal", `${country}.txt`)
			)
		}

		const result = await lookupPostcodeRegions("00100", dir.path.toString())
		expect(result.table.every((r) => r.postcode === "00100" && r.status === "matched")).toBe(true)
		await expect(postcodeTool().handler({ postcode: 100 })).rejects.toThrow("expected string")
	})
})
