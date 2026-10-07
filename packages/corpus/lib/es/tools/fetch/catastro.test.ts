/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Proves how the Catastro harvest reads a two-level ATOM service. It states which entries
 *   belong to another publisher, and what it does where a feed states less than it needs.
 *
 *   The bodies are the shapes `catastro.hacienda.gob.es` serves, reduced to the elements this
 *   harvest reads. The province feed holds ISO-8859-1 bytes because that level declares and
 *   writes them. A UTF-8 reading turns A Coruña's archive URL into an html error page.
 *
 *   `./catastro.integration.test.ts` reads the live service. This suite stubs the transport and
 *   runs the real `APIClient` over it, so the requests go through the same adapter and error
 *   mapping they do against the publisher.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { tryStat } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { silentLogger } from "@mailwoman/core/logging"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	archiveRequestURL,
	decodeDeclaredXML,
	ES_CATASTRO_SERVICE_FEED_URL,
	type ESCatastroHarvestManifest,
	esCatastroInputPath,
	harvestESCatastro,
	readESCatastroProvinceFeed,
	readESCatastroServiceFeed,
} from "#es/tools/fetch/catastro"
import { feedChunks, readAtomFeed } from "#tools/fetch/atom"
import { readManifest } from "#tools/fetch/download"

const PUBLICATION = "2026-08-21T00:00:00Z"

/**
 * One territorial office's entry in the national service document.
 */
function officeXML(code: string, name: string, updated = PUBLICATION): string {
	const href = `http://www.catastro.hacienda.gob.es/INSPIRE/addresses/${code}/ES.SDGC.ad.atom_${code}.xml`

	return (
		`<entry><title>Territorial office ${code} ${name}</title>` +
		`<link rel="enclosure" href="${href}" type="application/atom+xml"/>` +
		`<id>${href}</id><rights>Copyright (c) 2012", ES.SDGC; all rights reserved</rights>` +
		`<updated>${updated}</updated></entry>`
	)
}

/**
 * The entry of a foral cadastre.
 * It publishes through this feed under its own terms.
 */
const BIZKAIA_XML =
	`<entry><title>Provincial Council of Bizkaia</title>` +
	`<link rel="enclosure" href="https://web.bizkaia.eus/inspire/AD/ES.BFA.AD.atom.xml" type="application/atom+xml"/>` +
	`<id>https://web.bizkaia.eus/inspire/AD/ES.BFA.AD.atom.xml</id><updated>${PUBLICATION}</updated></entry>`

/**
 * The national service document.
 * It declares UTF-8 and writes it.
 */
function serviceXML(entries = officeXML("55", "Ceuta") + officeXML("15", "Coruña") + BIZKAIA_XML): string {
	return (
		`<?xml version="1.0" encoding="UTF-8"?>` +
		`<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">` +
		`<title>Download service of Address. Territorial Office</title>` +
		`<link href="${ES_CATASTRO_SERVICE_FEED_URL}" rel="self" type="application/atom+xml"/>` +
		`<id>${ES_CATASTRO_SERVICE_FEED_URL}</id><updated>${PUBLICATION}</updated>` +
		entries +
		`</feed>`
	)
}

/**
 * One municipality's entry in a province feed.
 */
function municipalityXML(province: string, code: string, name: string, updated = PUBLICATION): string {
	const href = `https://www.catastro.hacienda.gob.es/INSPIRE/Addresses/${province}/${code}-${name}/A.ES.SDGC.AD.${code}.zip`

	return (
		`<entry><title>${code}-${name} addresses</title>` +
		`<link rel="enclosure" href="${href}" type="application/atom+xml"/>` +
		`<id>${href}</id><updated>${updated}</updated>` +
		`<inspire_dls:spatial_dataset_identifier_code>AD</inspire_dls:spatial_dataset_identifier_code></entry>`
	)
}

/**
 * A province feed's bytes.
 * They declare ISO-8859-1.
 *
 * Encoded with `latin1` rather than with the default UTF-8, because the one byte
 * that distinguishes the two encodings is what the harvest has to read correctly:
 * `Ñ` arrives as `0xD1`, and the URL built from a UTF-8 reading of it answers an html page.
 */
function provinceFeedBytes(entries: string): Buffer {
	return Buffer.from(
		`<?xml version="1.0" encoding="ISO-8859-1"?>` +
			`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:inspire_dls="http://inspire.ec.europa.eu/schemas/inspire_dls/1.0">` +
			`<title>Addresses</title><updated>${PUBLICATION}</updated>` +
			entries +
			`</feed>`,
		"latin1"
	)
}

