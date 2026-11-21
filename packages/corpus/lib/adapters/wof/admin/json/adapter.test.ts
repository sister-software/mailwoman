// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

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
	codeCountries: [],
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

describe("variantsFor, structural chains of the canonical and colloquial names", () => {
	const kingsCounty = rec({ id: 102_082_361, name: "Kings County", placetype: "county" })
	const brooklyn = rec({ id: 421_205_765, name: "Brooklyn", placetype: "borough" })
	const ancestry = { locality: newYorkCity, subregion: kingsCounty, region: newYorkState, country: unitedStates }
	const defaultSlot: NameSlot = { key: "default", value: "Brooklyn" }

	it("renders the name with every ordered subset of its four ancestor levels that holds its locality", () => {
		const suffixes = new Set(variantsFor(brooklyn, ancestry, defaultSlot).map((v) => v.suffix))

		expect(suffixes).toContain("with-locality")
		expect(suffixes).toContain("with-locality-subregion-region-country")
		expect(suffixes).not.toContain("self")
		expect(suffixes).not.toContain("with-subregion")
		expect(suffixes).not.toContain("with-region-country")
		expect([...suffixes].filter((suffix) => !suffix.endsWith("-form"))).toHaveLength(8)
	})

	it("writes a dependent locality beside its locality in every variant and every name slot", () => {
		const slots: NameSlot[] = [defaultSlot, slot("ブルックリン区", "jpn"), slot("Brooklyn", "est")]

		for (const name of slots) {
			for (const variant of variantsFor(brooklyn, ancestry, name)) {
				expect(variant.components.locality, `${variant.suffix} of ${name.value}`).toBeTruthy()
			}
		}
	})

	it("renders no row for a dependent locality whose locality is missing or lacks the slot's language", () => {
		const fields = rec({ id: 6040, name: "Fen Ditton Fields", placetype: "neighbourhood", country: "GB" })
		const england = rec({ id: 6010, name: "England", placetype: "region", country: "GB" })

		expect(variantsFor(fields, { region: england }, { key: "default", value: "Fen Ditton Fields" })).toEqual([])

		// The locality has no Estonian name, so an Estonian chain has no locality to write.
		expect(variantsFor(brooklyn, ancestry, slot("Londoni linnamüür", "est"))).toEqual([])
	})

	it("writes each level canonically, and once more in another of its forms", () => {
		const variants = variantsFor(brooklyn, ancestry, defaultSlot)
		const regionCountry = variants.find((v) => v.suffix === "with-locality-region-country")!
		const regionCountryForm = variants.find((v) => v.suffix === "with-locality-region-country-form")!

		expect(regionCountry.components).toEqual({
			dependent_locality: "Brooklyn",
			locality: "New York",
			region: "New York",
			country: "United States of America",
		})

		// The US writes its regions as libaddressinput codes, and the codex lists the country's other surfaces.
		expect(regionCountryForm.components.region).toBe("NY")
		expect(["United States", "USA", "US", "U.S.A.", "U.S.", "America"]).toContain(regionCountryForm.components.country)
	})

	it("gives a region no code where the country's addresses write region names", () => {
		const paris = rec({ id: 101_751_119, name: "Paris", country: "FR" })
		const ileDeFrance = rec({ id: 85_683_497, name: "Île-de-France", placetype: "region", country: "FR" })
		const variants = variantsFor(paris, { region: ileDeFrance }, { key: "default", value: "Paris" })

		expect(variants.map((v) => v.suffix)).toEqual(["self", "with-region"])
	})

	it("leaves out a county that carries the record's own name", () => {
		const paris = rec({ id: 101_751_119, name: "Paris", country: "FR" })
		const parisCounty = rec({ id: 102_068_177, name: "Paris", placetype: "county", country: "FR" })
		const variants = variantsFor(paris, { subregion: parisCounty }, { key: "default", value: "Paris" })

		expect(variants.map((v) => v.suffix)).toEqual(["self"])
	})

	it("writes an ancestor in its colloquial names", () => {
		const nyc = rec({ ...newYorkCity, nameVariants: new Map([["name:eng_x_colloquial", ["NYC", "Big Apple"]]]) })

		const forms = variantsFor(brooklyn, { locality: nyc }, defaultSlot)
			.filter((v) => v.suffix === "with-locality-form")
			.map((v) => v.components.locality)

		expect(["NYC", "Big Apple"]).toContain(forms[0])
	})
})

