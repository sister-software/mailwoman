/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture under `fixtures/vlaanderen/` is a harvest of nine addresses and the component
 *   entries they reference.
 *
 *   Every byte of every value is the service's own, taken on 2026-10-02 from
 *   `https://geo.api.vlaanderen.be/ad/wfs`: the five `adres_204231xx` addresses are one real page at
 *   `startIndex=1200000`, and each component feature is one real `resourceId` response. The literal
 *   `?` in `Rue du Ch?teau_` and `Assembl?e de la Commission Communautaire Fran?aise` is what the
 *   service sends, in a document declaring `encoding="UTF-8"`.
 *
 *   The four `adres_9000000x` members are hand-authored from a real member's bytes, changing only
 *   the `gml:id`, the `gml:identifier` and the component references, so each defect the service
 *   has is exercised against one address: a lost character, a void designator, a reference the
 *   harvest cannot answer, and a street name holding a homonym discriminator. Each member sits on
 *   its own line, where the service writes one member per line. Element and attribute bytes are
 *   unchanged.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import {
	componentResourceID,
	createVlaanderenAdapter,
	splitStreetName,
	VLAANDEREN_ADAPTER_ID,
	VLAANDEREN_DEFAULT_LICENSE,
	VlaanderenHarvestError,
} from "#be/adapters/vlaanderen/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("vlaanderen")

const fixtureHarvest = workspacePath("corpus", "fixtures", "vlaanderen")

function run(adapterOptions: Partial<Parameters<typeof runAdapter>[0]["adapterOptions"]> = {}) {
	return runAdapter({
		adapter: createVlaanderenAdapter(),
		adapterOptions: { inputPath: fixtureHarvest, ...adapterOptions },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})
}

