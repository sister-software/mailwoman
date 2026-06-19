/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runAdapter } from "../../runner.js"
import type { CanonicalRow } from "../../types.js"
import { OVERTURE_ADAPTER_ID, OVERTURE_DEFAULT_LICENSE, createOvertureAdapter } from "./adapter.js"

let scratch: string
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-ov-"))
})
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

/** Write a per-country Overture corpus JSONL fixture (the shape `ingest-overture-addresses.ts
--corpus-jsonl` emits). */
async function writeFixture(rows: Record<string, unknown>[]): Promise<string> {
	const p = join(scratch, "overture-es.corpus.jsonl")
	await writeFile(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")
	return p
}

async function loadRows(): Promise<CanonicalRow[]> {
	const jsonl = await readFile(join(scratch, OVERTURE_ADAPTER_ID, "canonical.jsonl"), "utf8")
	return jsonl
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as CanonicalRow)
}

const ES = [
	{ street: "CALLE JULAN", number: "12", unit: null, postcode: "38914", locality: "El Pinar de El Hierro" },
	{ street: "CALLE HIBRONES", number: "S-N", unit: null, postcode: "38914", locality: "El Pinar de El Hierro" },
	{ street: "AVENIDA DE LA CONSTITUCION", number: "3", unit: "2A", postcode: "28013", locality: "Madrid" },
]

describe("overture adapter", () => {
	it("emits a row per JSONL line, stamping country from --country and source=overture", async () => {
		const input = await writeFixture(ES)
		const manifest = await runAdapter({
			adapter: createOvertureAdapter(),
			adapterOptions: { inputPath: input, country: "ES" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(manifest.yielded).toBe(3)
		const rows = await loadRows()
		expect(rows).toHaveLength(3)
		expect(rows.every((r) => r.country === "ES")).toBe(true)
		expect(rows.every((r) => r.source === OVERTURE_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.license === OVERTURE_DEFAULT_LICENSE)).toBe(true)
	})

	it("keeps the street keyword WHOLE (affix-relabel splits the prefix downstream)", async () => {
		const input = await writeFixture(ES)
		await runAdapter({
			adapter: createOvertureAdapter(),
			adapterOptions: { inputPath: input, country: "ES" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const julan = rows.find((r) => r.raw.includes("CALLE JULAN"))
		expect(julan?.components).toMatchObject({
			house_number: "12",
			street: "CALLE JULAN",
			postcode: "38914",
			locality: "El Pinar de El Hierro",
		})
		expect(julan?.raw).toContain("38914")
		expect(julan?.raw).toContain("El Pinar de El Hierro")
		// street_prefix is NOT split here — that's the downstream affix-relabel's job.
		expect(julan?.components.street_prefix).toBeUndefined()
	})

	it("treats 'S-N' / 'S/N' (sin número) as no house number", async () => {
		const input = await writeFixture(ES)
		await runAdapter({
			adapter: createOvertureAdapter(),
			adapterOptions: { inputPath: input, country: "ES" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const sinNumero = (await loadRows()).find((r) => r.raw.includes("CALLE HIBRONES"))
		expect(sinNumero?.components.house_number).toBeUndefined()
		expect(sinNumero?.raw).not.toContain("S-N")
	})

	it("includes unit when present", async () => {
		const input = await writeFixture(ES)
		await runAdapter({
			adapter: createOvertureAdapter(),
			adapterOptions: { inputPath: input, country: "ES" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const madrid = (await loadRows()).find((r) => r.raw.includes("Madrid"))
		expect(madrid?.components.unit).toBe("2A")
	})

	it("rejects an invocation without --country", async () => {
		const input = await writeFixture(ES)
		await expect(
			runAdapter({
				adapter: createOvertureAdapter(),
				adapterOptions: { inputPath: input },
				outputDir: scratch,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/--country is required/)
	})

	it("honors --limit", async () => {
		const input = await writeFixture(ES)
		const manifest = await runAdapter({
			adapter: createOvertureAdapter(),
			adapterOptions: { inputPath: input, country: "ES", limit: 2 },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(manifest.yielded).toBe(2)
	})

	it("skips blanks, comments, garbage, and street-less rows", async () => {
		const p = join(scratch, "messy.jsonl")
		await writeFile(
			p,
			[
				"",
				"# comment",
				"{not json}",
				JSON.stringify({ postcode: "28013", locality: "Madrid" }), // no street → skip
				JSON.stringify({ street: "PLAZA MAYOR", number: "1", postcode: "28012", locality: "Madrid" }),
				"",
			].join("\n") + "\n",
			"utf8"
		)
		const manifest = await runAdapter({
			adapter: createOvertureAdapter(),
			adapterOptions: { inputPath: p, country: "ES" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(manifest.yielded).toBe(1)
		expect((await loadRows())[0]?.components.street).toBe("PLAZA MAYOR")
	})

	it("two runs over the same dump produce identical sha256", async () => {
		const input = await writeFixture(ES)
		const a = await runAdapter({
			adapter: createOvertureAdapter(),
			adapterOptions: { inputPath: input, country: "ES" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		await rm(join(scratch, OVERTURE_ADAPTER_ID), { recursive: true, force: true })
		const b = await runAdapter({
			adapter: createOvertureAdapter(),
			adapterOptions: { inputPath: input, country: "ES" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(a.sha256).toBe(b.sha256)
	})
})
