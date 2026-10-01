/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { countryOfMunicipality, createMatrikkelenAdapter, MATRIKKELEN_ADAPTER_ID } from "#adapters/matrikkelen/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("matrikkelen")

const fixtureCSV = workspacePath("corpus", "fixtures", "matrikkelen", "sample.csv")

describe("matrikkelen adapter against fixture sample.csv", () => {
	it("emits a row per street address under Kartverket's CC BY 4.0", async () => {
		const manifest = await runAdapter({
			adapter: createMatrikkelenAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		// Nine records: one `matrikkeladresse` carries no street and the Øvregaten row carries
		// no house number, which is kept because a street with a postcode still aligns.
		expect(manifest.yielded).toBe(8)

		const rows = await readCanonicalRows(scratch.path, MATRIKKELEN_ADAPTER_ID)

		expect(rows).toHaveLength(8)
		expect(rows.every((r) => r.license === "CC-BY-4.0")).toBe(true)
		expect(rows.every((r) => r.source === MATRIKKELEN_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.locale === `nb-${r.country}`)).toBe(true)
	})

	it("reads Svalbard as its own jurisdiction from the municipality number", async () => {
		await runAdapter({
			adapter: createMatrikkelenAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await readCanonicalRows(scratch.path, MATRIKKELEN_ADAPTER_ID)
		const byCountry = new Map<string, number>()

		for (const row of rows) {
			byCountry.set(row.country, (byCountry.get(row.country) ?? 0) + 1)
		}

		expect(Object.fromEntries(byCountry)).toEqual({ NO: 5, SJ: 3 })
	})

	it.each([
		["2100", "SJ"],
		["0301", "NO"],
		["4601", "NO"],
		["5001", "NO"],
		["1103", "NO"],
		["", "NO"],
	])("countryOfMunicipality(%s) is %s", (code, expected) => {
		expect(countryOfMunicipality(code)).toBe(expected)
	})

	it("joins the house number to the letter that follows it", async () => {
		await runAdapter({
			adapter: createMatrikkelenAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await readCanonicalRows(scratch.path, MATRIKKELEN_ADAPTER_ID)
		const lettered = rows.find((r) => r.components.house_number === "31B")

		expect(lettered?.raw).toBe("Karl Johans gate 31B, 0159 OSLO")
	})

	it("drops a cadastral address, which carries a holding number where a street would be", async () => {
		await runAdapter({
			adapter: createMatrikkelenAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await readCanonicalRows(scratch.path, MATRIKKELEN_ADAPTER_ID)

		expect(rows.some((r) => r.raw.includes("Øvrabø"))).toBe(false)
	})

	it("keeps only the named jurisdiction's rows when --country is given", async () => {
		const manifest = await runAdapter({
			adapter: createMatrikkelenAdapter(),
			adapterOptions: { inputPath: fixtureCSV, country: "SJ" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(3)

		const rows = await readCanonicalRows(scratch.path, MATRIKKELEN_ADAPTER_ID)

		expect(rows.every((r) => r.country === "SJ")).toBe(true)
		expect(rows.every((r) => r.components.postcode === "9170")).toBe(true)

		// Longyearbyen numbers its streets rather than naming them.
		expect(rows.map((r) => r.raw).toSorted()).toEqual([
			"Vei 223 8, 9170 LONGYEARBYEN",
			"Vei 500 1, 9170 LONGYEARBYEN",
			"Vei 608 7, 9170 LONGYEARBYEN",
		])
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		await expect(
			runAdapter({
				adapter: createMatrikkelenAdapter(),
				adapterOptions: { inputPath: fixtureCSV, country: "SE" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/the dataset covers NO, SJ/)
	})

	it("source_id uses Kartverket's own address id", async () => {
		await runAdapter({
			adapter: createMatrikkelenAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await readCanonicalRows(scratch.path, MATRIKKELEN_ADAPTER_ID)

		expect(rows[0]!.source_id).toBe("matrikkelen-1001")
	})

	it("two runs over the same CSV produce identical sha256", async () => {
		const a = await runAdapter({
			adapter: createMatrikkelenAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		await removePathIfPresent(scratch.path(MATRIKKELEN_ADAPTER_ID))

		const b = await runAdapter({
			adapter: createMatrikkelenAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(a.sha256).toBe(b.sha256)
	})
})
