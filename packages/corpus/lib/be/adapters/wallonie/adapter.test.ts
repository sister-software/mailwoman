/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture at `fixtures/wallonie/AD.Addresses.gml` is ten addresses and the fifteen component
 *   features they reference, extracted from the publisher's own file.
 *
 *   Every byte is the Service public de Wallonie's own. It was taken on 2026-10-02 from
 *   `https://geoservices.wallonie.be/geotraitement/spwdatadownload/results/b62f8405-2ce3-449f-8a61-5fc2f38d8b73/AD.Addresses.gml.zip`,
 *   106,665,832 bytes, sha256 `8eebae71d793632c22c9902e8420bc50e0e572c97de15b7d10051b29b59e208a`, which
 *   is the archive the address-source register records for `be-property-building-2`. The fixture is
 *   that archive's member `AD.Addresses.gml` with its own XML declaration, root element and
 *   `gml:boundedBy` kept, holding 25 of its 1,830,903 `gml:featureMember` elements verbatim. Every
 *   byte stands as the publisher wrote it: `diff` against the extraction reports no difference.
 *
 *   It keeps the publisher's member order, every address before any component, because that order is
 *   what makes the join take two passes. A fixture with the components first would pass a one-pass
 *   reader that the 5,163,917,131-byte file defeats.
 *
 *   The ten addresses show the defects and the shapes the file writes: `ad:validTo` and
 *   `ad:endLifespanVersion` void with a `nilReason` on every one, a populated
 *   `addressNumberExtension` on every one (`B001`, `C003`, `D004`, `0001`, `0RCH`, `B002`, `0002`,
 *   `A002`, `008B`, `BP3`), which the whole archive writes a value in on 347,859 of its addresses, two
 *   addresses differing only by that extension, nine municipality references to Braine-l'Alleud and
 *   one to Beauvechain. Beauvechain's `ad:AddressAreaName` is a different name (`Hamme-Mille`) and
 *   therefore a dependent locality. The two `#BE.AdminUnitName.1000` and `#BE.AdminUnitName.3000`
 *   references to the country and the region that every address in the file writes.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import {
	createWallonieAdapter,
	readWallonieComponents,
	WALLONIE_ADAPTER_ID,
	WALLONIE_DEFAULT_LICENSE,
	WALLONIE_SOURCE_REGISTER,
} from "#be/adapters/wallonie/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("wallonie")

const fixture = workspacePath("corpus", "fixtures", "wallonie", "AD.Addresses.gml")

function run(adapterOptions: Partial<Parameters<typeof runAdapter>[0]["adapterOptions"]> = {}) {
	return runAdapter({
		adapter: createWallonieAdapter(),
		adapterOptions: { inputPath: fixture, ...adapterOptions },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})
}

