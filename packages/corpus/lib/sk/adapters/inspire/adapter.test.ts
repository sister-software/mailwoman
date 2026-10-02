/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture is the service's own response text, in the two documents a build saves.
 *
 * `fixtures/sk-inspire/addresses.gml` holds twelve `wfs:member` elements copied byte for byte out of
 * four `GetFeature` pages of `ad:Address` on `https://rageo.minv.sk/geoserver/ad/wfs`, and
 * `components.gml` holds the twenty-three features they reference, fetched by `resourceID` from the
 * same service. Each file opens with a served `wfs:FeatureCollection` root element, so its
 * `numberMatched`, `numberReturned` and `timeStamp` describe the request its root came from rather
 * than the file. The reader consults none of the three.
 *
 * The twelve cover what the service varies: four street-bearing addresses that write both an
 * `addressNumber` and a `buildingIdentifier`, four street-less addresses whose `ad:AddressAreaName`
 * states a settlement part other than the municipality, two street-less addresses that reference no
 * address area at all, and one of each from a fourth page.
 *
 * The two files together are also the point of the split: an address in one document references a
 * feature in the other, so the suite exercises the join across documents that the service's paging
 * forces.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { copyFileTo, makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import { UnresolvedComponentReferenceError } from "#inspire/errors"
import { runAdapter } from "#runner"
import {
	createSKInspireAdapter,
	SK_INSPIRE_ADAPTER_ID,
	SK_INSPIRE_DEFAULT_LICENSE,
	SK_INSPIRE_REGISTER,
	slovakHouseNumber,
} from "#sk/adapters/inspire/adapter"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("sk-inspire")

const fixtureDir = workspacePath("corpus", "fixtures", "sk-inspire")
const addressesFixture = workspacePath("corpus", "fixtures", "sk-inspire", "addresses.gml")
const componentsFixture = workspacePath("corpus", "fixtures", "sk-inspire", "components.gml")

/**
 * Every row the adapter reads out of `inputPath`, through the runner that writes them.
 */
async function rowsFrom(inputPath: PathBuilderLike, limit?: number) {
	const manifest = await runAdapter({
		adapter: createSKInspireAdapter(),
		adapterOptions: { inputPath, limit },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { manifest, rows: await readCanonicalRows(scratch.path, SK_INSPIRE_ADAPTER_ID) }
}

describe("sk-inspire adapter against the fixture WFS pages", () => {
	it("emits a row per address under the license the source register elects", async () => {
		const { manifest, rows } = await rowsFrom(fixtureDir)

		expect(manifest.yielded).toBe(12)
		expect(rows).toHaveLength(12)
		expect(rows.every((r) => r.license === SK_INSPIRE_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((r) => r.source === SK_INSPIRE_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.country === "SK")).toBe(true)
		expect(rows.every((r) => r.locale === "sk-SK")).toBe(true)
		expect(createSKInspireAdapter().register).toBe(SK_INSPIRE_REGISTER)
	})

	it("composes the number the way the publisher's own register renders it", async () => {
		const { rows } = await rowsFrom(fixtureDir)
		const byID = new Map(rows.map((r) => [r.source_id, r]))

		// The Ministry's `ra:address` layer on the same GeoServer writes `fulladdress`
		// `Lipová,1760/29,Hurbanovo,94701` for this record and `142,Sikenička,94359` for
		// the street-less one, so the solidus and its absence are the publisher's.
		expect(byID.get(`${SK_INSPIRE_ADAPTER_ID}-Address.1962683`)?.components).toEqual({
			street: "Lipová",
			house_number: "1760/29",
			postcode: "94701",
			locality: "Hurbanovo",
		})

		expect(byID.get(`${SK_INSPIRE_ADAPTER_ID}-Address.2209591`)?.components).toEqual({
			house_number: "142",
			postcode: "94359",
			locality: "Sikenička",
		})
	})

	it("selects a designator by its type rather than by its position", async () => {
		const text = (await readLocalBuffer(addressesFixture)).toString("utf8")

		// `ad:designator` repeats and states no position.
		// One address writes the descriptive number first and another writes it with no
		// orientation number at all, so only `ad:type` separates the two values.
		expect(text).toContain("LocatorDesignatorTypeValue/addressNumber")
		expect(text).toContain("LocatorDesignatorTypeValue/buildingIdentifier")

		expect(
			slovakHouseNumber(
				new Map([
					["addressNumber", ["1760"]],
					["buildingIdentifier", ["29"]],
				])
			)
		).toBe("1760/29")

		expect(
			slovakHouseNumber(
				new Map([
					["buildingIdentifier", ["29"]],
					["addressNumber", ["1760"]],
				])
			)
		).toBe("1760/29")

		expect(slovakHouseNumber(new Map([["addressNumber", ["142"]]]))).toBe("142")
		expect(slovakHouseNumber(new Map([["buildingIdentifier", ["29"]]]))).toBeUndefined()
	})

	it("keeps a street-less address, which two thirds of the service's addresses are", async () => {
		const { rows } = await rowsFrom(fixtureDir)
		const streetless = rows.filter((r) => !r.components.street)

		// Measured over 1,000 addresses across ten windows of the 1,704,196:
		// 666 reference no `ad:ThoroughfareName`.
		// A reader refusing those would drop two rows in three.
		expect(streetless).toHaveLength(7)

		expect(streetless.map((r) => r.raw)).toEqual([
			"69, Lidér Tejed, 92901 Povoda",
			"70, Lidér Tejed, 92901 Povoda",
			"71, Lidér Tejed, 92901 Povoda",
			"72, Lidér Tejed, 92901 Povoda",
			"142, 94359 Sikenička",
			"143, 94359 Sikenička",
			"600, 90063 Jakubov",
		])
	})

	it("reads the municipality by its administrative level", async () => {
		const components = (await readLocalBuffer(componentsFixture)).toString("utf8")
		const { rows } = await rowsFrom(fixtureDir)

		// One address references a region, a district and a municipality,
		// and the `xlink:title` of each repeats its name.
		// A reader taking the first admin unit it resolved would write `Nitriansky`
		// or `Komárno` where the address states `Hurbanovo`.
		expect(components).toContain("AdministrativeHierarchyLevel/2ndOrder")
		expect(components).toContain("AdministrativeHierarchyLevel/3rdOrder")
		expect(components).toContain("AdministrativeHierarchyLevel/4thOrder")

		expect(rows.find((r) => r.source_id.endsWith("Address.1962683"))?.components.locality).toBe("Hurbanovo")
		expect(rows.some((r) => r.components.locality === "Nitriansky")).toBe(false)
		expect(rows.some((r) => r.components.locality === "Komárno")).toBe(false)
	})

	it("writes a dependent locality only where the settlement part differs from the municipality", async () => {
		const { rows } = await rowsFrom(fixtureDir)

		// 426 of 1,080 addresses measured reference an address area. 325 of those
		// repeat the municipality and 101 state another place.
		expect(rows.find((r) => r.source_id.endsWith("Address.1843008"))?.components.dependent_locality).toBe("Lidér Tejed")

		expect(rows.find((r) => r.source_id.endsWith("Address.1962683"))?.components.dependent_locality).toBeUndefined()
	})

	it("keeps the leading zero the publisher writes on a postcode", async () => {
		const { rows } = await rowsFrom(fixtureDir)

		// `PostalDescriptor.4018` states `<ad:postCode>04018</ad:postCode>`,
		// so the code is five digits and the feature's own id is not.
		expect(rows.find((r) => r.source_id.endsWith("Address.4208424"))?.components.postcode).toBe("04018")

		expect(rows.find((r) => r.source_id.endsWith("Address.4208424"))?.raw).toBe("Skalická 1771/4, 04018 Košice-Krásna")
	})

	it("raises when the component pages are absent rather than yielding addresses without their place", async () => {
		const addressesOnly = scratch.path("addresses.gml")

		await copyFileTo(addressesFixture, addressesOnly)

		await expect(rowsFrom(addressesOnly)).rejects.toThrow(UnresolvedComponentReferenceError)
		await expect(rowsFrom(addressesOnly)).rejects.toThrow(/address Address\.1962683 carries ad:component/)
	})

	it("names what it opened when a directory holds no document", async () => {
		const [empty] = await makeDirectories(scratch.path("empty"))

		await expect(rowsFrom(empty)).rejects.toThrow(/holds no GML document/)
	})

	it("honors opts.limit", async () => {
		const { manifest } = await rowsFrom(fixtureDir, 3)

		expect(manifest.yielded).toBe(3)
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		await expect(
			runAdapter({
				adapter: createSKInspireAdapter(),
				adapterOptions: { inputPath: fixtureDir, country: "CZ" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/the dataset covers SK, got country=CZ/)
	})

	it("accepts the one jurisdiction the dataset covers", async () => {
		const manifest = await runAdapter({
			adapter: createSKInspireAdapter(),
			adapterOptions: { inputPath: fixtureDir, country: "SK" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(12)
	})

	it("two runs over the same pages produce identical sha256", async () => {
		const first = await rowsFrom(fixtureDir)

		await removePathIfPresent(scratch.path(SK_INSPIRE_ADAPTER_ID))

		const second = await rowsFrom(fixtureDir)

		expect(first.manifest.sha256).toBe(second.manifest.sha256)
	})
})
