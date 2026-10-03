/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture is both halves of this publisher's join, which is what makes it worth having.
 *
 * `fixtures/es-bizkaia/ES.BFA.AD.001.gml` holds five `ad:Address` features copied out of the member
 * of `ES.BFA.AD.001.zip`, Abadiño's archive, and `components.gml` holds the seven features they
 * reference, copied out of three `GetFeature` responses from
 * `https://geo.bizkaia.eus/arcgisserverinspire/…`. The addresses and the features they name are in
 * different files on the publisher's side too, and the suite therefore exercises the cross-file join
 * rather than simulating it.
 *
 * One change was made to the address file and it is stated here, because the rest is the publisher's
 * text: the archive's member uses CRLF line endings and the fixture uses LF. The component file is
 * byte-for-byte as the service served it.
 *
 * The five addresses are one of each shape the designator's number field takes, which this
 * publisher's adapter header tabulates: `003`, `008A`, `001BIS`, `033005` and `019A02`. Their
 * `ad:LocatorName` values are the publisher's own cross-rendering, and
 * `reconstructs the publisher's own LocatorName from the joined street and the designator` puts the
 * composed street and number back against them.
 *
 * Counts quoted against the whole publication come from reading `ES.BFA.AD.001.zip`, 108,458 bytes,
 * whose member is 5,916,116 bytes holding 1,360 addresses, and from the WFS: 6,921
 * `ad:ThoroughfareName`, 96 `ad:PostalDescriptor` and 113 `ad:AdminUnitName` features, all 113 of
 * the last at `3rdOrder`.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { copyFileTo, makeDirectories, removePathIfPresent, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { streamMarkupElements } from "@mailwoman/core/html/elements"
import { workspacePath } from "@mailwoman/core/paths"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	bizkaiaHouseNumber,
	bizkaiaStreet,
	bizkaiaStreetCode,
	createESBizkaiaAdapter,
	ES_BIZKAIA_ADAPTER_ID,
	ES_BIZKAIA_LICENSE,
} from "#es/adapters/bizkaia/adapter"
import { designator, designatorsByType, geographicalNameText, inspireElementAt } from "#inspire/address"
import { InspireArchiveError, UnresolvedComponentReferenceError } from "#inspire/errors"
import { SourceRegister } from "#registers"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("es-bizkaia")

const fixtureDir = workspacePath("corpus", "fixtures", "es-bizkaia")
const addresses = workspacePath("corpus", "fixtures", "es-bizkaia", "ES.BFA.AD.001.gml")
const components = workspacePath("corpus", "fixtures", "es-bizkaia", "components.gml")

/**
 * Every row the adapter reads out of `inputPath`, through the runner that writes them.
 */