const CEUTA_FEED = provinceFeedBytes(municipalityXML("55", "55101", "CEUTA"))

const CORUNA_FEED = provinceFeedBytes(municipalityXML("15", "15900", "A CORUÑA"))

const CEUTA_ARCHIVE_URL = "https://www.catastro.hacienda.gob.es/INSPIRE/Addresses/55/55101-CEUTA/A.ES.SDGC.AD.55101.zip"

const CORUNA_ARCHIVE_URL =
	"https://www.catastro.hacienda.gob.es/INSPIRE/Addresses/15/15900-A%20CORU%C3%91A/A.ES.SDGC.AD.15900.zip"

const CEUTA_FEED_URL = "http://www.catastro.hacienda.gob.es/INSPIRE/addresses/55/ES.SDGC.ad.atom_55.xml"

const CORUNA_FEED_URL = "http://www.catastro.hacienda.gob.es/INSPIRE/addresses/15/ES.SDGC.ad.atom_15.xml"

/**
 * A body that is a zip archive as far as the harvest reads it.
 *
 * The harvest stores the archive for the adapter rather than opening it,
 * so what the members hold is the adapter's test's business.
 */
function archiveBody(payload: string): Buffer {
	return Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.from(payload, "utf8")])
}

function archiveOutcome(payload: string, lastModified?: string): StubOutcome {
	return {
		body: archiveBody(payload),
		headers: lastModified ? { "last-modified": lastModified } : {},
	}
}

/**
 * The real client over a scripted transport, with the dispatched URLs recorded on `calls`.
 */
function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "es-catastro test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

/**
 * The service document, then the one province feed, then its one archive.
 */
function ceutaOnlyOutcomes(payload = "ceuta"): StubOutcome[] {
	return [
		{ body: Buffer.from(serviceXML(officeXML("55", "Ceuta")), "utf8") },
		{ body: CEUTA_FEED },
		archiveOutcome(payload),
	]
}

describe("decodeDeclaredXML", () => {
	it("decodes a province feed from the ISO-8859-1 its declaration states", () => {
		const text = decodeDeclaredXML(CORUNA_FEED)

		expect(text).toContain("15900-A CORUÑA")
		expect(text).not.toContain("�")
	})

	it("decodes the national feed from the UTF-8 its declaration states", () => {
		const feed = serviceXML(officeXML("04", "Almería"))

		expect(decodeDeclaredXML(Buffer.from(feed, "utf8"))).toContain("Almería")
	})

	it("decodes a document that declares no encoding as UTF-8, which is XML's own default", () => {
		expect(decodeDeclaredXML(Buffer.from("<feed><title>Almería</title></feed>", "utf8"))).toContain("Almería")
	})
})

describe("archiveRequestURL", () => {
	it("percent-encodes the literal space and the non-ASCII letter the publisher writes in a path", () => {
		expect(
			archiveRequestURL(
				"https://www.catastro.hacienda.gob.es/INSPIRE/Addresses/15/15900-A CORUÑA/A.ES.SDGC.AD.15900.zip"
			)
		).toBe(CORUNA_ARCHIVE_URL)
	})
})

describe("readESCatastroServiceFeed", () => {
	it("selects the territorial offices and leaves the foral cadastres to their own adapters", async () => {
		const provinces = readESCatastroServiceFeed(await readAtomFeed(feedChunks(serviceXML())))

		expect(provinces.map((province) => province.code)).toEqual(["55", "15"])
		expect(provinces.map((province) => province.name)).toEqual(["Ceuta", "Coruña"])
		expect(provinces[0]?.provinceFeedURL).toBe(CEUTA_FEED_URL)
		expect(provinces[0]?.updated).toBe(PUBLICATION)
	})

	it("counts the offices off the feed rather than off a number written here", async () => {
		const entries = officeXML("02", "Albacete") + officeXML("03", "Alicante") + BIZKAIA_XML
		const feed = await readAtomFeed(feedChunks(serviceXML(entries)))

		// The publisher adds and merges offices, so the selection must hold exactly
		// the entries whose title matches an office.
		// Every entry here matches but one.
		expect(readESCatastroServiceFeed(feed)).toHaveLength(feed.entries.length - 1)
	})

	it("refuses a service document holding no entry rather than reporting a completed run", async () => {
		const feed = await readAtomFeed(feedChunks(`<feed><title>Addresses</title></feed>`))

		expect(() => readESCatastroServiceFeed(feed)).toThrow(/holds no <entry>/u)
	})

	it("refuses a feed whose entries are all some other publisher's, naming the titles it read", async () => {
		const feed = await readAtomFeed(feedChunks(serviceXML(BIZKAIA_XML)))

		expect(() => readESCatastroServiceFeed(feed)).toThrow(/none of the 1 entries is titled/u)
		expect(() => readESCatastroServiceFeed(feed)).toThrow(/Provincial Council of Bizkaia/u)
	})

	it("refuses an office whose title and province feed name different provinces", async () => {
		const mismatched = officeXML("55", "Ceuta").replace("atom_55.xml", "atom_56.xml")
		const feed = await readAtomFeed(feedChunks(serviceXML(mismatched)))

		expect(() => readESCatastroServiceFeed(feed)).toThrow(/states province 55 in its title/u)
	})

	it("refuses an office carrying no province-feed link", async () => {
		const linkless = `<entry><title>Territorial office 55 Ceuta</title><updated>${PUBLICATION}</updated></entry>`
		const feed = await readAtomFeed(feedChunks(serviceXML(linkless)))

		expect(() => readESCatastroServiceFeed(feed)).toThrow(/carries no rel="enclosure" link/u)
	})

	it("refuses a feed listing one province twice, which would read one feed in place of the other", async () => {
		const feed = await readAtomFeed(feedChunks(serviceXML(officeXML("55", "Ceuta") + officeXML("55", "Ceuta"))))

		expect(() => readESCatastroServiceFeed(feed)).toThrow(/province 55 is listed twice/u)
	})
})

