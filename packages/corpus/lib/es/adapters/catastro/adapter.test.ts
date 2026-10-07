/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture holds six of Ceuta's own addresses and the seven features they reference.
 *
 * `fixtures/es-catastro/A.ES.SDGC.AD.55101.gml` holds six `AD:Address` elements and the seven
 * `AD:ThoroughfareName`, `AD:PostalDescriptor` and `AD:AdminUnitName` features they name, copied out
 * of `A.ES.SDGC.AD.55101.zip` as the publisher wrote them. Two changes were made and both are
 * stated here, because the rest is the publisher's text: a byte above 0x7F is written as its XML
 * numeric character reference, so the file reads as ASCII while denoting the same characters, and
 * trailing whitespace at the end of a line is gone. Neither changes what the parser sees.
 *
 * The six cover what the member varies. Two addresses on `CL SANTIAGO APOSTOL` have a plain number
 * and a number with a letter. Three have the `S-N` designator. Two of those also have the
 * truncated postal-descriptor reference `#ES.SDGC.PD.55.101.`, 70 of the member's 8,126.
 * One stands on the street whose name holds the accented byte.
 *
 * The declaration still reads `ISO-8859-1`, as the publisher's does, and
 * `decodes the member the publisher's declaration names` re-encodes the fixture to those bytes in a
 * scratch directory so the decode runs on real high bytes rather than on entity references.
 *
 * Counts quoted against the whole member come from reading
 * `A.ES.SDGC.AD.55101.zip`, 354,647 bytes. Its one member is 11,861,975 bytes: 8,126 addresses,
 * 505 thoroughfare names, 5 postal descriptors, one administrative unit, 856 `S-N` designators and
 * 70 truncated postal-descriptor references.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { decodeBytes } from "@mailwoman/core/fs/streams"