async function rowsFrom(inputPath: PathBuilderLike, limit?: number) {
	const manifest = await runAdapter({
		adapter: createESBizkaiaAdapter(),
		adapterOptions: { inputPath, limit },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { manifest, rows: await readCanonicalRows(scratch.path, ES_BIZKAIA_ADAPTER_ID) }
}

describe("es-bizkaia adapter against the fixture archive and WFS pages", () => {
	it("emits a row per address under the license the source register elects", async () => {
		const { manifest, rows } = await rowsFrom(fixtureDir)

		expect(manifest.yielded).toBe(5)
		expect(rows).toHaveLength(5)
		expect(rows.every((row) => row.license === ES_BIZKAIA_LICENSE)).toBe(true)
		expect(rows.every((row) => row.source === ES_BIZKAIA_ADAPTER_ID)).toBe(true)
		expect(rows.every((row) => row.country === "ES")).toBe(true)
		expect(rows.every((row) => row.locale === "es-ES")).toBe(true)
		expect(createESBizkaiaAdapter().register).toBe(SourceRegister.BizkaiaInspireAddresses)
	})

	it("joins the street out of the saved WFS page, which the archive does not carry", async () => {
		const { rows } = await rowsFrom(fixtureDir)
		const byID = new Map(rows.map((row) => [row.source_id, row]))

		expect(byID.get(`${ES_BIZKAIA_ADAPTER_ID}-adAddress.1`)?.components).toEqual({
			street: "BO MURUETA",
			house_number: "3",
			postcode: "48220",
			locality: "ABADIÑO",
		})

		expect(byID.get(`${ES_BIZKAIA_ADAPTER_ID}-adAddress.1`)?.raw).toBe("BO MURUETA, 3, 48220 ABADIÑO")
	})

	it("reconstructs the publisher's own LocatorName from the joined street and the designator", async () => {
		const thoroughfares = new Map<string, string>()

		for await (const feature of streamMarkupElements(openReadStream(components), "ad:ThoroughfareName", {
			xml: true,
		})) {
			const street = bizkaiaStreet(feature)
			const code = bizkaiaStreetCode(feature)

			if (street && code) {
				thoroughfares.set(`${street}\u0000${code}`, feature.attributes["gml:id"] ?? "")
			}
		}

		let checked = 0

		for await (const address of streamMarkupElements(openReadStream(addresses), "ad:Address", { xml: true })) {
			const locator = inspireElementAt(address, "ad:locator", "ad:AddressLocator", "ad:name", "ad:LocatorName")
			const stated = locator ? geographicalNameText(locator, "ad:name") : undefined
			const byType = designatorsByType(address)
			const fields = (designator(byType, "buildingIdentifier") ?? "").split(".")

			expect(fields).toHaveLength(4)

			// The archive states `48 001 BO\MURUETA(00026) 003` inside the address,
			// while the street itself comes from a separate WFS document.
			// Rebuilding that string from the joined feature and the designator's fields
			// therefore checks the join rather than copying it.
			const joined = [...thoroughfares.keys()].find((key) => key.endsWith(`\u0000${Number(fields[2])}`))
			const [street, code] = (joined ?? "").split("\u0000")

			expect(`${fields[0]} ${fields[1]} ${street?.replace(" ", "\\")}(${code?.padStart(5, "0")}) ${fields[3]}`).toBe(
				stated
			)

			checked++
		}

		expect(checked).toBe(5)
	})

	it("writes the designator's number field with its fixed-width padding removed", async () => {
		const { rows } = await rowsFrom(fixtureDir)

		// The five shapes the field takes, in the order the fixture writes them.
		// The last two carry a second field whose meaning the publisher states nowhere, so the row
		// transcribes the publisher's own concatenation rather than splitting it on a guessed separator.
		expect(rows.map((row) => row.components.house_number)).toEqual(["3", "8A", "1BIS", "33005", "19A02"])

		expect(bizkaiaHouseNumber(new Map([["buildingIdentifier", ["48.001.00026.003"]]]))).toBe("3")
		expect(bizkaiaHouseNumber(new Map([["buildingIdentifier", ["48.001.00024.033005"]]]))).toBe("33005")
		expect(bizkaiaHouseNumber(new Map([["buildingIdentifier", ["48.001.00026"]]]))).toBeUndefined()
		expect(bizkaiaHouseNumber(new Map())).toBeUndefined()
	})

	it("strips the cadastral decoration off a thoroughfare name and keeps the type abbreviation", async () => {
		const text = await readLocalTextFile(components)

		// All 6,921 thoroughfare names take the form `XX\NAME(code)`.
		expect(text).toContain("<gn:text>BO\\MURUETA(26)</gn:text>")

		const { rows } = await rowsFrom(fixtureDir)

		expect(rows.map((row) => row.components.street)).toEqual([
			"BO MURUETA",
			"CL SAN ANDRES",
			"CL ZUBIBITARTE",
			"BO ASTOLA",
			"CL ARRANKURRI",
		])

		expect(rows.every((row) => !row.components.street?.includes("("))).toBe(true)
		expect(rows.every((row) => !row.components.street?.includes("\\"))).toBe(true)
	})

	it("reads the municipality at the third order, which is the only level this service publishes", async () => {
		const text = await readLocalTextFile(components)
		const { rows } = await rowsFrom(fixtureDir)

		// Czechia, Slovakia and Gipuzkoa write the municipality at `4thOrder`.
		// A reader keyed on that level finds no municipality here, and every row would carry no locality.
		expect(text).toContain("AdministrativeHierarchyLevel/3rdOrder")
		expect(text).not.toContain("AdministrativeHierarchyLevel/4thOrder")
		expect(rows.every((row) => row.components.locality === "ABADIÑO")).toBe(true)
	})

	it("raises when the component pages are absent rather than yielding addresses without their place", async () => {
		const [addressesOnly] = await makeDirectories(scratch.path("addresses-only"))

		await copyFileTo(addresses, scratch.path("addresses-only", "ES.BFA.AD.001.gml"))

		await expect(rowsFrom(addressesOnly)).rejects.toThrow(InspireArchiveError)
		await expect(rowsFrom(addressesOnly)).rejects.toThrow(/holds no component feature/u)
	})

	it("raises on a reference that resolves to no feature", async () => {
		const [partial] = await makeDirectories(scratch.path("partial"))

		await copyFileTo(addresses, scratch.path("partial", "ES.BFA.AD.001.gml"))

		// The postal descriptor alone.
		// Every address's thoroughfare reference then resolves to no feature while the index holds one.
		const text = await readLocalTextFile(components)

		const postalOnly = text.replaceAll(
			/<wfs:member>\s*<ad:(?:ThoroughfareName|AdminUnitName)[\s\S]*?<\/wfs:member>/gu,
			""
		)

		await writeLocalTextFile(postalOnly, scratch.path("partial", "components.gml"))

		await expect(rowsFrom(partial)).rejects.toThrow(UnresolvedComponentReferenceError)
	})

	it("names what it opened when a directory holds no input", async () => {
		const [empty] = await makeDirectories(scratch.path("empty"))

		await expect(rowsFrom(empty)).rejects.toThrow(/holds no \.zip archive or saved WFS page/u)
	})

	it("honors opts.limit", async () => {
		const { manifest } = await rowsFrom(fixtureDir, 2)

		expect(manifest.yielded).toBe(2)
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		await expect(
			runAdapter({
				adapter: createESBizkaiaAdapter(),
				adapterOptions: { inputPath: fixtureDir, country: "FR" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/the dataset covers ES, got country=FR/u)
	})

	it("two runs over the same inputs produce identical sha256", async () => {
		const first = await rowsFrom(fixtureDir)

		await removePathIfPresent(scratch.path(ES_BIZKAIA_ADAPTER_ID))

		const second = await rowsFrom(fixtureDir)

		expect(first.manifest.sha256).toBe(second.manifest.sha256)
	})
})
