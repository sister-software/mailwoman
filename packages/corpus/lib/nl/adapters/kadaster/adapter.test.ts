/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture is Kadaster's own response text.
 *
 * `fixtures/nl-kadaster/addresses.gml` opens with the declaration and root element of
 * `https://service.pdok.nl/kadaster/ad/atom/downloads/addresses.gml.gz` as served, then nine
 * `gml:featureMember` elements holding the features twelve addresses reference, then those twelve
 * addresses, each copied byte for byte out of a ranged prefix of that download. The twelve are the
 * first six in document order plus two that write both number extensions, two that write only the
 * second and two whose postcode designator is present and empty. No byte was edited, so the
 * publisher's spelling, its void elements and its empty designators are the ones under test.
 *
 * The committed file is uncompressed so the bytes a reviewer reads in the diff are the bytes the
 * suite parses. One test gzips it into the scratch directory, because the published download is
 * `.gml.gz` and the reader's inflating path has to be exercised on the same bytes.
 */

import { gzip } from "@mailwoman/core/fs/compression"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { removePathIfPresent, writeLocalFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import { UnresolvedComponentReferenceError, VoidDesignatorError } from "#inspire/errors"
import {
	createNLKadasterAdapter,
	dutchHouseNumber,
	NL_KADASTER_ADAPTER_ID,
	NL_KADASTER_DEFAULT_LICENSE,
	NL_KADASTER_REGISTER,
} from "#nl/adapters/kadaster/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("nl-kadaster")

const fixture = workspacePath("corpus", "fixtures", "nl-kadaster", "addresses.gml")

/**
 * Every row the adapter reads out of `inputPath`, through the runner that writes them.
 */
async function rowsFrom(inputPath: PathBuilderLike, limit?: number) {
	const manifest = await runAdapter({
		adapter: createNLKadasterAdapter(),
		adapterOptions: { inputPath, limit },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return { manifest, rows: await readCanonicalRows(scratch.path, NL_KADASTER_ADAPTER_ID) }
}

describe("nl-kadaster adapter against the fixture GML", () => {
	it("emits a row per address under the license the source register elects", async () => {
		const { manifest, rows } = await rowsFrom(fixture)

		expect(manifest.yielded).toBe(12)
		expect(rows).toHaveLength(12)
		expect(rows.every((r) => r.license === NL_KADASTER_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((r) => r.source === NL_KADASTER_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.country === "NL")).toBe(true)
		expect(rows.every((r) => r.locale === "nl-NL")).toBe(true)
		expect(createNLKadasterAdapter().register).toBe(NL_KADASTER_REGISTER)
	})

	it("renders every row the way Kadaster renders the same record", async () => {
		const { rows } = await rowsFrom(fixture)

		// The theme publishes no formatted address: `ad:alternativeIdentifier` is void on all twelve.
		// Kadaster's Locatieserver serves `weergavenaam` for the same `nummeraanduiding` ids,
		// and these twelve strings are that field, which agreed with the reader on 12 of 12
		// when measured on 2026-10-02.
		// They are recorded here rather than fetched, so the suite needs no network.
		expect(rows.map((r) => r.raw)).toEqual([
			"Snelgersmastraat 3, 9901AA Appingedam",
			"Snelgersmastraat 5, 9901AA Appingedam",
			"Snelgersmastraat 7, 9901AA Appingedam",
			"Snelgersmastraat 11, 9901AA Appingedam",
			"Snelgersmastraat 13, 9901AA Appingedam",
			"Trekpad 15, 9901BS Appingedam",
			"De Paasweide 72g-8, Appingedam",
			"De Paasweide 72g-11, Appingedam",
			"Kniestraat 10-I, 9901AD Appingedam",
			"Heerdlaan 4-01, 9901CC Appingedam",
			"Kanaalweg 18, Appingedam",
			"Mr. A.T. Voslaan 28A, Appingedam",
		])
	})

	it("takes the house number from the designator typed addressNumber", async () => {
		const { rows } = await rowsFrom(fixture)
		const byID = new Map(rows.map((r) => [r.source_id, r]))

		// `3` is typed `addressNumber`, and the same locator holds `9901AA` typed `postalDeliveryIdentifier`,
		// so a reader keyed on position rather than type would store the postcode as the number.
		expect(byID.get(`${NL_KADASTER_ADAPTER_ID}-nl-imbag-ad-address.0003200000133985`)?.components).toEqual({
			street: "Snelgersmastraat",
			house_number: "3",
			postcode: "9901AA",
			locality: "Appingedam",
		})
	})

	it("joins the extension to the number and the second extension behind a hyphen", async () => {
		const { rows } = await rowsFrom(fixture)
		const byRaw = new Map(rows.map((r) => [r.raw, r]))

		expect(byRaw.get("De Paasweide 72g-11, Appingedam")?.components.house_number).toBe("72g-11")
		expect(byRaw.get("Kniestraat 10-I, 9901AD Appingedam")?.components.house_number).toBe("10-I")
		expect(byRaw.get("Heerdlaan 4-01, 9901CC Appingedam")?.components.house_number).toBe("4-01")
		expect(byRaw.get("Mr. A.T. Voslaan 28A, Appingedam")?.components.house_number).toBe("28A")
	})

	it("reads an empty but present designator as no extension rather than as a component", async () => {
		const { rows } = await rowsFrom(fixture)
		const byRaw = new Map(rows.map((r) => [r.raw, r]))

		// 305,542 of 345,309 addresses in the measured prefix write `<ad:designator/>` for the extension.
		// The number keeps no separator and no empty tail, and the publisher writes
		// the second extension empty on the same addresses.
		expect(byRaw.get("Snelgersmastraat 3, 9901AA Appingedam")?.components.house_number).toBe("3")

		expect(
			dutchHouseNumber(
				new Map([
					["addressNumber", ["3"]],
					["addressNumberExtension", [""]],
				])
			)
		).toBe("3")

		expect(
			dutchHouseNumber(
				new Map([
					["addressNumber", ["3"]],
					["addressNumberExtension", [""]],
					["addressNumber2ndExtension", [""]],
				])
			)
		).toBe("3")
	})

	it("takes the postcode from the inline locator, because the publisher writes no postal descriptor", async () => {
		const text = (await readLocalBuffer(fixture)).toString("utf8")

		// The measured 40,000,000-byte prefix holds 0 `ad:PostalDescriptor` features,
		// and the fixture holds none either, so every postcode below came from the locator.
		expect(text).not.toContain("ad:PostalDescriptor")
		expect(text).toContain("LocatorDesignatorTypeValue/postalDeliveryIdentifier")

		const { rows } = await rowsFrom(fixture)

		expect(rows.filter((r) => r.components.postcode)).toHaveLength(8)
		expect(rows.find((r) => r.raw.startsWith("Snelgersmastraat 3"))?.components.postcode).toBe("9901AA")
	})

	it("keeps an address whose postcode designator is present and empty", async () => {
		const { rows } = await rowsFrom(fixture)
		const withoutPostcode = rows.filter((r) => !r.components.postcode)

		// 1,769 of 40,000 addresses measured write an empty `postalDeliveryIdentifier`,
		// and Kadaster's own `weergavenaam` writes those without a postcode too.
		expect(withoutPostcode.map((r) => r.raw)).toEqual([
			"De Paasweide 72g-8, Appingedam",
			"De Paasweide 72g-11, Appingedam",
			"Kanaalweg 18, Appingedam",
			"Mr. A.T. Voslaan 28A, Appingedam",
		])
	})

	it("reads the woonplaats as the locality and no place name from the country feature", async () => {
		const text = (await readLocalBuffer(fixture)).toString("utf8")
		const { rows } = await rowsFrom(fixture)

		// The document holds one `ad:AdminUnitName`, the country at `1stOrder`,
		// and every address references it.
		// A reader taking the first admin unit it resolves would write `Nederland` into `locality` on every row.
		expect(text).toContain("<gn:text>Nederland</gn:text>")
		expect(text).toContain("AdministrativeHierarchyLevel/1stOrder")
		expect(rows.every((r) => r.components.locality === "Appingedam")).toBe(true)
	})

	it("never follows ad:situatedWithin, whose target id the publisher spells with a hyphen", async () => {
		const text = (await readLocalBuffer(fixture)).toString("utf8")

		// Measured over a 5,000,000-character window of the download: 479 unresolved local
		// fragments, all of this shape, against 2,622 dot-form ids and 0 hyphen-form ids.
		// The fixture reproduces that disagreement, so the defect is pinned in the diff rather than described.
		expect(text).toContain('<ad:situatedWithin xlink:href="#nl-imbag-ad-addressareaname-3386"/>')
		expect(text).toContain('<ad:AddressAreaName gml:id="nl-imbag-ad-addressareaname.3386">')
		expect(text).not.toContain('gml:id="nl-imbag-ad-addressareaname-3386"')

		// Every `ad:component` the reader does follow uses the dot form and resolves,
		// so the rows hold a street and a woonplaats without that element.
		const { rows } = await rowsFrom(fixture)

		expect(rows.every((r) => r.components.street && r.components.locality)).toBe(true)
	})

	it("raises on a component reference that resolves to no feature", async () => {
		const text = (await readLocalBuffer(fixture)).toString("utf8")
		// The hyphen form of the one id the publisher misspells elsewhere, moved onto an
		// `ad:component` where the reader does resolve references.
		const broken = scratch.path("broken.gml")

		await writeLocalFile(
			text.replace(
				'<ad:component xlink:href="#nl-imbag-ad-addressareaname.3386"/>',
				'<ad:component xlink:href="#nl-imbag-ad-addressareaname-3386"/>'
			),
			broken
		)

		await expect(rowsFrom(broken)).rejects.toThrow(UnresolvedComponentReferenceError)

		await expect(rowsFrom(broken)).rejects.toThrow(
			/address nl-imbag-ad-address\.0003200000133985 carries ad:component xlink:href="#nl-imbag-ad-addressareaname-3386"/
		)
	})

	it("defers an address whose reference the document writes after it, rather than dropping it", async () => {
		const text = (await readLocalBuffer(fixture)).toString("utf8")
		const area = /<gml:featureMember><ad:AddressAreaName[\s\S]*?<\/gml:featureMember>/.exec(text)![0]
		// The woonplaats moved behind every address, which is the one ordering that separates
		// a reference that has not arrived yet from one the publisher never wrote.
		// The published document deferred 0 of 345,309 addresses, so only a rewrite reaches this path.
		const reordered = scratch.path("reordered.gml")

		await writeLocalFile(
			text.replace(area, "").replace("</gml:FeatureCollection>", area + "</gml:FeatureCollection>"),
			reordered
		)

		const { manifest, rows } = await rowsFrom(reordered)

		expect(manifest.yielded).toBe(12)
		expect(rows.every((r) => r.components.locality === "Appingedam")).toBe(true)
	})

	it("raises on a designator the publisher marked void rather than reading it as no number", async () => {
		const text = (await readLocalBuffer(fixture)).toString("utf8")
		const voided = scratch.path("voided.gml")

		// 0 of 40,000 addresses measured write a void `ad:designator`.
		// `designatorsByType` leaves one out, so without this check a number the publisher
		// marked unknown would read as an address stating no number at all.
		await writeLocalFile(
			text.replace(
				"<ad:LocatorDesignator><ad:designator>3</ad:designator>",
				'<ad:LocatorDesignator><ad:designator xsi:nil="true" nilReason="http://inspire.ec.europa.eu/codelist/VoidReasonValue/Unknown"/>'
			),
			voided
		)

		await expect(rowsFrom(voided)).rejects.toThrow(VoidDesignatorError)

		await expect(rowsFrom(voided)).rejects.toThrow(
			/address nl-imbag-ad-address\.0003200000133985 marks its addressNumber designator void/
		)
	})

	it("reads the publisher's gzipped document, which is the form it serves", async () => {
		const gzipped = scratch.path("addresses.gml.gz")

		await writeLocalFile(await gzip(await readLocalBuffer(fixture)), gzipped)

		const { manifest, rows } = await rowsFrom(gzipped)

		expect(manifest.yielded).toBe(12)
		expect(rows[0]!.raw).toBe("Snelgersmastraat 3, 9901AA Appingedam")
	})

	it("reads a directory of documents", async () => {
		const { manifest } = await rowsFrom(workspacePath("corpus", "fixtures", "nl-kadaster"))

		expect(manifest.yielded).toBe(12)
	})

	it("names what it opened when a directory holds no document", async () => {
		await expect(rowsFrom(scratch.path)).rejects.toThrow(/holds no GML document/)
	})

	it("honors opts.limit", async () => {
		const { manifest } = await rowsFrom(fixture, 2)

		expect(manifest.yielded).toBe(2)
	})

	it("rejects a jurisdiction the dataset does not cover", async () => {
		await expect(
			runAdapter({
				adapter: createNLKadasterAdapter(),
				adapterOptions: { inputPath: fixture, country: "BQ" },
				outputDir: scratch.path,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/the dataset covers NL, got country=BQ/)
	})

	it("accepts the one jurisdiction the dataset covers", async () => {
		const manifest = await runAdapter({
			adapter: createNLKadasterAdapter(),
			adapterOptions: { inputPath: fixture, country: "NL" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(12)
	})

	it("two runs over the same document produce identical sha256", async () => {
		const first = await rowsFrom(fixture)

		await removePathIfPresent(scratch.path(NL_KADASTER_ADAPTER_ID))

		const second = await rowsFrom(fixture)

		expect(first.manifest.sha256).toBe(second.manifest.sha256)
	})
})
