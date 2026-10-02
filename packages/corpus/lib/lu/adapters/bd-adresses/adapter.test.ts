/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import {
	BD_ADRESSES_ADAPTER_ID,
	BD_ADRESSES_DEFAULT_LICENSE,
	createBDAdressesAdapter,
} from "#lu/adapters/bd-adresses/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("bd-adresses")

/**
 * Fourteen records taken verbatim from the publisher's `addresses.csv`, byte-order mark included.
 *
 * Every line is present in the 2026-09-28 edition exactly as written here, so the fixture
 * exercises the publisher's own quoting rather than a reconstruction of it.
 */
const fixtureCSV = workspacePath("corpus", "fixtures", "bd-adresses", "sample.csv")

function run(country?: string, limit?: number) {
	return runAdapter({
		adapter: createBDAdressesAdapter(),
		adapterOptions: {
			inputPath: fixtureCSV,
			...(country ? { country } : {}),
			...(limit === undefined ? {} : { limit }),
		},
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})
}

describe("bd-adresses adapter against fixture sample.csv", () => {
	it("emits one row per record under the register's CC0", async () => {
		const manifest = await run()

		const rows = await readCanonicalRows(scratch.path, BD_ADRESSES_ADAPTER_ID)

		// Every fixture record carries a street and a postcode, so none is refused.
		expect(manifest.yielded).toBe(rows.length)
		expect(rows.length).toBeGreaterThan(10)
		expect(rows.every((r) => r.license === BD_ADRESSES_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((r) => r.source === BD_ADRESSES_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.country === "LU")).toBe(true)
		expect(rows.every((r) => Boolean(r.components.street))).toBe(true)
		expect(rows.every((r) => Boolean(r.components.postcode))).toBe(true)
	})

	it("reads the first column through the byte-order mark the file opens with", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BD_ADRESSES_ADAPTER_ID)

		// The header's first byte sequence is `EF BB BF 72 75 65`.
		// A reader that keeps the mark indexes the mark followed by `rue`.
		// Its lookup of `rue` then reads an empty string, and the row emits no street at all.
		expect(rows[0]!.components.street).toBe("Kaesfurterstrooss")
		expect(rows[0]!.raw).toBe("20 Kaesfurterstrooss, L-9755 Hupperdange")
	})

	it("writes the number before the street, which is Luxembourg's order", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BD_ADRESSES_ADAPTER_ID)

		expect(rows.every((r) => (r.components.house_number ? r.raw.startsWith(r.components.house_number) : true))).toBe(
			true
		)
	})

	it("unescapes a street the publisher RFC 4180-quoted", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BD_ADRESSES_ADAPTER_ID)
		const streets = rows.map((r) => r.components.street)

		// The file writes `"Cité ""Pënscherbierg"""`.
		// A split on `;` still yields 13 fields on this row, so a field-count check passes
		// while the street keeps the publisher's quoting.
		expect(streets).toContain('Cité "Pënscherbierg"')
		expect(streets).toContain('Cité "bei der Kapell"')
		expect(streets.some((s) => s?.includes('""'))).toBe(false)
	})

	it("keeps the publisher's own house-number suffix as one token", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BD_ADRESSES_ADAPTER_ID)
		const numberOf = (street: string) => rows.find((r) => r.components.street === street)?.components.house_number

		expect(numberOf("Om Bongert")).toBe("12A")
		expect(numberOf("Rue d'Oetrange")).toBe("22-26")
		expect(numberOf("Rue de la Chapelle")).toBe("1BIS")
		expect(rows.find((r) => r.components.street === "Rue d'Oetrange")?.raw).toBe("22-26 Rue d'Oetrange, L-5411 Canach")
	})

	it("takes the number from numero rather than from a street that ends in a digit", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BD_ADRESSES_ADAPTER_ID)
		const nationale = rows.find((r) => r.components.street === "Route Nationale 1")
		const dated = rows.find((r) => r.components.street === "Rue du 9 août 2019")

		// 175 of the published street names end in a digit.
		// Splitting a number off the street name would move `1` and `2019` out of the street.
		expect(nationale?.components.house_number).toBe("1")
		expect(nationale?.raw).toBe("1 Route Nationale 1, L-6776 Grevenmacher")
		expect(dated?.components.house_number).toBe("1")
		expect(dated?.raw).toBe("1 Rue du 9 août 2019, L-4905 Bascharage")
	})

	it("emits a named place with no house number rather than fabricating one", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BD_ADRESSES_ADAPTER_ID)
		const unnumbered = rows.filter((r) => r.components.house_number === undefined)

		// `Al Géidgen` and `Rue Laurent Menager` publish an empty `numero` in the file.
		expect(unnumbered.map((r) => r.components.street).toSorted()).toEqual(["Al Géidgen", "Rue Laurent Menager"])
		expect(rows.find((r) => r.components.street === "Al Géidgen")?.raw).toBe("Al Géidgen, L-9954 Goedange")
	})

	it("agrees with the publisher's own composition in id_geoportail", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BD_ADRESSES_ADAPTER_ID)

		// `id_geoportail` ends in `_<id_caclr_rue>_<numero>`, which is the publisher
		// restating the number this adapter emits.
		// The file publishes no preformatted address line, so this is the only publisher-side
		// value a composed number can be checked against.
		for (const row of rows) {
			const number = row.components.house_number

			if (!number) continue

			expect(row.source_id.endsWith(`_${number}`) || row.source_id.includes(`_${number}_`)).toBe(true)
		}
	})

	it("labels the language undetermined, because the file carries one untagged street column", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BD_ADRESSES_ADAPTER_ID)

		expect(rows.every((r) => r.locale === "und-LU")).toBe(true)

		// The one column holds both languages, which is why no row claims one.
		const streets = rows.map((r) => r.components.street)

		expect(streets).toContain("Kaesfurterstrooss")
		expect(streets).toContain("Rue Laurent Menager")
	})

	it("source_id uses the publisher's own id_geoportail", async () => {
		await run()

		const rows = await readCanonicalRows(scratch.path, BD_ADRESSES_ADAPTER_ID)

		expect(rows[0]!.source_id).toBe("bd-adresses-058F00436002710_7984_20")
		expect(new Set(rows.map((r) => r.source_id)).size).toBe(rows.length)

		// 21 rows in the published file carry `domaine_public` where a parcel id would be,
		// because the address sits on public land rather than on a cadastral parcel.
		expect(rows.some((r) => r.source_id.includes("domaine_public"))).toBe(true)
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		await expect(run("BE")).rejects.toThrow(/the dataset covers LU/)
	})

	it("keeps every row when --country LU is given", async () => {
		const all = await run()
		const named = await run("LU")

		expect(named.yielded).toBe(all.yielded)
	})

	it("honors opts.limit", async () => {
		const capped = await run(undefined, 3)

		expect(capped.yielded).toBe(3)
	})

	it("two runs over the same CSV produce identical sha256", async () => {
		const a = await run()

		await removePathIfPresent(scratch.path(BD_ADRESSES_ADAPTER_ID))

		const b = await run()

		expect(a.sha256).toBe(b.sha256)
	})
})