describe("variantsFor in a country whose towns WOF types as localadmin", () => {
	const nz = (over: Partial<TestRecord>) => rec({ country: "NZ", ...over })
	const newZealand = nz({ id: 85_633_345, name: "New Zealand", placetype: "country" })
	const aucklandRegion = nz({ id: 85_687_243, name: "Auckland Region", placetype: "region" })
	const aucklandCounty = nz({ id: 102_079_403, name: "Auckland", placetype: "county" })
	const aucklandTown = nz({ id: 1_729_238_453, name: "Auckland", placetype: "localadmin" })
	const invercargillCouncil = nz({ id: 102_079_397, name: "Invercargill City", placetype: "county" })
	const invercargillTown = nz({ id: 1_729_238_483, name: "Invercargill", placetype: "localadmin" })
	const southland = nz({ id: 85_687_253, name: "Southland Region", placetype: "region" })
	const inAuckland = { subregion: aucklandTown, region: aucklandRegion, country: newZealand }

	const variantsOf = (record: TestRecord, ancestry: Parameters<typeof variantsFor>[1]) =>
		variantsFor(record, ancestry, { key: "default", value: record.name })

	it("writes a suburb as the dependent locality beside its town as the locality", () => {
		const papatoetoe = nz({ id: 1_125_922_189, name: "Papatoetoe" })
		const variants = variantsOf(papatoetoe, inAuckland)

		expect(variants.map((v) => v.components)).toContainEqual({ dependent_locality: "Papatoetoe", locality: "Auckland" })

		for (const variant of variants) {
			expect(variant.components.dependent_locality, variant.suffix).toBe("Papatoetoe")
			expect(variant.components.locality, variant.suffix).toBe("Auckland")
			expect(variant.components.subregion, variant.suffix).toBeUndefined()
		}
	})

	it("writes a neighborhood inside a suburb beside the town, without the suburb", () => {
		const papatoetoe = nz({ id: 1_125_922_189, name: "Papatoetoe" })
		const puhinui = nz({ id: 85_772_141, name: "Puhinui", placetype: "neighbourhood" })

		for (const variant of variantsOf(puhinui, { ...inAuckland, locality: papatoetoe })) {
			expect(variant.components.dependent_locality, variant.suffix).toBe("Puhinui")
			expect(variant.components.locality, variant.suffix).toBe("Auckland")
			expect(variant.components.subregion, variant.suffix).toBeUndefined()
		}
	})

	it("keeps the town's own locality record, and the town itself, as the locality", () => {
		const auckland = nz({ id: 101_914_257, name: "Auckland" })

		for (const variant of [
			...variantsOf(auckland, inAuckland),
			...variantsOf(aucklandTown, { subregion: aucklandCounty, region: aucklandRegion, country: newZealand }),
		]) {
			expect(variant.components.locality, variant.suffix).toBe("Auckland")
			expect(variant.components.dependent_locality, variant.suffix).toBeUndefined()
			expect(variant.components.subregion, variant.suffix).toBeUndefined()
		}
	})

	it("writes a town without the council it heads", () => {
		const ancestry = { subregion: invercargillCouncil, region: southland, country: newZealand }

		expect(variantsOf(invercargillTown, ancestry).map((v) => v.components)).toContainEqual({
			locality: "Invercargill",
			region: "Southland Region",
		})

		expect(variantsOf(invercargillTown, ancestry).some((v) => v.components.subregion != null)).toBe(false)
	})

	it("leaves a rural locality in a district, and every other country's localadmin, as they were", () => {
		const waverley = nz({ id: 101_915_841, name: "Waverley" })
		const southTaranaki = nz({ id: 102_079_295, name: "South Taranaki District", placetype: "county" })

		expect(
			variantsOf(waverley, { subregion: southTaranaki, country: newZealand }).map((v) => v.components)
		).toContainEqual({
			locality: "Waverley",
			subregion: "South Taranaki District",
		})

		const amherstTown = rec({ id: 404_475_231, name: "Amherst", placetype: "localadmin" })
		const northAmherst = rec({ id: 85_949_123, name: "North Amherst" })

		expect(variantsOf(northAmherst, { subregion: amherstTown }).map((v) => v.components)).toContainEqual({
			locality: "North Amherst",
			subregion: "Amherst",
		})
	})
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

		expect(v.map((x) => x.suffix)).toEqual(["with-locality-region", "with-locality-region-country"])

		const local = v.find((x) => x.suffix === "with-locality-region")!

		expect(local.components).toEqual({
			dependent_locality: "ブルックリン区",
			locality: "ニューヨーク",
			region: "ニューヨーク州",
		})

		expect(local.layoutCountry).toBe("JP")
		expect(v.find((x) => x.suffix === "with-locality-region-country")?.components.country).toBe("アメリカ合衆国")
	})

	it("leaves out an ancestor that lacks the language rather than writing its name in another", () => {
		const v = variantsFor(
			rec({ name: "Brooklyn", placetype: "borough" }),
			{ locality: newYorkCity, region: rec({ name: "New York", placetype: "region" }), country: unitedStates },
			slot("ブルックリン区", "jpn")
		)

		expect(v.map((x) => x.components)).toContainEqual({
			dependent_locality: "ブルックリン区",
			locality: "ニューヨーク",
			country: "アメリカ合衆国",
		})

		expect(v.some((x) => Object.values(x.components).includes("New York"))).toBe(false)
	})

	it("writes a region in its own language with its country", () => {
		const japan = rec({
			name: "Japan",
			placetype: "country",
			country: "JP",
			nameVariants: new Map([["name:jpn_x_preferred", "日本"]]),
		})

		const v = variantsFor(
			rec({ name: "Tokyo", placetype: "region", country: "JP" }),
			{ country: japan },
			slot("東京都", "jpn")
		)

		expect(v.map((x) => x.components)).toEqual([{ region: "東京都" }, { region: "東京都", country: "日本" }])
	})

	it("renders every ordered subset of the levels in a language the country writes", () => {
		const german = (name: string) => new Map([["name:deu_x_preferred", name]])

		const v = variantsFor(
			rec({ name: "Zürich", placetype: "locality", country: "CH" }),
			{
				subregion: rec({
					name: "Bezirk Zürich",
					placetype: "county",
					country: "CH",
					nameVariants: german("Bezirk Zürich"),
				}),
				region: rec({ name: "Zurich", placetype: "region", country: "CH", nameVariants: german("Zürich") }),
				country: rec({ name: "Switzerland", placetype: "country", country: "CH", nameVariants: german("Schweiz") }),
			},
			slot("Zürich", "deu")
		)

		expect(v).toHaveLength(8)

		expect(v.find((x) => x.suffix === "with-region-country")?.components).toEqual({
			locality: "Zürich",
			region: "Zürich",
			country: "Schweiz",
		})

		expect(v.every((x) => x.layoutCountry === undefined)).toBe(true)
	})

	it("renders a localized hierarchy without the country when the country lacks the language", () => {
		const v = variantsFor(
			rec({ name: "Brooklyn", placetype: "borough" }),
			{ locality: newYorkCity, region: newYorkState, country: unitedStates },
			slot("브루클린", "kor")
		)

		expect(v.map((x) => x.suffix)).toContain("with-locality-region")
		expect(v.some((x) => x.components.country)).toBe(false)
	})
})

