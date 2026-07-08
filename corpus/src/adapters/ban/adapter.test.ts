/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { repoRootPathBuilder } from "@mailwoman/core/utils"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runAdapter } from "../../runner.js"
import type { CanonicalRow } from "../../types.js"
import { BAN_ADAPTER_ID, createBanAdapter } from "./adapter.js"

const fixtureCSV = String(repoRootPathBuilder("corpus", "fixtures", "ban", "sample.csv"))

let scratch: string
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-ban-"))
})
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("ban adapter against fixture sample.csv", () => {
	it("emits a row per CSV record with FR country + Licence Ouverte (the elected BAN license, #26)", async () => {
		const manifest = await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(manifest.yielded).toBe(7)
		const jsonl = await readFile(join(scratch, BAN_ADAPTER_ID, "canonical.jsonl"), "utf8")
		const rows = jsonl
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as CanonicalRow)
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
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const jsonl = await readFile(join(scratch, BAN_ADAPTER_ID, "canonical.jsonl"), "utf8")
		const rows = jsonl
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as CanonicalRow)

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
				outputDir: scratch,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/only FR supported/)
	})

	it("honors --limit", async () => {
		const manifest = await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV, limit: 2 },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(manifest.yielded).toBe(2)
		expect(manifest.written).toBe(2)
	})

	it("source_id uses BAN's native id (deterministic)", async () => {
		await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const jsonl = await readFile(join(scratch, BAN_ADAPTER_ID, "canonical.jsonl"), "utf8")
		const rows = jsonl
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as CanonicalRow)
		expect(rows[0]!.source_id).toBe("ban-75108_0001_00001")
	})

	it("two runs over the same CSV produce identical sha256", async () => {
		const a = await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		await rm(join(scratch, BAN_ADAPTER_ID), { recursive: true, force: true })
		const b = await runAdapter({
			adapter: createBanAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(a.sha256).toBe(b.sha256)
	})
})
