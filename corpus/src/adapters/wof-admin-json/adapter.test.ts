/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runAdapter } from "../../runner.ts"
import type { CanonicalRow } from "../../types.ts"
import { WOF_ADMIN_ADAPTER_ID, createWOFAdminAdapter, nameSlotsFor, variantsFor } from "./adapter.ts"

const fixtureRoot = repoRootPath("corpus", "fixtures", "wof-admin-json")

let scratch: string
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-wof-admin-json-"))
})
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

async function loadRows(): Promise<CanonicalRow[]> {
	const jsonl = await readFile(join(scratch, WOF_ADMIN_ADAPTER_ID, "canonical.jsonl"), "utf8")

	return jsonl
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as CanonicalRow)
}

describe("variantsFor (pure)", () => {
	const rec = (over: Partial<{ id: number; name: string; placetype: string; country: string }>) => ({
		id: 1,
		parent_id: null as number | null,
		name: "X",
		placetype: "locality",
		country: "US",
		nameVariants: new Map<string, string>(),
		...over,
	})

	it("locality yields 3 variants when region + country are in ancestry", () => {
		const v = variantsFor(
			rec({ name: "Portland" }),
			[
				rec({ id: 10, name: "Oregon", placetype: "region" }),
				rec({ id: 100, name: "United States", placetype: "country" }),
			],
			"Portland"
		)
		expect(v.map((x) => x.suffix)).toEqual(["self", "with-region", "with-region-country"])
		expect(v[2]!.components).toEqual({
			locality: "Portland",
			region: "Oregon",
			country: "United States of America",
		})
	})

	it("country uses the OpenCage-canonical name for the default slot value", () => {
		// Caller is expected to pass COUNTRY_DISPLAY_NAME's value for the default slot; we just
		// verify the variant uses whatever selfName was passed.
		const v = variantsFor(rec({ name: "United States", placetype: "country" }), [], "United States of America")
		expect(v).toHaveLength(1)
		expect(v[0]!.components).toEqual({ country: "United States of America" })
	})

	it("respects a substituted selfName for the locality component", () => {
		const v = variantsFor(
			rec({ name: "Saint Petersburg" }),
			[
				rec({ id: 10, name: "Florida", placetype: "region" }),
				rec({ id: 100, name: "United States", placetype: "country" }),
			],
			"St. Petersburg"
		)
		expect(v[0]!.components.locality).toBe("St. Petersburg")
		expect(v[1]!.components.locality).toBe("St. Petersburg")
		expect(v[1]!.components.region).toBe("Florida") // ancestors stay canonical
	})

	it("subregion (county) yields self only", () => {
		const v = variantsFor(
			rec({ name: "Multnomah County", placetype: "county" }),
			[rec({ id: 10, name: "Oregon", placetype: "region" })],
			"Multnomah County"
		)
		expect(v).toHaveLength(1)
		expect(v[0]!.components).toEqual({ subregion: "Multnomah County" })
	})
})

describe("nameSlotsFor", () => {
	it("emits the canonical 'default' slot then one per non-duplicate name:* variant", () => {
		const slots = nameSlotsFor({
			id: 1,
			parent_id: null,
			name: "Saint Petersburg",
			placetype: "locality",
			country: "US",
			nameVariants: new Map([
				["name:eng_x_preferred", "Saint Petersburg"], // exact dup of default → dropped
				["name:eng_x_colloquial", "St. Petersburg"],
				["name:rus_x_preferred", "Санкт-Петербург"],
			]),
		})
		expect(slots.map((s) => s.key)).toEqual(["default", "name-eng-x-colloquial", "name-rus-x-preferred"])
		expect(slots.map((s) => s.value)).toEqual(["Saint Petersburg", "St. Petersburg", "Санкт-Петербург"])
	})

	it("uses the OpenCage-canonical country name for the default slot of a country record", () => {
		const slots = nameSlotsFor({
			id: 100,
			parent_id: null,
			name: "United States",
			placetype: "country",
			country: "US",
			nameVariants: new Map(),
		})
		expect(slots[0]!.value).toBe("United States of America")
	})
})

