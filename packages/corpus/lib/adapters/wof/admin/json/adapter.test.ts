import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { isPresent } from "@mailwoman/core/objects"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import {
	WOF_ADMIN_ADAPTER_ID,
	createWOFAdminAdapter,
	layoutCountryForLanguage,
	nameSlotsFor,
	variantsFor,
} from "#adapters/wof/admin/json/adapter"
import type { NameSlot } from "#adapters/wof/json-rows"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"
import type { WOFRecord } from "#utils"

const scratch = useScratchDir("wof-admin-json")

const loadRows = () => readCanonicalRows(scratch.path, WOF_ADMIN_ADAPTER_ID)

const fixtureRoot = workspacePath("corpus", "fixtures", "wof-admin-json")

type TestRecord = WOFRecord

const rec = (over: Partial<TestRecord>): TestRecord => ({
	id: 1,
	parent_id: null,
	name: "X",
	placetype: "locality",
	country: "US",
	nameVariants: new Map(),
	ancestors: [],
	...over,
})

const slot = (value: string, language?: string): NameSlot =>
	language ? { key: "k", value, language } : { key: "k", value }

const newYorkCity = rec({
	id: 85_977_539,
	name: "New York",
	nameVariants: new Map([
		["name:jpn_x_preferred", "ニューヨーク"],
		["name:kor_x_preferred", "뉴욕"],
	]),
})

const newYorkState = rec({
	id: 85_688_543,
	name: "New York",
	placetype: "region",
	nameVariants: new Map([
		["name:jpn_x_preferred", "ニューヨーク州"],
		["name:kor_x_preferred", "뉴욕 주"],
	]),
})

const unitedStates = rec({
	id: 85_633_793,
	name: "United States",
	placetype: "country",
	nameVariants: new Map([["name:jpn_x_preferred", "アメリカ合衆国"]]),
})

describe("variantsFor (pure)", () => {
	it("locality yields 3 variants when region + country are in ancestry", () => {
		const v = variantsFor(
			rec({ name: "Portland" }),
			{ region: rec({ name: "Oregon", placetype: "region" }), country: unitedStates },
			slot("Portland")
		)

		expect(v.map((x) => x.suffix)).toEqual(["self", "with-region", "with-region-country"])

		expect(v[2]!.components).toEqual({
			locality: "Portland",
			region: "Oregon",
			country: "United States of America",
		})
	})

	it("country uses the OpenCage-canonical name for the default slot value", () => {
		const v = variantsFor(rec({ name: "United States", placetype: "country" }), {}, slot("United States of America"))
		expect(v).toHaveLength(1)
		expect(v[0]!.components).toEqual({ country: "United States of America" })
	})

	it("respects a substituted selfName for the locality component", () => {
		const v = variantsFor(
			rec({ name: "Saint Petersburg" }),
			{ region: rec({ name: "Florida", placetype: "region" }), country: unitedStates },
			slot("St. Petersburg")
		)

		expect(v[0]!.components.locality).toBe("St. Petersburg")
		expect(v[1]!.components.locality).toBe("St. Petersburg")
		expect(v[1]!.components.region).toBe("Florida")
	})

	it("subregion (county) yields self only", () => {
		const v = variantsFor(
			rec({ name: "Multnomah County", placetype: "county" }),
			{ region: rec({ name: "Oregon", placetype: "region" }) },
			slot("Multnomah County")
		)

		expect(v).toHaveLength(1)
		expect(v[0]!.components).toEqual({ subregion: "Multnomah County" })
	})

	it("writes a dependent locality with its parent locality", () => {
		const brooklyn = rec({ id: 421_205_765, name: "Brooklyn", placetype: "borough" })

		const v = variantsFor(
			brooklyn,
			{ locality: newYorkCity, region: newYorkState, country: unitedStates },
			slot("Brooklyn")
		)

		expect(v.find((x) => x.suffix === "with-locality")?.components).toEqual({
			dependent_locality: "Brooklyn",
			locality: "New York",
		})

		expect(v.find((x) => x.suffix === "with-locality-region")?.components).toEqual({
			dependent_locality: "Brooklyn",
			locality: "New York",
			region: "New York",
		})
	})

	it("renders a language's hierarchy from each ancestor's preferred name in that language", () => {
		const brooklyn = rec({ id: 421_205_765, name: "Brooklyn", placetype: "borough" })

		const v = variantsFor(
			brooklyn,
			{ locality: newYorkCity, region: newYorkState, country: unitedStates },
			slot("ブルックリン区", "jpn")
		)

		const localized = v.find((x) => x.suffix === "localized-jpn")!

		expect(localized.components).toEqual({
			dependent_locality: "ブルックリン区",
			locality: "ニューヨーク",
			region: "ニューヨーク州",
		})

		expect(localized.layoutCountry).toBe("JP")
		expect(v.find((x) => x.suffix === "localized-jpn-country")?.components.country).toBe("アメリカ合衆国")
	})

	it("skips a language that one of the record's ancestors lacks", () => {
		const v = variantsFor(
			rec({ name: "Brooklyn", placetype: "borough" }),
			{ locality: newYorkCity, region: rec({ name: "New York", placetype: "region" }), country: unitedStates },
			slot("ブルックリン区", "jpn")
		)

		expect(v.some((x) => x.suffix.startsWith("localized-"))).toBe(false)
	})

	it("renders a localized hierarchy without the country when the country lacks the language", () => {
		const v = variantsFor(
			rec({ name: "Brooklyn", placetype: "borough" }),
			{ locality: newYorkCity, region: newYorkState, country: unitedStates },
			slot("브루클린", "kor")
		)

		expect(v.map((x) => x.suffix)).toContain("localized-kor")
		expect(v.map((x) => x.suffix)).not.toContain("localized-kor-country")
	})
})

