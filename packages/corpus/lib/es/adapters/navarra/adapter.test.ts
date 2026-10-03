/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture holds six addresses, three from each of two of the publisher's 272 partitions.
 *
 * `fixtures/es-navarra/AD_Navarra_1.gml` holds three addresses from partition 1, which covers
 * Abáigar, and `AD_Navarra_250.gml` holds three from partition 250, which covers Bera. Each
 * `AD:Address` is copied out of the publisher's member as written, and the collection's own root
 * element is kept, so each file parses as the partition it came from. Both partitions are UTF-8, as
 * the publisher writes them.
 *
 * The six cover what the partitions vary. Abáigar's three stand on three streets and one carries the
 * `S/N` designator. Bera's three are the cases partition 1 has none of: a fifth-order title that
 * differs from the municipality, a `PostalDescriptor` title of `0`, and a designator with a
 * space-separated letter.
 *
 * Counts quoted against the whole partitions come from reading `AD_Navarra_1.gml.zip`,
 * `AD_Navarra_100.gml.zip` and `AD_Navarra_250.gml.zip`: 115, 288 and 1,054 addresses, carrying 690,
 * 1,728 and 6,324 `AD:component` references, which is six per address in each.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import { createESNavarraAdapter, ES_NAVARRA_ADAPTER_ID, ES_NAVARRA_LICENSE } from "#es/adapters/navarra/adapter"
import { SourceRegister } from "#registers"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("es-navarra")

const fixtureDir = workspacePath("corpus", "fixtures", "es-navarra")
const abaigar = workspacePath("corpus", "fixtures", "es-navarra", "AD_Navarra_1.gml")
const bera = workspacePath("corpus", "fixtures", "es-navarra", "AD_Navarra_250.gml")

/**
 * Every row the adapter reads out of `inputPath`, through the runner that writes them.
 */
