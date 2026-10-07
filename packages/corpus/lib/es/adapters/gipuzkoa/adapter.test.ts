/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture holds four of the publisher's addresses and the twelve features they reference, in
 *   the publisher's own order.
 *
 * `fixtures/es-gipuzkoa/ES.GFA.AD.gml` is copied out of `ES.GFA.AD.zip`'s 313,162,472-byte member as
 * written, and it keeps the property that decides the reader: every address comes before every
 * feature it references. A single-pass reader would have to hold all four, and over the whole member
 * it would hold all 68,744.
 *
 * The four addresses are a plain number, an address carrying two `ad:LocatorName` building names as a
 * Basque and Spanish pair, an `S/N` designator, and a number with a letter. They sit in four
 * municipalities, so the fixture also shows that the municipality comes from the reference rather
 * than from the file.
 *
 * Counts quoted against the whole member come from reading the archive: 73,260 `gml:featureMember`
 * elements holding 68,744 `ad:Address`, 4,250 `ad:ThoroughfareName`, 178 `ad:PostalDescriptor` and 88
 * `ad:AdminUnitName`, with the first reference feature at byte 306,440,816.
 * Of those addresses, 68,743 write one designator and 46,365 populate `ad:LocatorName`.
 * 26 designators read `S/N`.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import { createESGipuzkoaAdapter, ES_GIPUZKOA_ADAPTER_ID, ES_GIPUZKOA_LICENSE } from "#es/adapters/gipuzkoa/adapter"
import { UnresolvedComponentReferenceError } from "#inspire/errors"
import { SourceRegister } from "#registers"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("es-gipuzkoa")

const fixture = workspacePath("corpus", "fixtures", "es-gipuzkoa", "ES.GFA.AD.gml")

/**
 * Every row the adapter reads out of `inputPath`, through the runner that writes them.
 */
async function rowsFrom(inputPath: PathBuilderLike, limit?: number) {
	const manifest = await runAdapter({
		adapter: createESGipuzkoaAdapter(),
		adapterOptions: { inputPath, limit },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { manifest, rows: await readCanonicalRows(scratch.path, ES_GIPUZKOA_ADAPTER_ID) }
}

describe("es-gipuzkoa adapter against the fixture member", () => {
	it("emits a row per address under the license the source register elects", async () => {
		const { manifest, rows } = await rowsFrom(fixture)

		expect(manifest.yielded).toBe(4)
		expect(rows).toHaveLength(4)
		expect(rows.every((row) => row.license === ES_GIPUZKOA_LICENSE)).toBe(true)
		expect(rows.every((row) => row.source === ES_GIPUZKOA_ADAPTER_ID)).toBe(true)
		expect(rows.every((row) => row.country === "ES")).toBe(true)
		expect(rows.every((row) => row.locale === "es-ES")).toBe(true)
		expect(createESGipuzkoaAdapter().register).toBe(SourceRegister.GipuzkoaInspireAddresses)
	})

	it("resolves a reference the publisher writes after the address that names it", async () => {
		const text = await readLocalTextFile(fixture)
		const { rows } = await rowsFrom(fixture)

		expect(text.indexOf("<ad:Address ")).toBeLessThan(text.indexOf("<ad:ThoroughfareName "))

		expect(rows.map((row) => row.raw)).toEqual([
			"Samikolla ibilbidea, 3, 20830 Mutriku",
			"Larraña auzoa, 25, 20569 Oñati",
			"San Isidro kalea, 20749 Zestoa",
			"Santakurtz kalea, 22-B, 20550 Aretxabaleta",
		])
	})

	it("agrees with the publisher's own identifier on the municipality, the street and the number", async () => {
		const { rows } = await rowsFrom(fixture)

		// `ES.GFA.AD.056_1110_003` concatenates the municipality code, the thoroughfare code
		// and the number, and its references are `AU_ADMINISTRATIVEUNIT_34162020056`,
		// `ES.GFA.TN.056.1110` and `ES.GFA.PD.056.20830`.
		// Across all 68,744 addresses of the whole member, every one joined the
		// thoroughfare feature its own identifier points at and every number agreed with
		// the identifier's third field, the 26 `S/N` cases included.
		const first = rows.find((row) => row.source_id.endsWith("056_1110_003"))

		expect(first?.components).toEqual({
			street: "Samikolla ibilbidea",
			house_number: "3",
			postcode: "20830",
			locality: "Mutriku",
		})
	})

	it("writes no house number for the sin-número designator", async () => {
		const { rows } = await rowsFrom(fixture)
		const numberless = rows.filter((row) => !row.components.house_number)

		expect(numberless.map((row) => row.source_id)).toEqual([`${ES_GIPUZKOA_ADAPTER_ID}-ES.GFA.AD.027_5006_S/N`])
		expect(rows.some((row) => row.components.house_number === "S/N")).toBe(false)
	})

	it("writes no building name, which the register's personal-data review turns on", async () => {
		const text = await readLocalTextFile(fixture)
		const { rows } = await rowsFrom(fixture)

		// 46,365 of 68,744 addresses populate `ad:LocatorName`, as a Basque and Spanish pair.
		// A Basque *baserri* name is commonly also a surname, and the register's reading of
		// `absent` rests on these naming the building rather than its occupant.
		expect(text).toContain("<gn:text>Antzuelasetxabarri, baserria</gn:text>")
		expect(text).toContain("<gn:text>Antzuelasetxabarri, caserío</gn:text>")

		expect(rows.some((row) => stringifyJSON(row.components).includes("baserria"))).toBe(false)
		expect(rows.some((row) => row.raw.includes("Antzuelasetxabarri"))).toBe(false)
	})

	it("reads the municipality at the fourth order, which is the only level the province publishes", async () => {
		const text = await readLocalTextFile(fixture)
		const { rows } = await rowsFrom(fixture)

		expect(text).toContain("AdministrativeHierarchyLevel/4thOrder")
		expect(rows.map((row) => row.components.locality)).toEqual(["Mutriku", "Oñati", "Zestoa", "Aretxabaleta"])
	})

	it("raises on a reference that resolves to no feature", async () => {
		const text = await readLocalTextFile(fixture)
		const member = scratch.path("dangling.gml")

		await writeLocalTextFile(text.replaceAll('gml:id="ES.GFA.TN.056.1110"', 'gml:id="ES.GFA.TN.056.9999"'), member)

		await expect(rowsFrom(member)).rejects.toThrow(UnresolvedComponentReferenceError)
		await expect(rowsFrom(member)).rejects.toThrow(/ES\.GFA\.TN\.056\.1110/u)
	})

	it("names what it opened when a directory holds no archive", async () => {
		const [empty] = await makeDirectories(scratch.path("empty"))

		await expect(rowsFrom(empty)).rejects.toThrow(/holds no \.zip archive or \.gml member/u)
	})

	it("honors opts.limit", async () => {
		const { manifest } = await rowsFrom(fixture, 2)

		expect(manifest.yielded).toBe(2)
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		await expect(
			runAdapter({
				adapter: createESGipuzkoaAdapter(),
				adapterOptions: { inputPath: fixture, country: "FR" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/the dataset covers ES, got country=FR/u)
	})

	it("two runs over the same member produce identical sha256", async () => {
		const first = await rowsFrom(fixture)

		await removePathIfPresent(scratch.path(ES_GIPUZKOA_ADAPTER_ID))

		const second = await rowsFrom(fixture)

		expect(first.manifest.sha256).toBe(second.manifest.sha256)
	})
})