describe("layoutCountryForLanguage", () => {
	it("resolves a language every country writing it lays out the same way", () => {
		expect(layoutCountryForLanguage("jpn")).toBe("JP")
	})
})

describe("nameSlotsFor", () => {
	it("emits the canonical 'default' slot then one per non-duplicate name:* variant", () => {
		const slots = nameSlotsFor(
			rec({
				name: "Saint Petersburg",
				nameVariants: new Map([
					["name:eng_x_preferred", "Saint Petersburg"],
					["name:eng_x_colloquial", "St. Petersburg"],
					["name:rus_x_preferred", "Санкт-Петербург"],
				]),
			})
		)

		// Preferred-name keys come first in language-rank order, then the other keys in source order.
		expect(slots.map((s) => s.key)).toEqual(["default", "name-rus-x-preferred", "name-eng-x-colloquial"])
		expect(slots.map((s) => s.value)).toEqual(["Saint Petersburg", "Санкт-Петербург", "St. Petersburg"])
		expect(slots[1]!.language).toBe("rus")
	})

	it("emits every value of a key that holds several", () => {
		const slots = nameSlotsFor(
			rec({
				name: "New York",
				nameVariants: new Map([["name:eng_x_colloquial", ["Big Apple", "Gotham", "NYC", "The Big Apple"]]]),
			})
		)

		expect(slots.map((s) => s.key)).toEqual([
			"default",
			"name-eng-x-colloquial",
			"name-eng-x-colloquial-2",
			"name-eng-x-colloquial-3",
			"name-eng-x-colloquial-4",
		])

		expect(slots.map((s) => s.value)).toEqual(["New York", "Big Apple", "Gotham", "NYC", "The Big Apple"])
	})

	it("keeps the language on at most eight slots, the country's official languages first", () => {
		const languages = ["ara", "deu", "eng", "fra", "jpn", "kor", "rus", "spa", "zho", "ita"]

		const slots = nameSlotsFor(
			rec({
				name: "New York",
				nameVariants: new Map(languages.map((language) => [`name:${language}_x_preferred`, `NY-${language}`])),
			})
		)

		const kept = slots.map((s) => s.language).filter(isPresent)

		expect(kept).toHaveLength(8)
		expect(kept).toContain("eng")
	})

	it("ranks the served languages ahead of the alphabet, so Japanese stays inside the cap for a US place", () => {
		const languages = ["ara", "azb", "aze", "bel", "ben", "bul", "cdo", "ckb", "ell", "epo", "jpn", "kor", "zho"]

		const slots = nameSlotsFor(
			rec({
				name: "Brooklyn",
				placetype: "borough",
				nameVariants: new Map(languages.map((language) => [`name:${language}_x_preferred`, `B-${language}`])),
			})
		)

		const kept = slots.map((s) => s.language).filter(isPresent)

		expect(kept).toHaveLength(8)
		expect(kept).toEqual(expect.arrayContaining(["jpn", "kor", "zho"]))
	})

	it("gives a name two languages share to the served language, so zho keeps Brooklyn's 布鲁克林区 from wuu", () => {
		const slots = nameSlotsFor(
			rec({
				name: "Brooklyn",
				placetype: "borough",
				nameVariants: new Map([
					["name:wuu_x_preferred", "布鲁克林区"],
					["name:zho_x_preferred", "布鲁克林区"],
				]),
			})
		)

		expect(slots.find((s) => s.value === "布鲁克林区")?.language).toBe("zho")
	})

	it("uses the OpenCage-canonical country name for the default slot of a country record", () => {
		const slots = nameSlotsFor(rec({ id: 100, name: "United States", placetype: "country" }))

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