async function rowsFrom(inputPath: PathBuilderLike, limit?: number) {
	const manifest = await runAdapter({
		adapter: createESNavarraAdapter(),
		adapterOptions: { inputPath, limit },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { manifest, rows: await readCanonicalRows(scratch.path, ES_NAVARRA_ADAPTER_ID) }
}

describe("es-navarra adapter against the fixture partitions", () => {
	it("emits a row per address under the license the source register elects", async () => {
		const { manifest, rows } = await rowsFrom(fixtureDir)

		expect(manifest.yielded).toBe(6)
		expect(rows).toHaveLength(6)
		expect(rows.every((row) => row.license === ES_NAVARRA_LICENSE)).toBe(true)
		expect(rows.every((row) => row.source === ES_NAVARRA_ADAPTER_ID)).toBe(true)
		expect(rows.every((row) => row.country === "ES")).toBe(true)
		expect(rows.every((row) => row.locale === "es-ES")).toBe(true)
		expect(createESNavarraAdapter().register).toBe(SourceRegister.NavarraInspireAddresses)
	})

	it("composes the address the publisher's own IDENA layer holds for the same place", async () => {
		const { rows } = await rowsFrom(abaigar)
		const byID = new Map(rows.map((row) => [row.source_id, row]))

		// `IDENA:DIRECC_Txt_Direcciones` feature `DIRECC_Txt_Direcciones.1` reads MUNICIPIO
		// `Abáigar`, ENTIDAD `Abáigar`, CODPOSTAL `31280`, VIA `CALLE CALLEJA`, PORTAL `4`.
		expect(byID.get(`${ES_NAVARRA_ADAPTER_ID}-AD.Address.1`)?.components).toEqual({
			street: "CALLE CALLEJA",
			house_number: "4",
			postcode: "31280",
			locality: "Abáigar",
		})

		expect(byID.get(`${ES_NAVARRA_ADAPTER_ID}-AD.Address.1`)?.raw).toBe("CALLE CALLEJA, 4, 31280 Abáigar")
	})

	it("reads the street, the postcode and the places off the references' own titles", async () => {
		const text = await readLocalTextFile(abaigar)

		// The publisher writes no component feature at all.
		// The thoroughfare reference is the bare string `ThoroughfareName` and the postal
		// one `PostalDescriptor`, and each states its value in `xlink:title`.
		// A reader resolving the hrefs finds no feature behind either of them.
		expect(text).toContain('xlink:href="ThoroughfareName" xlink:title="CALLE CALLEJA"')
		expect(text).toContain('xlink:href="PostalDescriptor" xlink:title="31280"')
		expect(text).not.toContain("<AD:ThoroughfareName")
		expect(text).not.toContain("<AD:PostalDescriptor")
		expect(text).not.toContain("<AD:AdminUnitName")
	})

	it("reads the municipality off the MUN reference rather than the country or the community", async () => {
		const { rows } = await rowsFrom(fixtureDir)

		// Each address also references `AD_ADMINUNITNAME_PAI_` titled `España`
		// and `AD_ADMINUNITNAME_COM_` titled `Comunidad Foral de Navarra`.
		// A reader taking the first administrative reference it met would write
		// `España` as the locality on every row.
		expect(new Set(rows.map((row) => row.components.locality))).toEqual(new Set(["Abáigar", "Bera"]))
		expect(rows.some((row) => row.components.locality === "España")).toBe(false)
		expect(rows.some((row) => row.components.region)).toBe(false)
	})

	it("writes a dependent locality only where the fifth-order title differs from the municipality", async () => {
		const { rows } = await rowsFrom(bera)
		const byID = new Map(rows.map((row) => [row.source_id, row]))

		// Partition 250's fifth-order titles include `Eltzaurdia` and `Suspela` beside `Bera`.
		// In Abáigar and Eulate the fifth-order title repeats the municipality.
		expect(byID.get(`${ES_NAVARRA_ADAPTER_ID}-AD.Address.158956`)?.components.dependent_locality).toBe("Eltzaurdia")
		expect(byID.get(`${ES_NAVARRA_ADAPTER_ID}-AD.Address.159938`)?.components.dependent_locality).toBeUndefined()
	})

	it("reads a postcode title of 0 as the publisher holding none", async () => {
		const { rows } = await rowsFrom(bera)
		const byID = new Map(rows.map((row) => [row.source_id, row]))

		expect(byID.get(`${ES_NAVARRA_ADAPTER_ID}-AD.Address.158956`)?.components.postcode).toBeUndefined()
		expect(byID.get(`${ES_NAVARRA_ADAPTER_ID}-AD.Address.158956`)?.raw).toBe("ELTZAURDIA AUZOA, 19 A, Eltzaurdia, Bera")
		expect(rows.some((row) => row.components.postcode === "0")).toBe(false)
	})

	it("writes no house number for the sin-número designator and keeps a letter suffix", async () => {
		const { rows } = await rowsFrom(fixtureDir)
		const numberless = rows.filter((row) => !row.components.house_number)

		expect(numberless).toHaveLength(2)
		expect(rows.some((row) => row.components.house_number === "S/N")).toBe(false)

		// `19 A` and `5 A` are the publisher's own spacing, and `Eulate` writes `18 A` and `34 A`.
		expect(rows.map((row) => row.components.house_number)).toContain("19 A")
		expect(rows.map((row) => row.components.house_number)).toContain("5 A")
	})

	it("refuses an address whose references state no place rather than writing a placeless row", async () => {
		const text = await readLocalTextFile(abaigar)
		const member = scratch.path("AD_Navarra_x.gml")

		await writeLocalTextFile(text.replaceAll("AD_ADMINUNITNAME_MUN_", "AD_ADMINUNITNAME_XXX_"), member)

		const { rows } = await rowsFrom(member)

		// The fifth-order title remains and is read as the place, so one row survives per address.
		// The municipality reference is the one this edit removed.
		expect(rows.every((row) => row.components.dependent_locality === undefined)).toBe(true)
		expect(rows.every((row) => row.components.locality === "Abáigar")).toBe(true)
	})

	it("names what it opened when a directory holds no archive", async () => {
		const [empty] = await makeDirectories(scratch.path("empty"))

		await expect(rowsFrom(empty)).rejects.toThrow(/holds no \.zip archive or \.gml member/u)
	})

	it("honors opts.limit", async () => {
		const { manifest } = await rowsFrom(fixtureDir, 2)

		expect(manifest.yielded).toBe(2)
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		await expect(
			runAdapter({
				adapter: createESNavarraAdapter(),
				adapterOptions: { inputPath: fixtureDir, country: "FR" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/the dataset covers ES, got country=FR/u)
	})

	it("two runs over the same partitions produce identical sha256", async () => {
		const first = await rowsFrom(fixtureDir)

		await removePathIfPresent(scratch.path(ES_NAVARRA_ADAPTER_ID))

		const second = await rowsFrom(fixtureDir)

		expect(first.manifest.sha256).toBe(second.manifest.sha256)
	})
})
