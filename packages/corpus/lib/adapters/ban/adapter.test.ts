/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { BAN_ADAPTER_ID, countryOfInseeCode, createBanAdapter } from "#adapters/ban/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("ban")

const fixtureCSV = workspacePath("corpus", "fixtures", "ban", "sample.csv")

describe("ban adapter against fixture sample.csv", () => {
	it("emits a row per CSV record under Licence Ouverte (the elected BAN license, #26)", async () => {
		const manifest = await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		// The fixture holds 18 records and the Pirae row carries no `nom_voie`, which the
		// street check drops, as it drops 958 of French Polynesia's 7,713 published rows.
		expect(manifest.yielded).toBe(17)

		const rows = await readCanonicalRows(scratch.path, BAN_ADAPTER_ID)

		expect(rows).toHaveLength(17)
		expect(rows.every((r) => r.license === "Licence Ouverte 2.0")).toBe(true)
		expect(rows.every((r) => r.source === BAN_ADAPTER_ID)).toBe(true)
		// One language across every jurisdiction, with the region carrying the jurisdiction.
		expect(rows.every((r) => r.locale === `fr-${r.country}`)).toBe(true)
	})

	it("reads each row's country from its INSEE commune code", async () => {
		await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await readCanonicalRows(scratch.path, BAN_ADAPTER_ID)
		const byCountry = new Map<string, number>()

		for (const row of rows) {
			byCountry.set(row.country, (byCountry.get(row.country) ?? 0) + 1)
		}

		expect(Object.fromEntries(byCountry)).toEqual({
			FR: 7,
			GP: 1,
			MQ: 1,
			GF: 1,
			RE: 1,
			PM: 1,
			YT: 1,
			BL: 1,
			MF: 1,
			PF: 1,
			NC: 1,
		})
	})

	it.each([
		["97123", "GP"],
		["97216", "MQ"],
		["97390", "GF"],
		["97412", "RE"],
		["97501", "PM"],
		["97630", "YT"],
		["97701", "BL"],
		["97801", "MF"],
		["984", "TF"],
		["986", "WF"],
		["98735", "PF"],
		["98825", "NC"],
		// A metropolitan department is two characters, Corsica's included, and neither reads as overseas.
		["75101", "FR"],
		["2A004", "FR"],
		// Clipperton has no ISO 3166-1 alpha-2 code, so `989` stays metropolitan rather than guessing.
		["98901", "FR"],
		["", "FR"],
	])("countryOfInseeCode(%s) is %s", (code, expected) => {
		expect(countryOfInseeCode(code)).toBe(expected)
	})

	it("keeps only the named jurisdiction's rows when --country is given", async () => {
		const manifest = await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV, country: "GP" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(1)

		const rows = await readCanonicalRows(scratch.path, BAN_ADAPTER_ID)

		expect(rows[0]!.country).toBe("GP")
		expect(rows[0]!.locale).toBe("fr-GP")
		expect(rows[0]!.raw).toBe("202 Chemin de Bois Rimbault, 97123 Baillif")
	})

	it("composes the canonical FR raw line", async () => {
		await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await readCanonicalRows(scratch.path, BAN_ADAPTER_ID)

		const rivoli = rows.find((r) => r.raw.includes("Rivoli") && r.components.house_number === "1")
		expect(rivoli?.raw).toBe("1 Rue de Rivoli, 75001 Paris")

		expect(rivoli?.components).toEqual({
			house_number: "1",
			street_prefix: "Rue",
			street: "de Rivoli",
			postcode: "75001",
			locality: "Paris",
		})

		const champs = rows.find((r) => r.raw.includes("Champs"))
		expect(champs?.raw).toBe("1 bis Avenue des Champs-Élysées, 75008 Paris")
		expect(champs?.components.house_number).toBe("1 bis")
	})

	it("rejects a jurisdiction BAN does not publish", async () => {
		await expect(
			runAdapter({
				adapter: createBanAdapter(),
				adapterOptions: { inputPath: fixtureCSV, country: "US" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/BAN publishes FR, GP/)
	})

	it("honors --limit", async () => {
		const manifest = await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV, limit: 2 },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(2)
		expect(manifest.written).toBe(2)
	})

	it("source_id uses BAN's native id (deterministic)", async () => {
		await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await readCanonicalRows(scratch.path, BAN_ADAPTER_ID)

		expect(rows[0]!.source_id).toBe("ban-75108_0001_00001")
	})

	it("two runs over the same CSV produce identical sha256", async () => {
		const a = await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		await removePathIfPresent(scratch.path(BAN_ADAPTER_ID))

		const b = await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(a.sha256).toBe(b.sha256)
	})
})