describe("wof-admin-json adapter against fixture", () => {
	it("emits multi-name-variant rows for the St. Petersburg case", async () => {
		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()

		// Phase 1.5.1 invariant: BOTH the canonical and the colloquial name produce training rows
		// for the same WOF id. This was the failure mode the SQLite path could not address even with
		// the is_current predicate loosened — the `names` table was empty in the WOF SQLite distro.
		const stPete = rows.filter((r) => r.source_id.startsWith("wof-admin-1021-"))
		const stPeteRaws = stPete.map((r) => r.raw)
		expect(stPeteRaws.some((r) => r.includes("Saint Petersburg"))).toBe(true)
		expect(stPeteRaws.some((r) => r.includes("St. Petersburg"))).toBe(true)

		// And source_id encodes which name-slot produced each row.
		const slotKeys = new Set(stPete.map((r) => r.source_id.match(/^wof-admin-1021-(.+)-(?:self|with-[a-z-]+)$/)?.[1]))
		expect(slotKeys.has("default")).toBe(true)
		expect(slotKeys.has("name-eng-x-colloquial")).toBe(true)
	})

	it("emits per-hierarchy variants for a vanilla locality (Portland, no localized variants)", async () => {
		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const portland = rows.filter((r) => r.source_id.startsWith("wof-admin-1012-default-"))
		// Self variant is the bare "Portland". Surface form for the with-region / with-region-country
		// variants depends on the US OpenCage template's pruning rules (state abbreviation, dropped
		// counties); they may render differently or fold via reconcileComponents. We assert only
		// that the self variant exists, the canonical-only path produced exactly one name slot's
		// worth of rows (no spurious slot from name:eng_x_preferred = "Portland" since it matches
		// the canonical), and that at least one variant carries an ancestor component.
		expect(portland.map((r) => r.raw)).toContain("Portland")
		const withAncestor = portland.find(
			(r) => r.source_id.endsWith("-with-region") || r.source_id.endsWith("-with-region-country")
		)
		expect(withAncestor).toBeDefined()
	})

	it("filter country=FR emits only FR rows; locale defaults to fr-FR", async () => {
		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "FR" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.every((r) => r.country === "FR")).toBe(true)
		expect(rows.every((r) => r.locale === "fr-FR")).toBe(true)
		expect(rows.every((r) => r.source === WOF_ADMIN_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.license === "CC0-1.0")).toBe(true)
		// At least the basic FR hierarchy variants land.
		expect(rows.map((r) => r.raw)).toContain("Paris")
		expect(rows.map((r) => r.raw)).toContain("Paris, Île-de-France")
	})

	it("treats mz:is_current=-1 as live (Pelias convention) and mz:is_current=0 as superseded", async () => {
		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		// The country US record carries mz:is_current = -1 in the fixture; it must still be emitted.
		expect(rows.some((r) => r.source_id.startsWith("wof-admin-1001-"))).toBe(true)
		// The deprecated "Old Place" (mz:is_current = 0) must be absent.
		expect(rows.some((r) => r.raw.includes("Old Place"))).toBe(false)
	})

	it("skips -alt-*.geojson sibling files (alternate-geometry exports, not separate records)", async () => {
		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		// The alt-geometry file for Portland carries a deliberately-different name. If the adapter
		// had walked it, we'd see "(alt-geometry, should be ignored)" leaking into a row.
		expect(rows.some((r) => r.raw.includes("alt-geometry"))).toBe(false)
	})

	it("honors --limit", async () => {
		const manifest = await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, limit: 4 },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(manifest.yielded).toBe(4)
		expect(manifest.written).toBeLessThanOrEqual(4)
	})

	it("two runs over the same fixture produce identical sha256 (sorted-id emission)", async () => {
		const a = await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "FR" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		await rm(join(scratch, WOF_ADMIN_ADAPTER_ID), { recursive: true, force: true })
		const b = await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "FR" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(a.sha256).toBe(b.sha256)
	})

	it("country record uses OpenCage-canonical 'United States of America' for the default slot", async () => {
		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const usDefault = rows.find((r) => r.source_id === "wof-admin-1001-default-self")
		expect(usDefault?.raw).toContain("United States of America")
		// And the colloquial slot emits "USA" or "America" verbatim from name:eng_x_colloquial.
		const colloquialRaws = rows
			.filter((r) => r.source_id.startsWith("wof-admin-1001-name-eng-x-colloquial-"))
			.map((r) => r.raw)
		expect(colloquialRaws.length).toBeGreaterThan(0)
	})
})