describe("readESCatastroProvinceFeed", () => {
	const province = { code: "15", provinceFeedURL: CORUNA_FEED_URL }

	it("reads the municipality off its title and checks it against the archive's own name", async () => {
		const feed = await readAtomFeed(feedChunks(decodeDeclaredXML(CORUNA_FEED)))
		const [first] = readESCatastroProvinceFeed(feed, province)

		expect(first).toMatchObject({
			provinceCode: "15",
			code: "15900",
			name: "A CORUÑA",
			filename: "A.ES.SDGC.AD.15900.zip",
			updated: PUBLICATION,
		})

		// The stored name keeps the publisher's spelling while the request URL is encoded.
		expect(first?.archiveURL).toBe(CORUNA_ARCHIVE_URL)
	})

	it("refuses an entry whose title and archive name different municipalities", async () => {
		const mismatched = provinceFeedBytes(
			municipalityXML("15", "15900", "A CORUÑA").replaceAll("A.ES.SDGC.AD.15900.zip", "A.ES.SDGC.AD.15901.zip")
		)

		const feed = await readAtomFeed(feedChunks(decodeDeclaredXML(mismatched)))

		expect(() => readESCatastroProvinceFeed(feed, province)).toThrow(
			/states municipality 15900 and links an archive named for 15901/u
		)
	})

	it("refuses an entry whose title states no municipality code", async () => {
		const untitled = provinceFeedBytes(
			municipalityXML("15", "15900", "A CORUÑA").replace(
				"<title>15900-A CORUÑA addresses</title>",
				"<title>A CORUÑA</title>"
			)
		)

		const feed = await readAtomFeed(feedChunks(decodeDeclaredXML(untitled)))

		expect(() => readESCatastroProvinceFeed(feed, province)).toThrow(/states no municipality code/u)
	})

	it("refuses an entry linking a file that is not an addresses archive", async () => {
		const other = provinceFeedBytes(
			municipalityXML("15", "15900", "A CORUÑA").replaceAll("A.ES.SDGC.AD.15900.zip", "ES.SDGC.AD.MD.15900.xml")
		)

		const feed = await readAtomFeed(feedChunks(decodeDeclaredXML(other)))

		expect(() => readESCatastroProvinceFeed(feed, province)).toThrow(/is not named A\.ES\.SDGC\.AD\.<code>\.zip/u)
	})

	it("refuses a province feed holding no entry", async () => {
		const feed = await readAtomFeed(feedChunks(decodeDeclaredXML(provinceFeedBytes(""))))

		expect(() => readESCatastroProvinceFeed(feed, province)).toThrow(/holds no <entry>/u)
	})

	it("refuses a province feed listing one archive twice", async () => {
		const twice = provinceFeedBytes(municipalityXML("55", "55101", "CEUTA").repeat(2))
		const feed = await readAtomFeed(feedChunks(decodeDeclaredXML(twice)))

		expect(() => readESCatastroProvinceFeed(feed, { code: "55", provinceFeedURL: CEUTA_FEED_URL })).toThrow(
			/is listed twice/u
		)
	})
})

describe("esCatastroInputPath", () => {
	it("states the directory the adapter reads, under the fetcher's own slug", () => {
		expect(String(esCatastroInputPath(PathBuilder.from("/data/corpus/sources")))).toBe(
			"/data/corpus/sources/es-catastro"
		)
	})
})

