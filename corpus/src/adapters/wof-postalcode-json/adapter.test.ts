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
import { WOF_POSTALCODE_ADAPTER_ID, createWOFPostalcodeAdapter, postcodeVariantsFor } from "./adapter.js"

const fixtureRoot = String(repoRootPathBuilder("corpus", "fixtures", "wof-postalcode-json"))

let scratch: string
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-wof-postalcode-json-"))
})
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

async function loadRows(): Promise<CanonicalRow[]> {
	const jsonl = await readFile(join(scratch, WOF_POSTALCODE_ADAPTER_ID, "canonical.jsonl"), "utf8")

	return jsonl
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as CanonicalRow)
}

describe("postcodeVariantsFor (pure)", () => {
	const rec = (over: Partial<{ id: number; name: string; placetype: string; country: string }>) => ({
		id: 1,
		parent_id: null as number | null,
		name: "X",
		placetype: "postalcode",
		country: "US",
		nameVariants: new Map<string, string>(),
		...over,
	})

	it("postcode with full ancestry yields 4 variants", () => {
		const v = postcodeVariantsFor(
			rec({ name: "97214" }),
			[
				rec({ id: 10, name: "Portland", placetype: "locality" }),
				rec({ id: 20, name: "Oregon", placetype: "region" }),
				rec({ id: 30, name: "United States", placetype: "country" }),
			],
			"97214"
		)
		expect(v.map((x) => x.suffix)).toEqual([
			"self",
			"with-locality",
			"with-locality-region",
			"with-locality-region-country",
		])
		expect(v[3]!.components).toEqual({
			postcode: "97214",
			locality: "Portland",
			region: "Oregon",
			country: "United States of America",
		})
	})

	it("postcode without locality yields self only", () => {
		const v = postcodeVariantsFor(rec({ name: "12345" }), [], "12345")
		expect(v).toHaveLength(1)
		expect(v[0]!.components).toEqual({ postcode: "12345" })
	})

	it("skips non-postcode placetypes", () => {
		const v = postcodeVariantsFor(rec({ placetype: "locality" }), [], "X")
		expect(v).toEqual([])
	})
})

describe("wof-postalcode-json adapter against fixture", () => {
	it("resolves admin ancestry from sibling repo dirs in the same walk", async () => {
		await runAdapter({
			adapter: createWOFPostalcodeAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "FR" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows.length).toBeGreaterThan(0)
		// The FR template drops region (encoded in postcode) and emits "75008 Paris, France".
		// Reconciliation drops region from components because it isn't in raw.
		const parisFull = rows.find(
			(r) => r.components.postcode === "75008" && r.components.locality === "Paris" && r.components.country === "France"
		)
		expect(parisFull).toBeDefined()
		expect(parisFull!.raw).toMatch(/75008\s+Paris/)
		expect(parisFull!.raw).toContain("France")
		expect(parisFull!.components.region).toBeUndefined()
	})

	it("US template abbreviates state to alpha-2 and reconciliation prunes the region component", async () => {
		await runAdapter({
			adapter: createWOFPostalcodeAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const portlandUS = rows.find((r) => /Portland,\s+OR\s+97214/.test(r.raw))
		expect(portlandUS).toBeDefined()
		expect(portlandUS!.components.region).toBeUndefined()
		expect(portlandUS!.components.postcode).toBe("97214")
		expect(portlandUS!.components.locality).toBe("Portland")
	})

	it("locality ancestry handles a parent with name:* variants without leaking them into postcode emission", async () => {
		// Saint Petersburg (1021) has name:eng_x_colloquial=["St. Petersburg"]; one postcode (5003)
		// points at it. The postcode adapter currently uses canonical wof:name for ancestors
		// (cross-product with ancestor name variants is a future synthesis concern). Verify the
		// canonical-name behavior so a future change to localize ancestors is a deliberate decision.
		await runAdapter({
			adapter: createWOFPostalcodeAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const stPetePost = rows.filter((r) => r.source_id.startsWith("wof-postalcode-5003-"))
		expect(stPetePost.some((r) => r.components.locality === "Saint Petersburg")).toBe(true)
		// No "St. Petersburg" emitted from postcode adapter for this postcode.
		expect(stPetePost.every((r) => r.components.locality !== "St. Petersburg")).toBe(true)
	})

	it("excludes superseded postcodes (mz:is_current=0)", async () => {
		await runAdapter({
			adapter: createWOFPostalcodeAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows.some((r) => r.raw.includes("00000"))).toBe(false)
	})

	it("source_id includes the name-slot segment for consistency with the admin adapter", async () => {
		await runAdapter({
			adapter: createWOFPostalcodeAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "FR" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()

		// Every postcode row should be of the form wof-postalcode-<id>-<name-slot>-<hierarchy>.
		for (const row of rows) {
			expect(row.source_id).toMatch(/^wof-postalcode-\d+-(?:default|name-[a-z0-9-]+)-(?:self|with-[a-z-]+)$/)
		}
	})

	it("two runs over the same fixture produce identical sha256", async () => {
		const a = await runAdapter({
			adapter: createWOFPostalcodeAdapter(),
			adapterOptions: { inputPath: fixtureRoot },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		await rm(join(scratch, WOF_POSTALCODE_ADAPTER_ID), { recursive: true, force: true })
		const b = await runAdapter({
			adapter: createWOFPostalcodeAdapter(),
			adapterOptions: { inputPath: fixtureRoot },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(a.sha256).toBe(b.sha256)
	})
})
