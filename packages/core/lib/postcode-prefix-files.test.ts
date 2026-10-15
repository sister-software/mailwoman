/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { temporaryDirectory } from "#fs/temporary"
import { writeLocalTextFile } from "#fs/writers"
import { newestPostcodePrefixFiles, postcodePrefixScopeOf, shippedPostcodePrefixName } from "#postcode-prefix-files"

describe("postcodePrefixScopeOf", () => {
	it("reads the scope of a dated data-root file and of a shipped package file", () => {
		expect(postcodePrefixScopeOf("postcode-prefix-gb-esw-2026-08-05.bin")).toBe("gb-esw")
		expect(postcodePrefixScopeOf("postcode-prefix-us-2026-08-22.bin")).toBe("us")
		expect(postcodePrefixScopeOf("postcode-prefix-us.bin")).toBe("us")
		expect(postcodePrefixScopeOf("postcode-us.bin")).toBeNull()
		expect(shippedPostcodePrefixName("gb-esw")).toBe("postcode-prefix-gb-esw.bin")
	})
})

describe("newestPostcodePrefixFiles", () => {
	it("keeps the newest file of each scope and lists none for an absent directory", async () => {
		await using directory = await temporaryDirectory("postcode-prefix-")
		const older = directory.path("postcode-prefix-us-2026-08-05.bin")
		const newer = directory.path("postcode-prefix-us-2026-08-22.bin")

		await writeLocalTextFile("old", older)

		await new Promise((resolve) => {
			setTimeout(resolve, 20)
		})

		await writeLocalTextFile("new", newer)
		await writeLocalTextFile("gb", directory.path("postcode-prefix-gb-esw-2026-08-05.bin"))
		await writeLocalTextFile("anchor", directory.path("postcode-us.bin"))

		const newest = await newestPostcodePrefixFiles(directory.path)

		expect([...newest.keys()].toSorted()).toEqual(["gb-esw", "us"])
		expect(newest.get("us")!.path.toString()).toBe(newer.toString())

		expect((await newestPostcodePrefixFiles(directory.path("absent"))).size).toBe(0)
	})
})
