/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { createSynthPoBoxAdapter, SYNTH_PO_BOX_ADAPTER_ID } from "./adapter.js"

function writeFixture(rows: Array<Record<string, unknown>>): string {
	const path = join(tmpdir(), `synth-po-box-fixture-${Math.random().toString(36).slice(2)}.jsonl`)
	writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")

	return path
}

async function collect(path: string, adapter = createSynthPoBoxAdapter({ seed: 42 })) {
	const out = []

	for await (const row of adapter.rows({ inputPath: path })) {
		out.push(row)
	}

	return out
}

describe("synth-po-box adapter", () => {
	it("emits one row per input by default", async () => {
		const path = writeFixture([
			{ locality: "Burlington", region: "VT", postcode: "05401", country: "US" },
			{ locality: "Paris", region: "Île-de-France", postcode: "75001", country: "FR" },
		])
		const rows = await collect(path)
		expect(rows).toHaveLength(2)
		expect(rows[0]!.source).toBe(SYNTH_PO_BOX_ADAPTER_ID)
	})

	it("US row produces en-US po_box variant", async () => {
		const path = writeFixture([{ locality: "Burlington", region: "VT", postcode: "05401", country: "US" }])
		const rows = await collect(path)
		expect(rows[0]!.locale).toBe("en-US")
		expect(rows[0]!.components.po_box).toMatch(/^(PO Box|P\.O\. Box|P\.O\.Box|PO BOX|POB|Post Office Box|Box) /)
		expect(rows[0]!.components.street).toBeUndefined()
		expect(rows[0]!.components.house_number).toBeUndefined()
	})

	it("FR row produces fr-FR BP variant", async () => {
		const path = writeFixture([{ locality: "Lyon", region: "Auvergne-Rhône-Alpes", postcode: "69001", country: "FR" }])
		const rows = await collect(path)
		expect(rows[0]!.locale).toBe("fr-FR")
		expect(rows[0]!.components.po_box).toMatch(/^(BP|B\.P\.|Boîte Postale|BP\.) /)
	})

	it("skips rows missing required fields", async () => {
		const path = writeFixture([
			{ locality: "OK", region: "VT", postcode: "05401", country: "US" }, // valid
			{ locality: "Missing postcode", region: "VT", country: "US" }, // invalid
			{ region: "VT", postcode: "05401", country: "US" }, // invalid (no locality)
		])
		const rows = await collect(path)
		expect(rows).toHaveLength(1)
	})

	it("country filter — only emits matching tuples", async () => {
		const path = writeFixture([
			{ locality: "A", region: "VT", postcode: "05401", country: "US" },
			{ locality: "B", region: "Île-de-France", postcode: "75001", country: "FR" },
			{ locality: "C", region: "CA", postcode: "94133", country: "US" },
		])
		const adapter = createSynthPoBoxAdapter({ seed: 7 })
		const rows = []

		for await (const row of adapter.rows({ inputPath: path, country: "FR" })) {
			rows.push(row)
		}
		expect(rows).toHaveLength(1)
		expect(rows[0]!.locale).toBe("fr-FR")
		expect(rows[0]!.country).toBe("FR")
	})

	it("variantsPerInput emits multiple variants per input", async () => {
		const path = writeFixture([{ locality: "Burlington", region: "VT", postcode: "05401", country: "US" }])
		const adapter = createSynthPoBoxAdapter({ seed: 42, variantsPerInput: 5 })
		const rows = []

		for await (const row of adapter.rows({ inputPath: path })) {
			rows.push(row)
		}
		expect(rows).toHaveLength(5)
		// At least 2 unique raw strings out of 5 (with seed=42, leader selection varies)
		const unique = new Set(rows.map((r) => r.raw))
		expect(unique.size).toBeGreaterThanOrEqual(2)
	})

	it("PMB variant with pmbRatio=1.0 keeps street and adds PMB span", async () => {
		const path = writeFixture([
			{
				locality: "New York",
				region: "NY",
				postcode: "10001",
				country: "US",
				street: "Main St",
				houseNumber: "100",
			},
		])
		const adapter = createSynthPoBoxAdapter({ seed: 99, pmbRatio: 1.0 })
		const rows = await collect(path, adapter)
		expect(rows[0]!.components.street).toBe("Main St")
		expect(rows[0]!.components.house_number).toBe("100")
		expect(rows[0]!.components.po_box).toMatch(/^(PMB|#) /)
	})

	it("limit option caps output", async () => {
		const path = writeFixture(
			Array.from({ length: 10 }, (_, i) => ({
				locality: `City${i}`,
				region: "VT",
				postcode: "05401",
				country: "US",
			}))
		)
		const adapter = createSynthPoBoxAdapter({ seed: 1 })
		const rows = []

		for await (const row of adapter.rows({ inputPath: path, limit: 3 })) {
			rows.push(row)
		}
		expect(rows).toHaveLength(3)
	})

	it("each row gets a stable, unique source_id", async () => {
		const path = writeFixture([
			{ locality: "A", region: "VT", postcode: "05401", country: "US" },
			{ locality: "B", region: "VT", postcode: "05402", country: "US" },
		])
		const rows = await collect(path)
		const ids = new Set(rows.map((r) => r.source_id))
		expect(ids.size).toBe(2)
		expect([...ids].every((id) => id.startsWith(SYNTH_PO_BOX_ADAPTER_ID + "-"))).toBe(true)
	})

	it("militaryRatio emits a US military/diplomatic PO-box row per input (#517)", async () => {
		const path = writeFixture([{ locality: "Burlington", region: "VT", postcode: "05401", country: "US" }])
		const adapter = createSynthPoBoxAdapter({ seed: 42, militaryRatio: 1.0 })
		const rows = await collect(path, adapter)
		// One standard po_box row + one self-contained military row.
		expect(rows).toHaveLength(2)
		const mil = rows.find((r) => /^(PSC|CMR|Unit) /.test(String(r.components.po_box)))
		expect(mil).toBeDefined()
		expect(["APO", "FPO", "DPO"]).toContain(mil!.components.locality)
		expect(["AA", "AE", "AP"]).toContain(mil!.components.region)
		expect(mil!.country).toBe("US")
		expect(mil!.locale).toBe("en-US")
	})

	it("militaryRatio defaults off — byte-stable (one row per input, no military)", async () => {
		const path = writeFixture([{ locality: "Burlington", region: "VT", postcode: "05401", country: "US" }])
		const rows = await collect(path)
		expect(rows).toHaveLength(1)
		expect(/^(PSC|CMR|Unit) /.test(String(rows[0]!.components.po_box))).toBe(false)
	})

	it("emits region-less NZ tuples — Private Bag / Box, no region token (#517)", async () => {
		const path = writeFixture([{ locality: "Auckland", region: "", postcode: "1010", country: "NZ" }])
		const rows = await collect(path)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.locale).toBe("en-NZ")
		expect(rows[0]!.components.po_box).toMatch(/^(PO Box|P\.O\. Box|Post Office Box|Private Bag|Private Box) /)
		expect(rows[0]!.components.region).toBeUndefined()
		expect(rows[0]!.country).toBe("NZ")
	})

	it("military rows are US-only — suppressed under a non-US country filter", async () => {
		const path = writeFixture([{ locality: "Lyon", region: "Auvergne-Rhône-Alpes", postcode: "69001", country: "FR" }])
		const adapter = createSynthPoBoxAdapter({ seed: 5, militaryRatio: 1.0 })
		const rows = []

		for await (const row of adapter.rows({ inputPath: path, country: "FR" })) rows.push(row)
		expect(rows.length).toBeGreaterThanOrEqual(1)
		expect(rows.every((r) => !/^(PSC|CMR|Unit) /.test(String(r.components.po_box)))).toBe(true)
	})
})