describe("vlaanderen adapter against the fixture harvest", () => {
	it("emits a row per readable address under the elected Modellicentie", async () => {
		const manifest = await run()

		// Nine addresses: one has a lost character in its street, one states a void
		// house number, and one references a street the harvest cannot answer.
		expect(manifest.yielded).toBe(6)

		const rows = await readCanonicalRows(scratch.path, VLAANDEREN_ADAPTER_ID)

		expect(rows).toHaveLength(6)
		expect(rows.every((r) => r.license === VLAANDEREN_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((r) => r.source === VLAANDEREN_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.country === "BE")).toBe(true)
		expect(rows.every((r) => r.locale === "nl-BE")).toBe(true)
	})

	it("reads the house number inline from the typed designator", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, VLAANDEREN_ADAPTER_ID)

		// `1B` is one designator value rather than a number and a letter in two columns,
		// and it is selected by its sibling `ad:type`, not by being the first designator present.
		expect(rows.find((r) => r.source_id === "vlaanderen-adres_20423186")?.components.house_number).toBe("1B")

		expect(rows.map((r) => r.components.house_number)).toEqual(["21", "1B", "5", "82", "10", "14"])
	})

	it("joins street, postcode and locality through the component references", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, VLAANDEREN_ADAPTER_ID)
		const first = rows.find((r) => r.source_id === "vlaanderen-adres_20423185")

		expect(first?.raw).toBe("Lotenhullestraat 21, 9800 Deinze")

		expect(first?.components).toEqual({
			house_number: "21",
			street: "Lotenhullestraat",
			postcode: "9800",
			locality: "Deinze",
		})

		// The second postcode proves the postcode comes from the referenced descriptor
		// rather than from the first one read.
		expect(rows.find((r) => r.source_id === "vlaanderen-adres_20423188")?.raw).toBe("Hansbekedorp 82, 9850 Deinze")
	})

	it("takes the locality from the municipality-level unit, not the country-level one", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, VLAANDEREN_ADAPTER_ID)

		// Every address also references `refnis1995_1000`, whose name is `België` at `1stOrder`.
		expect(rows.every((r) => r.components.locality === "Deinze")).toBe(true)
		expect(rows.some((r) => r.raw.includes("België"))).toBe(false)
	})

	it.each([
		["https://data.vlaanderen.be/id/straatnaam/6301", "straatnaam_6301"],
		["https://data.vlaanderen.be/id/postinfo/2520", "postinfo_2520"],
		["https://data.vlaanderen.be/id/gemeentenaam/11035", "gemeentenaam_11035"],
		["http://vocab.belgif.be/auth/refnis1995/1000#id", "refnis1995_1000"],
	])("rewrites the component reference %s to %s", (href, expected) => {
		expect(componentResourceID(href)).toBe(expected)
	})

	it.each([
		["#straatnaam_6301", null],
		["https://data.vlaanderen.be/", null],
		["unpopulated", null],
	])("reads no resourceId from %s, rather than inventing one", (href, expected) => {
		expect(componentResourceID(href)).toBe(expected)
	})

	it("splits the street name at its last underscore, discriminator and all", () => {
		// 19,979 of 20,000 measured values take the first form and 21 the second.
		expect(splitStreetName("Lotenhullestraat_")).toEqual({ street: "Lotenhullestraat", discriminator: "" })
		expect(splitStreetName("Rue de Cronwez_01")).toEqual({ street: "Rue de Cronwez", discriminator: "01" })
		expect(splitStreetName("Kattenberg_BO")).toEqual({ street: "Kattenberg", discriminator: "BO" })
		expect(splitStreetName("Van Immerseelstraat_")).toEqual({ street: "Van Immerseelstraat", discriminator: "" })
	})

	it("refuses a street name carrying no separator rather than guessing at the new shape", () => {
		expect(() => splitStreetName("Acacialaan")).toThrow(VlaanderenHarvestError)
		expect(() => splitStreetName("Acacialaan")).toThrow(/carries no "_" separator/)
	})

	it("keeps the discriminated street out of the corpus and its name in", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, VLAANDEREN_ADAPTER_ID)

		expect(rows.find((r) => r.source_id === "vlaanderen-adres_90000004")?.raw).toBe("Rue de Cronwez 14, 9850 Deinze")
		expect(rows.some((r) => r.components.street?.includes("_"))).toBe(false)
		expect(rows.some((r) => r.raw.endsWith("_"))).toBe(false)
	})

	it("refuses a value carrying the publisher's lost character rather than emitting it", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, VLAANDEREN_ADAPTER_ID)

		// `straatnaam_138007` is `Rue du Ch?teau_`, which every output format serves identically.
		expect(rows.some((r) => r.source_id === "vlaanderen-adres_90000001")).toBe(false)
		expect(rows.some((r) => r.raw.includes("?"))).toBe(false)
		// The mojibake post name of `postinfo_1007` reaches no row, because the locality
		// comes from `ad:AdminUnitName` and `ad:postName` is never read.
		expect(rows.some((r) => r.raw.includes("Assembl"))).toBe(false)
	})

	it("does not read a nil-with-nilReason designator as an address without a number", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, VLAANDEREN_ADAPTER_ID)
		const voided = rows.find((r) => r.source_id === "vlaanderen-adres_90000002")

		// The row is refused outright.
		// A void states that the number is unknown, so emitting the address with no
		// `house_number` would record an absence the publisher never stated.
		expect(voided).toBeUndefined()
		expect(rows.every((r) => r.components.house_number !== undefined)).toBe(true)
		expect(rows.every((r) => r.components.house_number !== "")).toBe(true)
	})

	it("refuses an address whose reference the harvest cannot answer", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, VLAANDEREN_ADAPTER_ID)

		// `straatnaam_999999` is in no component file, so the street could not be read.
		expect(rows.some((r) => r.source_id === "vlaanderen-adres_90000003")).toBe(false)
		expect(rows.every((r) => Boolean(r.components.street))).toBe(true)
	})

	it("honors --limit", async () => {
		const manifest = await run({ limit: 2 })

		expect(manifest.yielded).toBe(2)
		expect(manifest.written).toBe(2)
	})

	it("stops at an aborted signal", async () => {
		const controller = new AbortController()

		controller.abort()

		// Asked of the adapter rather than of the runner. The runner refuses an aborted write of its own.
		const rows = await Array.fromAsync(
			createVlaanderenAdapter().rows({ inputPath: fixtureHarvest, signal: controller.signal })
		)

		expect(rows).toEqual([])
	})

	it("accepts --country BE, the one jurisdiction the service publishes", async () => {
		const manifest = await run({ country: "BE" })

		expect(manifest.yielded).toBe(6)
	})

	it("rejects a jurisdiction this service does not publish", async () => {
		// Brussels and Wallonia publish the theme through their own services,
		// so a Belgian build reads this row for the Flemish Region only.
		await expect(run({ country: "NL" })).rejects.toThrow(/the dataset covers BE, got country=NL/)
	})

	it("two runs over the same harvest produce identical sha256", async () => {
		const a = await run()

		await removePathIfPresent(scratch.path(VLAANDEREN_ADAPTER_ID))

		const b = await run()

		expect(a.sha256).toBe(b.sha256)
	})
})