describe("layoutCountryForLanguage", () => {
	it("resolves a language every country writing it lays out the same way", () => {
		expect(layoutCountryForLanguage("jpn")).toBe("JP")
	})

	it("resolves Chinese to the local-script layout its countries share", () => {
		expect(layoutCountryForLanguage("zho")).toBe("CN")
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

describe("wof-admin-json adapter on records whose chain leaves their country", () => {
	it("writes Monaco's La Condamine without France's region and renders no record WOF assigns to no country", async () => {
		await removePathIfPresent(scratch.path(WOF_ADMIN_ADAPTER_ID))

		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: workspacePath("corpus", "fixtures", "wof-admin-cross-country") },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await loadRows()
		const condamine = rows.filter((r) => r.components.locality === "La Condamine")

		expect(condamine.length).toBeGreaterThan(0)
		expect(condamine.every((r) => r.country === "MC" && r.components.region == null)).toBe(true)
		expect(condamine.some((r) => r.components.country === "Monaco")).toBe(true)
		expect(rows.filter((r) => r.country === "XX" || r.raw.includes("Unplaced Quarter"))).toEqual([])
		expect(rows.some((r) => r.country === "FR" && r.components.region === "Alpes-Maritimes")).toBe(true)
	})
})

describe("wof-admin-json adapter on sub-localities", () => {
	it("emits every dependent locality beside its locality, and nothing for one with no locality ancestor", async () => {
		await removePathIfPresent(scratch.path(WOF_ADMIN_ADAPTER_ID))

		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: workspacePath("corpus", "fixtures", "wof-admin-sub-locality") },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		const rows = await loadRows()
		const subLocalities = rows.filter((r) => r.components.dependent_locality != null)

		expect(subLocalities.map((r) => r.raw)).toContain("Camden, London")
		expect(subLocalities.filter((r) => r.components.locality == null)).toEqual([])
		expect(rows.filter((r) => r.raw.includes("Fen Ditton Fields") || r.raw.includes("Camdeni"))).toEqual([])
		expect(rows.some((r) => r.components.locality === "London" && r.components.dependent_locality == null)).toBe(true)
	})
})

describe("wof-admin-json adapter on a region that shares its city's name", () => {
	const dualRoleRoot = workspacePath("corpus", "fixtures", "wof-admin-dual-role")

	const run = async (sample?: { cellFloor: number; rowsPerCountry: number }) => {
		await removePathIfPresent(scratch.path(WOF_ADMIN_ADAPTER_ID))

		await runAdapter({
			adapter: createWOFAdminAdapter(),
			adapterOptions: { inputPath: dualRoleRoot, country: "DE", ...(sample ? { sample } : {}) },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		return loadRows()
	}

	it("writes `Berlin, Germany` as the city and never as the region, and leaves an unpaired region's row", async () => {
		const rows = await run()
		const twoPart = rows.filter((r) => Object.keys(r.components).length === 2 && r.components.country === "Germany")

		expect(twoPart.filter((r) => r.components.region === "Berlin")).toEqual([])
		expect(twoPart.some((r) => r.components.locality === "Berlin")).toBe(true)
		expect(twoPart.some((r) => r.components.region === "Testmark")).toBe(true)
	})

	it("keeps the city's `<locality>, <country>` row in a sample that would keep nothing else", async () => {
		const rows = await run({ cellFloor: 0, rowsPerCountry: 0 })

		expect(rows.map((r) => r.source_id)).toEqual(["wof-admin-4020-default-with-country"])
		expect(rows[0]!.components).toEqual({ locality: "Berlin", country: "Germany" })
	})
})
