/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { rm } from "node:fs/promises"
import { join } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

import { readCanonicalRows, useScratchDir } from "../../../test-kit/index.ts"
import { runAdapter } from "../../runner.ts"
import { BAN_ADAPTER_ID, createBanAdapter } from "./adapter.ts"

const scratch = useScratchDir("ban")

const fixtureCSV = repoRootPath("corpus", "fixtures", "ban", "sample.csv")

describe("ban adapter against fixture sample.csv", () => {
	it("emits a row per CSV record with FR country + Licence Ouverte (the elected BAN license, #26)", async () => {
		const manifest = await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(7)

		const rows = await readCanonicalRows(scratch.path, BAN_ADAPTER_ID)

		expect(rows).toHaveLength(7)
		expect(rows.every((r) => r.country === "FR")).toBe(true)
		expect(rows.every((r) => r.locale === "fr-FR")).toBe(true)
		expect(rows.every((r) => r.license === "Licence Ouverte 2.0")).toBe(true)
		expect(rows.every((r) => r.source === BAN_ADAPTER_ID)).toBe(true)
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

	it("rejects non-FR --country", async () => {
		await expect(
			runAdapter({
				adapter: createBanAdapter(),
				adapterOptions: { inputPath: fixtureCSV, country: "US" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/only FR supported/)
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

		await rm(join(scratch.path, BAN_ADAPTER_ID), { recursive: true, force: true })

		const b = await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(a.sha256).toBe(b.sha256)
	})
})
