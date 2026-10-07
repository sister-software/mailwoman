/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { createEMUiAAdapter, EMUIA_ADAPTER_ID, EMUIA_DEFAULT_LICENSE } from "#pl/adapters/emuia/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("emuia")

/**
 * Ten `ms:AD.Address` members of a real `GetFeature` page, retrieved 2026-10-02,
 * inside that page's own envelope.
 *
 * Five sit on a street with a name, including one `16/18` and one `17a`, and five sit
 * on a locality only, with an empty `ms:ulica`.
 * Only `numberReturned` was edited, from the page's 60 down to the ten kept,
 * so the document states its own contents.
 */
const fixtureGML = workspacePath("corpus", "fixtures", "emuia", "sample.xml")

async function run(options: { country?: string; limit?: number } = {}) {
	return runAdapter({
		adapter: createEMUiAAdapter(),
		adapterOptions: { inputPath: fixtureGML, ...options },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})
}

describe("emuia adapter against fixture sample.xml", () => {
	it("emits a row per member under the terms GUGiK states", async () => {
		const manifest = await run()

		expect(manifest.yielded).toBe(10)

		const rows = await readCanonicalRows(scratch.path, EMUIA_ADAPTER_ID)

		expect(rows).toHaveLength(10)
		expect(rows.every((r) => r.license === EMUIA_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((r) => r.source === EMUIA_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.country === "PL")).toBe(true)
		expect(rows.every((r) => r.locale === "pl-PL")).toBe(true)
	})

	it("reads the house number from ms:numer and the street from ms:ulica", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, EMUIA_ADAPTER_ID)
		const onStreet = rows.filter((r) => r.components.street !== undefined)

		expect(onStreet).toHaveLength(5)
		expect(onStreet.every((r) => r.components.street === "1 Maja")).toBe(true)
		expect(onStreet.map((r) => r.components.house_number).toSorted()).toEqual(["10", "11", "13", "16/18", "17a"])

		// The publisher's own `ms:adres` for this member reads `Piotrków Trybunalski 1 Maja 16/18`.
		expect(rows.find((r) => r.components.house_number === "16/18")?.raw).toBe(
			"1 Maja 16/18, 97-300 Piotrków Trybunalski"
		)
	})

	it("keeps a member with an empty ms:ulica, which is the publisher's ordinary rural row", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, EMUIA_ADAPTER_ID)
		const streetless = rows.filter((r) => r.components.street === undefined)

		expect(streetless).toHaveLength(5)
		expect(streetless.every((r) => typeof r.components.house_number === "string")).toBe(true)
		expect(streetless.every((r) => typeof r.components.locality === "string")).toBe(true)

		// `ms:adres` writes these as locality then number, and the rendered line holds the same two.
		expect(streetless.map((r) => r.raw).toSorted()).toEqual([
			"16A, 26-341 Olimpiów",
			"19, 26-341 Jawor",
			"25, 26-341 Mikułowice",
			"5, 05-282 Księżyki",
			"51A, 26-341 Strzelce",
		])
	})

	it("writes no empty column as a component", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, EMUIA_ADAPTER_ID)

		for (const row of rows) {
			expect(Object.values(row.components).every((value) => value.trim().length > 0)).toBe(true)
			// `ms:czescmiejscowosci` is written on every member and populated on none of the sample.
			expect(row.components.dependent_locality).toBeUndefined()
		}
	})

	it("source_id names the upstream municipal register record", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, EMUIA_ADAPTER_ID)

		expect(rows[0]!.source_id).toBe("emuia-PL.ZIPIN.3742.EMUiA_9945001100000172050")
		expect(rows.every((r) => r.source_id.includes("EMUiA_"))).toBe(true)
	})

	it("honors a limit", async () => {
		const manifest = await run({ limit: 3 })

		expect(manifest.yielded).toBe(3)
	})

	it("accepts the one jurisdiction the dataset covers", async () => {
		const manifest = await run({ country: "PL" })

		expect(manifest.yielded).toBe(10)
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		await expect(run({ country: "CZ" })).rejects.toThrow(/the dataset covers PL/)
	})

	it("two runs over the same file produce identical sha256", async () => {
		const a = await run()

		await removePathIfPresent(scratch.path(EMUIA_ADAPTER_ID))

		const b = await run()

		expect(a.sha256).toBe(b.sha256)
	})
})
