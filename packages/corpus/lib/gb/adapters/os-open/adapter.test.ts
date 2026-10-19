/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { resolvePath } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	createGBOSOpenAdapter,
	drawGBHouseNumber,
	GB_OS_OPEN_ADAPTER_ID,
	type GBOSOpenSummary,
} from "#gb/adapters/os-open/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("gb-os-open")

const fixtureRoot = workspacePath("corpus", "fixtures", "gb-os-open")

async function run(): Promise<{ summary: GBOSOpenSummary; rows: Awaited<ReturnType<typeof readCanonicalRows>> }> {
	let summary: GBOSOpenSummary | undefined

	await runAdapter({
		adapter: createGBOSOpenAdapter({ onSummary: (s) => (summary = s) }),
		adapterOptions: { inputPath: fixtureRoot },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { summary: summary!, rows: await readCanonicalRows(scratch.path, GB_OS_OPEN_ADAPTER_ID) }
}

describe("gb-os-open adapter against the fixture products", () => {
	it("accounts for every Code-Point row as emitted or dropped for one reason", async () => {
		const { summary, rows } = await run()

		expect(summary.codePointRows).toBe(9)
		expect(summary.pqi).toEqual({ 10: 6, 20: 1, 30: 1, 90: 1 })
		expect(summary.postcodesWithCoordinate).toBe(8)

		expect(summary.dropped).toEqual({
			noCoordinate: 1,
			sharedCoordinate: 2,
			noLinkWithinRadius: 1,
			noOpenNamesRow: 0,
			districtMismatch: 1,
		})

		expect(summary.emitted).toBe(4)
		expect(rows.map((row) => row.components.postcode)).toEqual(["LS1 1AA", "LS1 1AG", "LS6 1AA", "LS7 1AA"])
	})

	it("joins the named road rather than a nearer unnamed or numbered link", async () => {
		const { rows } = await run()
		const parkRow = rows.find((row) => row.components.postcode === "LS1 1AA")!

		expect(parkRow.components).toMatchObject({ street: "Park Row", locality: "Leeds", postcode: "LS1 1AA" })
		expect(parkRow.raw).toBe(`${parkRow.components.house_number} Park Row, Leeds LS1 1AA`)
	})

	it("title-cases an all-capitals NAME1, omits an empty POPULATED_PLACE, and keeps a bilingual place's first name", async () => {
		const { summary, rows } = await run()
		const church = rows.find((row) => row.components.postcode === "LS6 1AA")!
		const kenneth = rows.find((row) => row.components.postcode === "LS7 1AA")!

		expect(church.components.street).toBe("Church Lane")
		expect(church.components.locality).toBeUndefined()
		expect(kenneth.components.locality).toBe("Stornoway")
		expect(summary).toMatchObject({ titleCasedStreets: 1, noLocality: 1, bilingualLocality: 1 })
		expect(rows.every((row) => !row.components.region)).toBe(true)
	})

	it("stamps OGL provenance and a source id seeded by postcode and TOID", async () => {
		const { rows } = await run()
		const again = await run()

		expect(rows.every((row) => row.license === "OGL-UK-3.0" && row.locale === "en-GB")).toBe(true)
		expect(rows.every((row) => row.source_id.startsWith(`${GB_OS_OPEN_ADAPTER_ID}-`))).toBe(true)
		expect(again.rows.map((row) => row.raw)).toEqual(rows.map((row) => row.raw))
	})

	it("throws naming the missing product directory", async () => {
		await expect(
			runAdapter({
				adapter: createGBOSOpenAdapter(),
				adapterOptions: { inputPath: resolvePath(fixtureRoot, "open-roads", "data") },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/open-roads\/data\/code-point-open is absent/)
	})
})

describe("drawGBHouseNumber", () => {
	it("draws inside 1–400 and repeats for the same source id", () => {
		const drawn = Array.from({ length: 2000 }, (_, i) =>
			Number(drawGBHouseNumber(`gb-os-open-${i.toString(16).padStart(12, "0")}`))
		)

		expect(Math.min(...drawn)).toBeGreaterThanOrEqual(1)
		expect(Math.max(...drawn)).toBeLessThanOrEqual(400)
		expect(drawGBHouseNumber("gb-os-open-00000000abcd")).toBe(drawGBHouseNumber("gb-os-open-00000000abcd"))
	})
})