describe("wallonie adapter against the fixture member", () => {
	it("emits a row per address under the elected CC BY 4.0", async () => {
		const manifest = await run()

		// Ten addresses, all readable.
		// Two of them differ only by the `addressNumberExtension` the rendered line leaves out,
		// so they render one line and the runner's own dedup writes nine.
		expect(manifest.yielded).toBe(10)
		expect(manifest.written).toBe(9)

		const rows = await readCanonicalRows(scratch.path, WALLONIE_ADAPTER_ID)

		expect(rows).toHaveLength(9)
		expect(rows.every((row) => row.license === WALLONIE_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((row) => row.source === WALLONIE_ADAPTER_ID)).toBe(true)
		expect(rows.every((row) => row.register === WALLONIE_SOURCE_REGISTER)).toBe(true)
		expect(rows.every((row) => row.country === "BE")).toBe(true)
		expect(rows.every((row) => row.locale === "fr-BE")).toBe(true)
	})

	it("reads the house number from Wallonia's own designator type", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, WALLONIE_ADAPTER_ID)

		// Each address writes two typed designators.
		// `addressIdentifierGeneral` is the number and `addressNumberExtension` is the letterbox code,
		// and the number is selected by its type rather than by being the first designator present.
		expect(rows.map((row) => row.components.house_number)).toEqual([
			"93",
			"103",
			"17",
			"52",
			"73",
			"104",
			"30",
			"4",
			"5A",
		])

		// `5A` is one designator value rather than a number and a letter in two columns.
		expect(rows.find((row) => row.source_id === "wallonie-BE.WL.ICAR.Address.1521851")?.components.house_number).toBe(
			"5A"
		)
	})

	it("leaves the letterbox extension out of the rendered line", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, WALLONIE_ADAPTER_ID)

		// `B001`, `0RCH` and `008B` are the extensions of three of these addresses.
		// Over the whole archive the element is written on all 1,772,312 addresses and holds a
		// value on 347,859, so appending it to the number would invent a surface for those rows.
		expect(rows.some((row) => /B001|0RCH|008B|BP3/u.test(row.raw))).toBe(false)
		expect(rows.every((row) => row.components.unit === undefined)).toBe(true)

		// The two addresses differing only by extension kept distinct ids upstream of the runner's
		// dedup, so the duplication is visible rather than silently collapsed inside the adapter.
		expect(rows.find((row) => row.raw === "Chaussée Reine Astrid 93, 1420 Braine-l'Alleud")?.source_id).toBe(
			"wallonie-BE.WL.ICAR.Address.1522363"
		)
	})

	it("joins street, postcode, locality and address area through the local fragments", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, WALLONIE_ADAPTER_ID)
		const first = rows.find((row) => row.source_id === "wallonie-BE.WL.ICAR.Address.1522363")

		expect(first?.raw).toBe("Chaussée Reine Astrid 93, 1420 Braine-l'Alleud")

		expect(first?.components).toEqual({
			house_number: "93",
			street: "Chaussée Reine Astrid",
			postcode: "1420",
			locality: "Braine-l'Alleud",
		})

		// The second street and postcode prove the values come from the referenced features
		// rather than from the first of each that the pass read.
		const other = rows.find((row) => row.source_id === "wallonie-BE.WL.ICAR.Address.1521851")

		expect(other?.raw).toBe("Rue Auguste Goemans 5A, Hamme-Mille, 1320 Beauvechain")

		expect(other?.components).toEqual({
			house_number: "5A",
			street: "Rue Auguste Goemans",
			dependent_locality: "Hamme-Mille",
			postcode: "1320",
			locality: "Beauvechain",
		})
	})

	it("writes the address area as a dependent locality only where it is a different name", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, WALLONIE_ADAPTER_ID)

		// `BE.WL.ICAR.AddressAreaName.231` is `Braine-l'Alleud`, the same name as its municipality,
		// so nine rows state no dependent locality and the tenth states `Hamme-Mille`.
		expect(rows.filter((row) => row.components.dependent_locality !== undefined)).toHaveLength(1)
		expect(rows.some((row) => row.raw.includes("Braine-l'Alleud, 1420 Braine-l'Alleud"))).toBe(false)
	})

	it("takes the locality from the municipality-level unit, not the country or the region", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, WALLONIE_ADAPTER_ID)

		// Every address also references `BE.AdminUnitName.1000` (`Belgique`, `1stOrder`)
		// and `BE.AdminUnitName.3000` (`Région wallonne`, `2ndOrder`).
		expect(rows.every((row) => ["Braine-l'Alleud", "Beauvechain"].includes(row.components.locality ?? ""))).toBe(true)

		expect(rows.some((row) => /Belgique|Belgien|België|wallonne|Wallonische|Waals/u.test(row.raw))).toBe(false)
	})

	it("indexes the component features and leaves the country and region out", async () => {
		const index = await readWallonieComponents(fixture)

		expect(index.streets.size).toBe(7)
		expect(index.postcodes.size).toBe(2)
		expect(index.areas.size).toBe(2)
		expect(index.streets.get("BE.WL.ICAR.ThoroughfareName.7700328")).toBe("Chaussée Reine Astrid")
		expect(index.postcodes.get("BE.WL.ICAR.PostalDescriptor.1320")).toBe("1320")
		expect(index.areas.get("BE.WL.ICAR.AddressAreaName.633")).toBe("Hamme-Mille")

		// Three `ad:AdminUnitName` features are in the fixture and only the two municipalities
		// are indexed, because the country and the region sit at `1stOrder` and `2ndOrder`.
		expect([...index.municipalities.values()].toSorted()).toEqual(["Beauvechain", "Braine-l'Alleud"])
		expect(index.municipalities.has("BE.AdminUnitName.1000")).toBe(false)
		expect(index.municipalities.has("BE.AdminUnitName.3000")).toBe(false)
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
		const rows = await Array.fromAsync(createWallonieAdapter().rows({ inputPath: fixture, signal: controller.signal }))

		expect(rows).toEqual([])
	})

	it("accepts --country BE, the one jurisdiction the service publishes", async () => {
		const manifest = await run({ country: "BE" })

		expect(manifest.yielded).toBe(10)
	})

	it("rejects a jurisdiction this service does not publish", async () => {
		// Flanders and Brussels publish the theme through their own services,
		// so a Belgian build reads this row for the Walloon Region only.
		await expect(run({ country: "FR" })).rejects.toThrow(/the dataset covers BE, got country=FR/)
	})

	it("two runs over the same member produce identical sha256", async () => {
		const a = await run()

		await removePathIfPresent(scratch.path(WALLONIE_ADAPTER_ID))

		const b = await run()

		expect(a.sha256).toBe(b.sha256)
	})
})