describe("harvestESCatastro", () => {
	it("writes each archive under the publisher's own name and records its provenance", async () => {
		await using scratch = await temporaryDirectory("mailwoman-catastro-harvest-")

		await using client = stubClient([
			{ body: Buffer.from(serviceXML(officeXML("55", "Ceuta") + officeXML("15", "Coruña")), "utf8") },
			{ body: CEUTA_FEED },
			archiveOutcome("ceuta", "Fri, 21 Aug 2026 19:41:45 GMT"),
			{ body: CORUNA_FEED },
			archiveOutcome("coruna"),
		])

		const summary = await harvestESCatastro(client, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 2, skipped: 0, failed: 0 })

		// The accented archive is requested percent-encoded.
		// That is the URL that serves it.
		expect(client.calls).toEqual([
			ES_CATASTRO_SERVICE_FEED_URL,
			CEUTA_FEED_URL,
			CEUTA_ARCHIVE_URL,
			CORUNA_FEED_URL,
			CORUNA_ARCHIVE_URL,
		])

		expect((await tryStat(scratch.path("A.ES.SDGC.AD.55101.zip")))?.size).toBe(archiveBody("ceuta").byteLength)
		expect((await tryStat(scratch.path("A.ES.SDGC.AD.15900.zip")))?.size).toBe(archiveBody("coruna").byteLength)

		const manifest = await readManifest<ESCatastroHarvestManifest>(scratch.path("MANIFEST.json"))

		expect(manifest).toMatchObject({
			source: "es-catastro",
			provinces_listed: 2,
			provinces_harvested: 2,
			municipalities_listed: 2,
		})

		expect(manifest?.files[0]).toMatchObject({
			province_code: "15",
			municipality_code: "15900",
			filename: "A.ES.SDGC.AD.15900.zip",
			source_url: CORUNA_ARCHIVE_URL,
			feed_updated: PUBLICATION,
			last_modified: null,
		})

		expect(manifest?.files[1]?.last_modified).toBe("Fri, 21 Aug 2026 19:41:45 GMT")
		expect(manifest?.files[1]?.sha256).toMatch(/^[0-9a-f]{64}$/u)
	})

	it("makes no archive request on a re-run where the province feed states the recorded date", async () => {
		await using scratch = await temporaryDirectory("mailwoman-catastro-rerun-")
		await using first = stubClient(ceutaOnlyOutcomes())

		await harvestESCatastro(first, { outputDir: scratch.path })

		await using second = stubClient([
			{ body: Buffer.from(serviceXML(officeXML("55", "Ceuta")), "utf8") },
			{ body: CEUTA_FEED },
			archiveOutcome("must not be requested"),
		])

		const summary = await harvestESCatastro(second, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 0, skipped: 1, failed: 0 })
		expect(second.calls).toEqual([ES_CATASTRO_SERVICE_FEED_URL, CEUTA_FEED_URL])
	})

	it("re-fetches the municipality whose stated publication date moved", async () => {
		await using scratch = await temporaryDirectory("mailwoman-catastro-republished-")
		await using first = stubClient(ceutaOnlyOutcomes())

		await harvestESCatastro(first, { outputDir: scratch.path })

		await using second = stubClient([
			{ body: Buffer.from(serviceXML(officeXML("55", "Ceuta")), "utf8") },
			{ body: provinceFeedBytes(municipalityXML("55", "55101", "CEUTA", "2026-11-20T00:00:00Z")) },
			archiveOutcome("ceuta rebuilt"),
		])

		const summary = await harvestESCatastro(second, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 1, skipped: 0, failed: 0 })
		expect(second.calls.at(-1)).toBe(CEUTA_ARCHIVE_URL)

		const manifest = await readManifest<ESCatastroHarvestManifest>(scratch.path("MANIFEST.json"))

		expect(manifest?.files[0]?.feed_updated).toBe("2026-11-20T00:00:00Z")
	})

	it("downloads again where the feed states no publication date at all", async () => {
		await using scratch = await temporaryDirectory("mailwoman-catastro-silent-")
		const undated = provinceFeedBytes(municipalityXML("55", "55101", "CEUTA", ""))

		await using first = stubClient([
			{ body: Buffer.from(serviceXML(officeXML("55", "Ceuta")), "utf8") },
			{ body: undated },
			archiveOutcome("ceuta"),
		])

		await harvestESCatastro(first, { outputDir: scratch.path })

		await using second = stubClient([
			{ body: Buffer.from(serviceXML(officeXML("55", "Ceuta")), "utf8") },
			{ body: undated },
			archiveOutcome("ceuta"),
		])

		// Both sides read an empty string, so an equality test would hold and keep an
		// archive of unknown age for as long as the publisher stayed silent.
		const summary = await harvestESCatastro(second, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 1, skipped: 0 })
		expect(second.calls.at(-1)).toBe(CEUTA_ARCHIVE_URL)
	})

	it("re-fetches an archive that is no longer on disk at its recorded length", async () => {
		await using scratch = await temporaryDirectory("mailwoman-catastro-truncated-")
		await using first = stubClient(ceutaOnlyOutcomes())

		await harvestESCatastro(first, { outputDir: scratch.path })

		// A transfer that ends early leaves a shorter file at the final name, and the
		// recorded byte count is what tells that file apart from the archive.
		await writeLocalFile(archiveBody("truncated"), scratch.path("A.ES.SDGC.AD.55101.zip"))

		await using second = stubClient(ceutaOnlyOutcomes())
		const summary = await harvestESCatastro(second, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 1, skipped: 0 })
		expect(second.calls.at(-1)).toBe(CEUTA_ARCHIVE_URL)
	})

	it("refuses a body that is not an archive, so an html page is never stored under a .zip name", async () => {
		await using scratch = await temporaryDirectory("mailwoman-catastro-errorpage-")

		await using client = stubClient([
			{ body: Buffer.from(serviceXML(officeXML("55", "Ceuta")), "utf8") },
			{ body: CEUTA_FEED },
			// An html page under http 200 is what this host answers for a path that does not exist.
			{ body: "<html><body>Error</body></html>", headers: { "content-type": "text/html" } },
		])

		const summary = await harvestESCatastro(client, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 0, failed: 1, failedCodes: ["55101"] })
		expect(await tryStat(scratch.path("A.ES.SDGC.AD.55101.zip"))).toBeNull()
	})

	it("harvests a bounded subset, which is how the mechanism is proved without a national harvest", async () => {
		await using scratch = await temporaryDirectory("mailwoman-catastro-limit-")

		await using client = stubClient([
			{ body: Buffer.from(serviceXML(), "utf8") },
			{ body: CEUTA_FEED },
			archiveOutcome("ceuta"),
		])

		const summary = await harvestESCatastro(client, { outputDir: scratch.path, provinces: ["55"], limit: 1 })

		expect(summary).toMatchObject({ fetched: 1, skipped: 0, failed: 0 })

		// One province feed read rather than every one the service document lists.
		expect(client.calls).toEqual([ES_CATASTRO_SERVICE_FEED_URL, CEUTA_FEED_URL, CEUTA_ARCHIVE_URL])
	})

	it("reports a named province the service document does not list rather than ignoring it", async () => {
		await using scratch = await temporaryDirectory("mailwoman-catastro-unknown-province-")

		await using client = stubClient([
			{ body: Buffer.from(serviceXML(), "utf8") },
			{ body: CEUTA_FEED },
			archiveOutcome("ceuta"),
		])

		const summary = await harvestESCatastro(client, { outputDir: scratch.path, provinces: ["55", "99"] })

		expect(summary).toMatchObject({ fetched: 1, failed: 1, failedCodes: ["99"] })
	})

	it("reports a named municipality no selected province feed lists", async () => {
		await using scratch = await temporaryDirectory("mailwoman-catastro-unknown-municipality-")

		await using client = stubClient([{ body: Buffer.from(serviceXML(), "utf8") }, { body: CEUTA_FEED }])

		const summary = await harvestESCatastro(client, {
			outputDir: scratch.path,
			provinces: ["55"],
			municipalities: ["99999"],
		})

		expect(summary).toMatchObject({ fetched: 0, skipped: 0, failed: 1, failedCodes: ["99999"] })
		expect(client.calls).toEqual([ES_CATASTRO_SERVICE_FEED_URL, CEUTA_FEED_URL])
	})

	it("raises when the service document answers an exception report under http 200", async () => {
		await using scratch = await temporaryDirectory("mailwoman-catastro-exception-")

		await using client = stubClient([
			{
				body: Buffer.from(
					`<?xml version="1.0"?><ExceptionReport xmlns="http://www.opengis.net/ows/1.1" version="2.0.0">` +
						`<Exception exceptionCode="NoApplicableCode"><ExceptionText>Service unavailable</ExceptionText>` +
						`</Exception></ExceptionReport>`,
					"utf8"
				),
			},
		])

		await expect(harvestESCatastro(client, { outputDir: scratch.path })).rejects.toThrow(/Service unavailable/u)
	})
})
