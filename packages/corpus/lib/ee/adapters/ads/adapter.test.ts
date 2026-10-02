/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { ADS_ADAPTER_ID, ADS_DEFAULT_LICENSE, createADSAdapter, thoroughfareOf } from "#ee/adapters/ads/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("ads")

/**
 * Ten `AD.Address` features as the service's `application/json` writer emitted them on
 * 2026-10-02, one per line with the `FeatureCollection` envelope dropped.
 *
 * Three are street addresses in a settlement unit, two are street addresses in a town
 * whose settlement slot is `unpopulated`, two reference an address area rather than a
 * thoroughfare, and three carry a named site and no thoroughfare at all.
 */
const fixtureJSONL = workspacePath("corpus", "fixtures", "ads", "sample.jsonl")

async function run(options: { country?: string; limit?: number } = {}) {
	return await runAdapter({
		adapter: createADSAdapter(),
		adapterOptions: { inputPath: fixtureJSONL, ...options },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})
}

describe("ads adapter against fixture sample.jsonl", () => {
	it("emits a row per feature under the CC0 the dataset record states", async () => {
		const manifest = await run()

		expect(manifest.yielded).toBe(10)

		const rows = await readCanonicalRows(scratch.path, ADS_ADAPTER_ID)

		expect(rows).toHaveLength(10)
		expect(rows.every((r) => r.license === ADS_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((r) => r.source === ADS_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.country === "EE")).toBe(true)
		expect(rows.every((r) => r.locale === "et-EE")).toBe(true)
	})

	it("reads the house number from the locator name rather than the designator", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, ADS_ADAPTER_ID)
		const pargi = rows.find((r) => r.components.street === "Pargi tn")

		// The feature behind this row carries designator `7_1DOW` and locator name `2b`.
		expect(pargi?.components.house_number).toBe("2b")
		expect(pargi?.raw).toBe("Pargi tn 2b, 76607 Keila linn Harju maakond")
	})

	it("never lets an ADS designator code reach house_number", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, ADS_ADAPTER_ID)

		// Every designator in the fixture, read from the fixture rather than invented.
		const designators = [
			"7_0XRX",
			"7_3P4Y",
			"7_3O6U",
			"7_1DOW",
			"7_1DRN",
			"7_9LIK",
			"7_9946",
			"6_0MU3",
			"6_0MZA",
			"6_DVKB",
		]

		const emitted = new Set(rows.flatMap((r) => Object.values(r.components)))

		for (const designator of designators) {
			expect(emitted.has(designator)).toBe(false)
		}

		// The shape of an ADS code, so a designator this fixture does not carry fails too.
		const codeShape = /^\d_[0-9A-Z]{3,4}$/u

		for (const row of rows) {
			expect(row.components.house_number ?? "").not.toMatch(codeShape)
			expect(row.raw).not.toMatch(codeShape)
		}
	})

	it("keeps a feature with no thoroughfare, which is the ordinary rural case", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, ADS_ADAPTER_ID)
		const streetless = rows.filter((r) => r.components.street === undefined)

		expect(streetless).toHaveLength(3)

		// The named site becomes the venue rather than a house number, because
		// `Jüri` is a farm name and not a number.
		expect(streetless.map((r) => r.raw).toSorted()).toEqual([
			"Jüri, Raugi küla, 94759 Muhu vald Saare maakond",
			"Pärna, Paasiku küla, 74314 Anija vald Harju maakond",
			"Põllu, Rootsivere küla, 94732 Muhu vald Saare maakond",
		])

		expect(streetless.every((r) => r.components.house_number === undefined)).toBe(true)
		expect(streetless.every((r) => typeof r.components.venue === "string")).toBe(true)
	})

	it("reads an address area as the thoroughfare it stands in for", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, ADS_ADAPTER_ID)
		const area = rows.find((r) => r.components.street === "Vahatu vkt")

		expect(area?.components.house_number).toBe("19")
		expect(area?.raw).toBe("Vahatu vkt 19, Arava küla, 74405 Anija vald Harju maakond")
	})

	it("never stores the unpopulated sentinel as a value", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, ADS_ADAPTER_ID)

		for (const row of rows) {
			expect(Object.values(row.components)).not.toContain("unpopulated")
			expect(row.raw).not.toContain("unpopulated")
		}
	})

	it("places the settlement unit inside the municipality", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, ADS_ADAPTER_ID)
		const inVillage = rows.find((r) => r.components.street === "Sarapuu tn")
		const inTown = rows.find((r) => r.components.street === "Koidu tn")

		expect(inVillage?.components.dependent_locality).toBe("Tabasalu alevik")
		expect(inVillage?.components.locality).toBe("Harku vald")
		expect(inVillage?.components.region).toBe("Harju maakond")

		// Keila linn leaves its settlement slot unpopulated, so the municipality is
		// the locality and no dependent locality is written.
		expect(inTown?.components.dependent_locality).toBeUndefined()
		expect(inTown?.components.locality).toBe("Keila linn")
	})

	it("source_id uses the INSPIRE local identifier", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, ADS_ADAPTER_ID)

		expect(rows[0]!.source_id).toBe("ads-121752")
	})

	it("honors a limit", async () => {
		const manifest = await run({ limit: 4 })

		expect(manifest.yielded).toBe(4)
	})

	it("accepts the one jurisdiction the dataset covers", async () => {
		const manifest = await run({ country: "EE" })

		expect(manifest.yielded).toBe(10)
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		await expect(run({ country: "LV" })).rejects.toThrow(/the dataset covers EE/)
	})

	it("two runs over the same file produce identical sha256", async () => {
		const a = await run()

		await removePathIfPresent(scratch.path(ADS_ADAPTER_ID))

		const b = await run()

		expect(a.sha256).toBe(b.sha256)
	})

	it.each([
		[{ component4_xlink_title: "unpopulated", component5_xlink_title: "Pargi tn" }, "Pargi tn"],
		[{ component4_xlink_title: "Vahatu vkt", component5_xlink_title: "unpopulated" }, "Vahatu vkt"],
		[{ component4_xlink_title: "unpopulated", component5_xlink_title: "unpopulated" }, ""],
		[{}, ""],
	])("thoroughfareOf(%j) is %j", (properties, expected) => {
		expect(thoroughfareOf(properties)).toBe(expected)
	})
})
