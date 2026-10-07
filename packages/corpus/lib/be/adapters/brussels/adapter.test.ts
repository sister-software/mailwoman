/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture at `fixtures/brussels/UrbAdm_Adresses.gml` is ten addresses and the eleven component
 *   features they reference, extracted from the publisher's own file.
 *
 *   Every byte is the Brussels Regional Informatics Center's own. It was taken on 2026-10-02 from
 *   `https://urbisdownload.datastore.brussels/INSPIRE/URBIS_ADM_Adresses.zip`, 11,521,182 bytes. Its
 *   member `UrbAdm_Adresses.gml` is 474,245,978 bytes. The fixture is that member with its own
 *   XML declaration, root element and `gml:boundedBy` kept, holding 21 of its 231,947
 *   `gml:featureMember` elements verbatim. Every byte stands as the publisher wrote it: `diff`
 *   against the extraction reports no difference.
 *
 *   It keeps the publisher's member order, every component before any address. That order is what
 *   lets one pass index and join.
 *
 *   The ten addresses show the two defects this publisher's file writes. Every nil element in them
 *   states no `nilReason` — `ad:validFrom`, `ad:specification` and `ad:method` on each address, and
 *   `gn:nativeness`, `gn:nameStatus`, `gn:sourceOfName`, `gn:pronunciation` and `gn:script` on each
 *   component name. And `BE.BRUSSELS.BRIC.ADM.ADPT.220623` writes
 *   `<ad:component xlink:href=""/>` in its postal-zone slot, one of the nine addresses in the file
 *   that do, so it states no postcode.
 *
 *   The components are the five administrative units an address references (`1stOrder` through
 *   `5thOrder`), each spelling its name as a NIS code and a parenthesized name, two municipalities so
 *   that the empty-reference address sits in a different one, one postal descriptor, and four street
 *   names, each spelled in French and in Dutch.
 */

import { openReadStream } from "@mailwoman/core/fs/streams"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { childElement, streamMarkupElements } from "@mailwoman/core/html/elements"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import {
	BRUSSELS_ADAPTER_ID,
	BRUSSELS_DEFAULT_LICENSE,
	BRUSSELS_SOURCE_REGISTER,
	createBrusselsAdapter,
	placeNameWithoutNISCode,
	readBrusselsComponents,
} from "#be/adapters/brussels/adapter"
import { isVoid, voidReason } from "#inspire/address"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"
import { LicensePolicy, licenseVerdict } from "#utils/license"

const scratch = useScratchDir("brussels")

const fixture = workspacePath("corpus", "fixtures", "brussels", "UrbAdm_Adresses.gml")

function run(adapterOptions: Partial<Parameters<typeof runAdapter>[0]["adapterOptions"]> = {}) {
	return runAdapter({
		adapter: createBrusselsAdapter(),
		adapterOptions: { inputPath: fixture, ...adapterOptions },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})
}