import { makeDirectories, removePathIfPresent, writeLocalBuffer, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import { createESCatastroAdapter, ES_CATASTRO_ADAPTER_ID, ES_CATASTRO_LICENSE } from "#es/adapters/catastro/adapter"
import { UnresolvedComponentReferenceError } from "#inspire/errors"
import { SourceRegister } from "#registers"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("es-catastro")

const fixture = workspacePath("corpus", "fixtures", "es-catastro", "A.ES.SDGC.AD.55101.gml")

/**
 * Every row the adapter reads out of `inputPath`, through the runner that writes them.
 */
async function rowsFrom(inputPath: PathBuilderLike, limit?: number) {
	const manifest = await runAdapter({
		adapter: createESCatastroAdapter(),
		adapterOptions: { inputPath, limit },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { manifest, rows: await readCanonicalRows(scratch.path, ES_CATASTRO_ADAPTER_ID) }
}

describe("es-catastro adapter against the fixture member", () => {
	it("emits a row per address under the license the source register elects", async () => {
		const { manifest, rows } = await rowsFrom(fixture)

		expect(manifest.yielded).toBe(6)
		expect(rows).toHaveLength(6)
		expect(rows.every((row) => row.license === ES_CATASTRO_LICENSE)).toBe(true)
		expect(rows.every((row) => row.source === ES_CATASTRO_ADAPTER_ID)).toBe(true)
		expect(rows.every((row) => row.country === "ES")).toBe(true)
		expect(rows.every((row) => row.locale === "es-ES")).toBe(true)
		expect(createESCatastroAdapter().register).toBe(SourceRegister.CatastroInspireAddresses)
	})

	it("composes the address the Cadastre's own `ldt` renders for the same cadastral reference", async () => {
		const { rows } = await rowsFrom(fixture)
		const byID = new Map(rows.map((row) => [row.source_id, row]))

		// `Consulta_DNPRC` on the OVC web service answers `9744803TE8794S` with `tv` `CL`,
		// `nv` `SANTIAGO APOSTOL`, `pnp` `13`, `dp` `51002` and `nm` `CEUTA`, and `9745701TE8794S`
		// with the same plus `plp` `D`, rendered `CL SANTIAGO APOSTOL 13(D) 51002 CEUTA (CEUTA)`.
		expect(byID.get(`${ES_CATASTRO_ADAPTER_ID}-ES.SDGC.AD.55.101.1.13.9744803TE8794S`)?.components).toEqual({
			street: "CL SANTIAGO APOSTOL",
			house_number: "13",
			postcode: "51002",
			locality: "CEUTA",
		})

		expect(byID.get(`${ES_CATASTRO_ADAPTER_ID}-ES.SDGC.AD.55.101.1.13D.9745701TE8794S`)?.components).toEqual({
			street: "CL SANTIAGO APOSTOL",
			house_number: "13D",
			postcode: "51002",
			locality: "CEUTA",
		})
	})

	it("keeps the street-type abbreviation the publisher writes in its own rendered line", async () => {
		const { rows } = await rowsFrom(fixture)

		// The thoroughfare feature's text is ` CL SANTIAGO APOSTOL`, leading space included,
		// and the Cadastre's `ldt` opens `CL SANTIAGO APOSTOL`.
		// An expansion of `CL` to `Calle` would state something the publisher does not.
		expect(rows.every((row) => /^[A-Z]{2} /u.test(row.components.street ?? ""))).toBe(true)
	})

	it("writes no house number for the sin-número designator", async () => {
		const { rows } = await rowsFrom(fixture)
		const numberless = rows.filter((row) => !row.components.house_number)

		// 856 of the member's 8,126 designators read `S-N`, and the Cadastre's own
		// `ldt` renders no number for them.
		// An `S-N` value would put the token in the component a parser reads as digits.
		expect(numberless).toHaveLength(3)
		expect(numberless.every((row) => row.source_id.includes(".S-N."))).toBe(true)
		expect(rows.some((row) => row.components.house_number === "S-N")).toBe(false)
	})

	it("reads a postal-descriptor reference with an empty final segment as no postcode", async () => {
		const { rows } = await rowsFrom(fixture)
		const withoutPostcode = rows.filter((row) => !row.components.postcode)
		const text = await readLocalBuffer(fixture)

		expect(text.toString("utf8")).toContain('xlink:href="#ES.SDGC.PD.55.101."')

		// 70 of the member's 8,126 addresses write that reference, against the five
		// `AD:PostalDescriptor` features the member publishes.
		// The row keeps its street, its number and its municipality.
		expect(withoutPostcode).toHaveLength(2)

		expect(withoutPostcode.map((row) => row.raw)).toEqual(["CL ALCALA DEL VALLE, CEUTA", "CL PUENTE DEL VALLE, CEUTA"])
	})

	it("reads the municipality by the level the publisher states as element text", async () => {
		const { rows } = await rowsFrom(fixture)
		const text = (await readLocalBuffer(fixture)).toString("utf8")

		// The Cadastre writes `<AD:level>4</AD:level>` where every other publisher writes
		// the `AdministrativeHierarchyLevel/4thOrder` codelist URI.
		expect(text).toContain("<AD:level>4</AD:level>")
		expect(rows.every((row) => row.components.locality === "CEUTA")).toBe(true)
	})

	it("decodes the member the publisher's declaration names", async () => {
		const utf8 = (await readLocalBuffer(fixture)).toString("utf8")
		const member = scratch.path("A.ES.SDGC.AD.55101.gml")

		// The committed fixture writes every high byte as a numeric character reference so it reads as text.
		// The publisher writes the byte, so this test writes the byte too: `Ñ` is 0xD1 in ISO-8859-1
		// and is not valid UTF-8, and the markup reader's own `TextDecoder("utf-8")` answers it with U+FFFD.
		// Node's `latin1` encoding is ISO-8859-1's single-byte mapping,
		// so no transcoder is needed to write one.
		const bytes = Buffer.from(utf8.replaceAll("&#209;", "Ñ"), "latin1")

		expect(bytes).toContain(0xd1)
		expect(decodeBytes(bytes, "utf8")).toContain("�")

		await writeLocalBuffer(bytes, member)

		const { rows } = await rowsFrom(member)
		const accented = rows.find((row) => row.components.street?.includes("MU"))

		expect(accented?.components.street).toBe("CL AGUSTIN MUÑOZ VAZQUEZ")
		expect(rows).toHaveLength(6)
	})

	it("raises when the member declares an encoding this reader does not decode", async () => {
		const text = (await readLocalBuffer(fixture)).toString("utf8")
		const member = scratch.path("declared-utf8.gml")

		await writeLocalTextFile(text.replace('encoding="ISO-8859-1"', 'encoding="UTF-8"'), member)

		await expect(rowsFrom(member)).rejects.toThrow(/declares encoding "UTF-8"/u)
	})

	it("raises on a reference that resolves to no feature and is not truncated", async () => {
		const text = (await readLocalBuffer(fixture)).toString("utf8")
		const member = scratch.path("dangling.gml")

		await writeLocalTextFile(text.replace('"#ES.SDGC.TN.55.101.1"', '"#ES.SDGC.TN.55.101.999"'), member)

		await expect(rowsFrom(member)).rejects.toThrow(UnresolvedComponentReferenceError)
		await expect(rowsFrom(member)).rejects.toThrow(/#ES\.SDGC\.TN\.55\.101\.999/u)
	})

	it("names what it opened when a directory holds no archive", async () => {
		const [empty] = await makeDirectories(scratch.path("empty"))

		await expect(rowsFrom(empty)).rejects.toThrow(/holds no \.zip archive/u)
	})

	it("honors opts.limit", async () => {
		const { manifest } = await rowsFrom(fixture, 2)

		expect(manifest.yielded).toBe(2)
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		await expect(
			runAdapter({
				adapter: createESCatastroAdapter(),
				adapterOptions: { inputPath: fixture, country: "PT" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/the dataset covers ES, got country=PT/u)
	})

	it("two runs over the same member produce identical sha256", async () => {
		const first = await rowsFrom(fixture)

		await removePathIfPresent(scratch.path(ES_CATASTRO_ADAPTER_ID))

		const second = await rowsFrom(fixture)

		expect(first.manifest.sha256).toBe(second.manifest.sha256)
	})
})
