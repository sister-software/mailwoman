import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import {
	WOF_ADMIN_ADAPTER_ID,
	createWOFAdminAdapter,
	nameSlotsFor,
	variantsFor,
} from "@mailwoman/corpus/adapters/wof/admin/json/adapter"
import { runAdapter } from "@mailwoman/corpus/runner"
import { readCanonicalRows, useScratchDir } from "@mailwoman/corpus/test-kit"
import { describe, expect, it } from "vitest"

const scratch = useScratchDir("wof-admin-json")

const loadRows = () => readCanonicalRows(scratch.path, WOF_ADMIN_ADAPTER_ID)

const fixtureRoot = workspacePath("corpus", "fixtures", "wof-admin-json")

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
		expect(v[1]!.components.region).toBe("Florida")
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
				["name:eng_x_preferred", "Saint Petersburg"],
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
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await loadRows()

		const stPete = rows.filter((r) => r.source_id.startsWith("wof-admin-1021-"))
		const stPeteRaws = stPete.map((r) => r.raw)
		expect(stPeteRaws.some((r) => r.includes("Saint Petersburg"))).toBe(true)
		expect(stPeteRaws.some((r) => r.includes("St. Petersburg"))).toBe(true)

		const slotKeys = new Set(stPete.map((r) => r.source_id.match(/^wof-admin-1021-(.+)-(?:self|with-[a-z-]+)$/)?.[1]))
		expect(slotKeys.has("default")).toBe(true)
		expect(slotKeys.has("name-eng-x-colloquial")).toBe(true)
	})

	it("Emits per-hierarchy variants for a vanilla locality (Portland without localized variants)", async () => {
		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await loadRows()
		const portland = rows.filter((r) => r.source_id.startsWith("wof-admin-1012-default-"))

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
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await loadRows()
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.every((r) => r.country === "FR")).toBe(true)
		expect(rows.every((r) => r.locale === "fr-FR")).toBe(true)
		expect(rows.every((r) => r.source === WOF_ADMIN_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.license === "CC0-1.0")).toBe(true)

		expect(rows.map((r) => r.raw)).toContain("Paris")
		expect(rows.map((r) => r.raw)).toContain("Paris, Île-de-France")
	})

	it("upper-cases a country code the publisher spelled in mixed case, and the filter still selects it", async () => {
		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "NL" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await loadRows()

		expect(rows.length).toBeGreaterThan(0)
		expect(rows.every((r) => r.country === "NL")).toBe(true)
		expect(rows.map((r) => r.raw)).toContain("Friesland")
	})

	it("treats mz:is_current=-1 as live (Pelias convention) and mz:is_current=0 as superseded", async () => {
		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await loadRows()

		expect(rows.some((r) => r.source_id.startsWith("wof-admin-1001-"))).toBe(true)

		expect(rows.some((r) => r.raw.includes("Old Place"))).toBe(false)
	})

	it("skips -alt-*.geojson sibling files (alternate-geometry exports, not separate records)", async () => {
		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await loadRows()

		expect(rows.some((r) => r.raw.includes("alt-geometry"))).toBe(false)
	})

	it("honors --limit", async () => {
		const manifest = await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, limit: 4 },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(4)
		expect(manifest.written).toBeLessThanOrEqual(4)
	})

	it("two runs over the same fixture produce identical sha256 (sorted-id emission)", async () => {
		const a = await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "FR" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		await removePathIfPresent(scratch.path(WOF_ADMIN_ADAPTER_ID))

		const b = await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "FR" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(a.sha256).toBe(b.sha256)
	})

	it("country record uses OpenCage-canonical 'United States of America' for the default slot", async () => {
		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: fixtureRoot, country: "US" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await loadRows()
		const usDefault = rows.find((r) => r.source_id === "wof-admin-1001-default-self")
		expect(usDefault?.raw).toContain("United States of America")

		const colloquialRaws = rows
			.filter((r) => r.source_id.startsWith("wof-admin-1001-name-eng-x-colloquial-"))
			.map((r) => r.raw)

		expect(colloquialRaws.length).toBeGreaterThan(0)
	})
})