describe("brussels adapter against the fixture member", () => {
	it("emits a row per readable address under the register's elected CC BY 4.0", async () => {
		const manifest = await run()

		// Ten addresses, nine readable: the tenth writes its postal-zone reference empty.
		expect(manifest.yielded).toBe(9)
		expect(manifest.written).toBe(9)

		const rows = await readCanonicalRows(scratch.path, BRUSSELS_ADAPTER_ID)

		expect(rows).toHaveLength(9)

		// The register elects CC-BY-4.0 for Paradigm, and the row records the SPDX identifier
		// so that `licenseVerdict` resolves it.
		// A license title resolves to no expression. A build reads that as unknown
		// obligations rather than as none.
		expect(BRUSSELS_DEFAULT_LICENSE).toBe("CC-BY-4.0")
		expect(licenseVerdict(BRUSSELS_DEFAULT_LICENSE, LicensePolicy.ShareAlikeFree, []).resolved).toBe(true)
		expect(rows.every((row) => row.license === BRUSSELS_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((row) => row.source === BRUSSELS_ADAPTER_ID)).toBe(true)
		expect(rows.every((row) => row.register === BRUSSELS_SOURCE_REGISTER)).toBe(true)
		expect(rows.every((row) => row.country === "BE")).toBe(true)
		expect(rows.every((row) => row.locale === "fr-BE")).toBe(true)
	})

	it("reads the house number from Brussels' own designator type", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BRUSSELS_ADAPTER_ID)

		// `buildingIdentifier`, which is Czechia's term, rather than Wallonia's `addressIdentifierGeneral`.
		// An adapter keyed on Wallonia's term would read no number here.
		expect(rows.map((row) => row.components.house_number)).toEqual([
			"17",
			"15",
			"44B",
			"42",
			"40",
			"38",
			"19",
			"37",
			"9",
		])

		// `44B` is one designator value rather than a number and a letter in two columns.
		expect(
			rows.find((row) => row.source_id === "brussels-BE.BRUSSELS.BRIC.ADM.ADPT.169733")?.components.house_number
		).toBe("44B")
	})

	it("joins street, postcode and locality through the local fragments", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BRUSSELS_ADAPTER_ID)
		const first = rows.find((row) => row.source_id === "brussels-BE.BRUSSELS.BRIC.ADM.ADPT.169731")

		expect(first?.raw).toBe("Avenue Jules de Trooz 17, 1150 Woluwe-Saint-Pierre")

		expect(first?.components).toEqual({
			house_number: "17",
			street: "Avenue Jules de Trooz",
			postcode: "1150",
			locality: "Woluwe-Saint-Pierre",
		})

		// The second street proves the value comes from the referenced feature
		// rather than from the first street the pass read.
		expect(rows.find((row) => row.source_id === "brussels-BE.BRUSSELS.BRIC.ADM.ADPT.165549")?.raw).toBe(
			"Rue René Declercq 19, 1150 Woluwe-Saint-Pierre"
		)

		// A street is spelled in French and in Dutch and the row takes the French one.
		expect(rows.some((row) => row.raw.includes("Troozlaan") || row.raw.includes("Declercqstraat"))).toBe(false)
	})

	it("strips the NIS code the publisher embeds in every place name", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BRUSSELS_ADAPTER_ID)

		// `BE.BRUSSELS.BRIC.ADM.MU.63` spells its name `21019 (Woluwe-Saint-Pierre)`.
		expect(rows.every((row) => row.components.locality === "Woluwe-Saint-Pierre")).toBe(true)
		expect(rows.some((row) => /\d{5}/u.test(row.raw.replace(/\b1150\b/u, "")))).toBe(false)
		expect(rows.some((row) => row.raw.includes("("))).toBe(false)
	})

	it.each([
		["21019 (Woluwe-Saint-Pierre)", "Woluwe-Saint-Pierre"],
		["01000 (Belgique)", "Belgique"],
		["21000 (Bruxelles-Capitale)", "Bruxelles-Capitale"],
		// A name not of that shape is the publisher's own value rather than a guess at what is inside.
		["Woluwe-Saint-Pierre", "Woluwe-Saint-Pierre"],
		["21004", "21004"],
	])("reads the place name of %s as %s", (value, expected) => {
		expect(placeNameWithoutNISCode(value)).toBe(expected)
	})

	it("reads no place name from an absent or code-only value, rather than inventing one", () => {
		expect(placeNameWithoutNISCode(undefined)).toBeUndefined()
		expect(placeNameWithoutNISCode("  ")).toBeUndefined()
		expect(placeNameWithoutNISCode("21004 ()")).toBeUndefined()
	})

	it("takes the locality from the municipality-level unit, not the district, province or country", async () => {
		const index = await readBrusselsComponents(fixture)

		// Five administrative units are in the fixture and only the two municipalities are indexed.
		expect([...index.municipalities.values()].toSorted()).toEqual(["Bruxelles", "Woluwe-Saint-Pierre"])
		expect(index.municipalities.has("BE.BRUSSELS.BRIC.ADM.COUNTRY")).toBe(false)
		expect(index.municipalities.has("BE.BRUSSELS.BRIC.ADM.REGION")).toBe(false)
		expect(index.municipalities.has("BE.BRUSSELS.BRIC.ADM.PROVINCE")).toBe(false)
		expect(index.municipalities.has("BE.BRUSSELS.BRIC.ADM.DISTRICT")).toBe(false)

		await run()

		const rows = await readCanonicalRows(scratch.path, BRUSSELS_ADAPTER_ID)

		// The province the file names is `20001 (Brabant flamand)`, which this region is not in.
		expect(rows.some((row) => /Belgique|Bruxelles-Capitale|Brabant/u.test(row.raw))).toBe(false)
	})

	it("reads a nil that states no reason as void", async () => {
		const [address] = await Array.fromAsync(streamMarkupElements(openReadStream(fixture), "ad:Address", { xml: true }))

		const validFrom = childElement(address!, "ad:validFrom")

		// The whole file holds 0 nil elements that state a reason, so a reader keyed on
		// `nilReason` reads every one of these as a populated value.
		expect(validFrom?.attributes["xsi:nil"]).toBe("true")
		expect(validFrom?.attributes.nilReason).toBeUndefined()
		expect(isVoid(validFrom)).toBe(true)
		expect(voidReason(validFrom)).toBeUndefined()

		// An element the publisher populated is not void, so `isVoid` is not simply answering true.
		expect(isVoid(childElement(address!, "ad:beginLifespanVersion"))).toBe(false)
	})

	it("reports an address whose postal-zone reference is empty rather than yielding it", async () => {
		const manifest = await run()

		// `componentHrefs` skips an empty href, so an unwary reader yields this row
		// with the postcode simply missing.
		// The row is refused instead, and the count is the difference between the ten
		// addresses in the fixture and the nine rows.
		expect(manifest.yielded).toBe(9)

		const rows = await readCanonicalRows(scratch.path, BRUSSELS_ADAPTER_ID)

		expect(rows.some((row) => row.source_id === "brussels-BE.BRUSSELS.BRIC.ADM.ADPT.220623")).toBe(false)
		expect(rows.every((row) => Boolean(row.components.postcode))).toBe(true)
		// Its street and municipality resolve, so the postcode is the one value that refused it.
		expect(rows.some((row) => row.raw.includes("Rue de la Loi"))).toBe(false)
	})

	it("honors --limit", async () => {
		const manifest = await run({ limit: 3 })

		expect(manifest.yielded).toBe(3)
	})

	it("stops at an aborted signal", async () => {
		const controller = new AbortController()

		controller.abort()

		// Asked of the adapter rather than of the runner.
		// The runner refuses an aborted write of its own.
		const rows = await Array.fromAsync(createBrusselsAdapter().rows({ inputPath: fixture, signal: controller.signal }))

		expect(rows).toEqual([])
	})

	it("accepts --country BE, the one jurisdiction the download publishes", async () => {
		const manifest = await run({ country: "BE" })

		expect(manifest.yielded).toBe(9)
	})

	it("rejects a jurisdiction this download does not publish", async () => {
		// Flanders and Wallonia publish the theme through their own services,
		// so a Belgian build reads this row for the Brussels-Capital Region only.
		await expect(run({ country: "NL" })).rejects.toThrow(/the dataset covers BE, got country=NL/)
	})

	it("two runs over the same member produce identical sha256", async () => {
		const a = await run()

		await removePathIfPresent(scratch.path(BRUSSELS_ADAPTER_ID))

		const b = await run()

		expect(a.sha256).toBe(b.sha256)
	})
})
