/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Proves what the Bizkaia harvest reads out of the service document, what it refuses, and that one
 *   run writes both the municipality archives and the WFS component documents the adapter joins
 *   against.
 *
 *   The bodies are the shapes `apli.bizkaia.eus` and `geo.bizkaia.eus` serve, reduced to the
 *   elements this harvest reads. The service document's entries hold a `rel="enclosure"` link and
 *   repeat one `<updated>`, and the WFS's feature pages state `numberMatched="unknown"` with the
 *   delivered count in `numberReturned`, which is why the count is read from a separate
 *   `RESULTTYPE=hits` request.
 *
 *   `./bizkaia.integration.test.ts` reads the live services. This suite stubs the transport and runs
 *   the real `APIClient` over it, so the requests go through the same adapter and error mapping they
 *   do against the publisher.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { silentLogger } from "@mailwoman/core/logging"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	ES_BIZKAIA_COMPONENT_TYPES,
	ES_BIZKAIA_SERVICE_URL,
	type ESBizkaiaHarvestManifest,
	bizkaiaComponentFilename,
	esBizkaiaInputPath,
	fetchBizkaiaComponentDocument,
	harvestESBizkaia,
	readESBizkaiaServiceFeed,
} from "#es/tools/fetch/bizkaia"
import { feedChunks, readAtomFeed } from "#tools/fetch/atom"
import { readManifest } from "#tools/fetch/download"

/**
 * The one `<updated>` every entry of this service repeats. That value is the feed document's
 * own modification time and the harvest's whole freshness signal.
 */
const FEED_UPDATED = "2026-10-01T02:40:20Z"

/**
 * One municipality's entry, as the service document writes it.
 *
 * `code` is the five-digit municipality code the title opens with, and `stem` is
 * the three-digit tail in the archive's name.
 */
function entryXML(code: string, name: string, stem: string, updated = FEED_UPDATED): string {
	return (
		`<entry><title>${code}-${name} Addresses</title>` +
		`<inspire_dls:spatial_dataset_identifier_code>ES.BFA.AD.${stem}.zip</inspire_dls:spatial_dataset_identifier_code>` +
		`<link rel="enclosure" href="https://apli.bizkaia.eus/apps/Danok/INSPIRE/ES.BFA.AD.${stem}.zip" ` +
		`type="application/atom+xml" hreflang="en"/>` +
		`<id>https://apli.bizkaia.eus/apps/Danok/INSPIRE/ES.BFA.AD.${stem}.zip</id>` +
		`<updated>${updated}</updated></entry>`
	)
}

function serviceXML(...entries: string[]): string {
	return (
		`<?xml version='1.0' encoding='utf-8'?>` +
		`<feed xmlns="http://www.w3.org/2005/Atom" ` +
		`xmlns:inspire_dls="http://inspire.ec.europa.eu/schemas/inspire_dls/1.0" xml:lang="en">` +
		`<title>Bizkaiko Foru Aldundia Addresses Download Service</title>` +
		`<id>${ES_BIZKAIA_SERVICE_URL}</id>` +
		`<rights>Access to this service is permitted in all cases, provided that the authorship and ownership ` +
		`of BFA are referred to as follows: «©Bizkaiko Foru Aldundia»</rights>` +
		`<updated>${FEED_UPDATED}</updated>` +
		entries.join("") +
		`</feed>`
	)
}

const SERVICE_XML = serviceXML(entryXML("48001", "ABADIÑO", "001"), entryXML("48915", "ZIORTZA-BOLIBAR", "915"))

/**
 * A body that is a zip archive as far as the harvest reads it.
 *
 * The harvest stores the archive for the adapter rather than opening it,
 * so what its members hold is the adapter's test's business.
 */
function archiveBody(payload: string): Buffer {
	return Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.from(payload, "utf8")])
}

/**
 * The `RESULTTYPE=hits` response, the only place this service states a count.
 */
function hitsXML(count: number): string {
	return (
		`<?xml version="1.0" encoding="utf-8"?>` +
		`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" ` +
		`timeStamp="2026-10-03T03:37:26.5+01:00" numberReturned="0" numberMatched="${count}"/>`
	)
}

/**
 * A feature page holding `count` features of one type.
 *
 * `numberMatched` is `unknown` here, as this service writes it on every feature page,
 * so the page states its own feature count and leaves the type's total unstated.
 */
function featuresXML(type: string, count: number, firstID = 1): string {
	const members = Array.from(
		{ length: count },
		(_, index) =>
			`<wfs:member><ad:${type.slice(type.indexOf(":") + 1)} gml:id="adComponent.${firstID + index}"/></wfs:member>`
	).join("")

	return (
		`<?xml version="1.0" encoding="utf-8"?>` +
		`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" ` +
		`xmlns:ad="http://inspire.ec.europa.eu/schemas/ad/4.0" xmlns:gml="http://www.opengis.net/gml/3.2" ` +
		`timeStamp="2026-10-03T03:37:26.5+01:00" numberReturned="${count}" numberMatched="unknown">` +
		members +
		`</wfs:FeatureCollection>`
	)
}

/**
 * The real client over a stubbed transport, so the requests take the production path.
 */
function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "bizkaia test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

/**
 * The hits and feature responses for every component type, with one feature each.
 */
function componentOutcomes(): StubOutcome[] {
	return ES_BIZKAIA_COMPONENT_TYPES.flatMap((type) => [{ body: hitsXML(1) }, { body: featuresXML(type, 1) }])
}

describe("esBizkaiaInputPath", () => {
	it("states the directory the adapter reads, which holds the archives and the saved WFS documents", () => {
		expect(String(esBizkaiaInputPath(PathBuilder.from("/data/corpus/sources")))).toBe("/data/corpus/sources/es-bizkaia")
	})
})

describe("bizkaiaComponentFilename", () => {
	it("writes a prefixed type name under a .xml name the adapter's glob reaches", () => {
		expect(bizkaiaComponentFilename("ad:ThoroughfareName")).toBe("ad-ThoroughfareName.xml")
	})
})

describe("readESBizkaiaServiceFeed", async () => {
	const read = async (xml: string) => readESBizkaiaServiceFeed(await readAtomFeed(feedChunks(xml)))

	it("reads each entry's archive name from its identifier and its municipality from its title", async () => {
		const datasets = await read(SERVICE_XML)

		expect(datasets).toHaveLength(2)

		expect(datasets[0]).toStrictEqual({
			code: "48001",
			title: "48001-ABADIÑO Addresses",
			updated: FEED_UPDATED,
			downloadURL: "https://apli.bizkaia.eus/apps/Danok/INSPIRE/ES.BFA.AD.001.zip",
			filename: "ES.BFA.AD.001.zip",
		})

		// The identifier holds only the three-digit tail of the municipality code.
		expect(datasets[1]!.code).toBe("48915")
		expect(datasets[1]!.filename).toBe("ES.BFA.AD.915.zip")
	})

	it("refuses a service document holding no entry, rather than reporting an empty publisher", async () => {
		await expect(read(serviceXML())).rejects.toThrow(/holds no <entry>/u)
	})

	it("refuses an entry whose title and identifier name different municipalities", async () => {
		await expect(read(serviceXML(entryXML("48001", "ABADIÑO", "915")))).rejects.toThrow(
			/states municipality 48001 in its title and 915 in its archive name/u
		)
	})

	it("refuses an entry whose identifier is not an archive name", async () => {
		const malformed = serviceXML(entryXML("48001", "ABADIÑO", "001")).replace("ES.BFA.AD.001.zip<", "ES.BFA.AD<")

		await expect(read(malformed)).rejects.toThrow(/not an ES\.BFA\.AD\.<n>\.zip archive name/u)
	})

	it("refuses an entry carrying no enclosure link", async () => {
		const noEnclosure = serviceXML(entryXML("48001", "ABADIÑO", "001")).replace('rel="enclosure"', 'rel="related"')

		await expect(read(noEnclosure)).rejects.toThrow(/carries no rel="enclosure" link/u)
	})

	it("refuses two entries claiming one archive name, which would overwrite one municipality with the other", async () => {
		await expect(
			read(serviceXML(entryXML("48001", "ABADIÑO", "001"), entryXML("48001", "ABADIÑO", "001")))
		).rejects.toThrow(/is listed twice/u)
	})
})

describe("fetchBizkaiaComponentDocument", () => {
	it("asks for the count, then for that many features, and records both", async () => {
		await using temporary = await temporaryDirectory("mailwoman-bizkaia-component-")
		const client = stubClient([{ body: hitsXML(3) }, { body: featuresXML("ad:ThoroughfareName", 3) }])
		const dest = temporary.path("ad-ThoroughfareName.xml")

		const entry = await fetchBizkaiaComponentDocument(client, "ad:ThoroughfareName", { dest })

		expect(entry.feature_count).toBe(3)
		expect(entry.features_returned).toBe(3)
		expect(entry.filename).toBe("ad-ThoroughfareName.xml")
		expect(await pathExists(dest)).toBe(true)
		expect(await readLocalTextFile(dest)).toContain('gml:id="adComponent.3"')

		// One hits request and one feature request: this service advertises
		// ImplementsResultPaging=FALSE, so there is no second page to ask for.
		expect(client.calls).toHaveLength(2)
	})

	it("refuses a document holding fewer features than the service matched", async () => {
		await using temporary = await temporaryDirectory("mailwoman-bizkaia-truncated-")
		const client = stubClient([{ body: hitsXML(6921) }, { body: featuresXML("ad:ThoroughfareName", 1000) }])

		await expect(
			fetchBizkaiaComponentDocument(client, "ad:ThoroughfareName", { dest: temporary.path("tn.xml") })
		).rejects.toThrow(/matched 6921 features and returned 1000/u)
	})

	it("refuses a document stating no numberReturned rather than reading it as none", async () => {
		await using temporary = await temporaryDirectory("mailwoman-bizkaia-uncounted-")

		const uncounted =
			`<?xml version="1.0" encoding="utf-8"?>` +
			`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="unknown"/>`

		const client = stubClient([{ body: hitsXML(96) }, { body: uncounted }])

		await expect(
			fetchBizkaiaComponentDocument(client, "ad:PostalDescriptor", { dest: temporary.path("pd.xml") })
		).rejects.toThrow(/states numberReturned=null rather than a count/u)
	})

	it("refuses a hits response that declines to count, rather than reading it as zero features", async () => {
		await using temporary = await temporaryDirectory("mailwoman-bizkaia-uncountable-")
		const client = stubClient([{ body: hitsXML(0).replace('numberMatched="0"', 'numberMatched="unknown"') }])

		await expect(
			fetchBizkaiaComponentDocument(client, "ad:AdminUnitName", { dest: temporary.path("au.xml") })
		).rejects.toThrow(/declined to count/u)
	})
})

describe("harvestESBizkaia", () => {
	it("writes every archive, every component document, and one manifest naming both", async () => {
		await using temporary = await temporaryDirectory("mailwoman-bizkaia-harvest-")

		const client = stubClient([
			{ body: SERVICE_XML },
			{ body: archiveBody("abadino"), headers: { "last-modified": "Thu, 01 Oct 2026 00:01:15 GMT" } },
			{ body: archiveBody("ziortza"), headers: { "last-modified": "Thu, 01 Oct 2026 00:01:15 GMT" } },
			...componentOutcomes(),
		])

		const summary = await harvestESBizkaia(client, { outputDir: temporary.path })

		expect(summary).toStrictEqual({
			fetched: 2 + ES_BIZKAIA_COMPONENT_TYPES.length,
			skipped: 0,
			failed: 0,
			failedCodes: [],
		})

		expect(await pathExists(temporary.path("ES.BFA.AD.001.zip"))).toBe(true)
		expect(await pathExists(temporary.path("ES.BFA.AD.915.zip"))).toBe(true)

		for (const type of ES_BIZKAIA_COMPONENT_TYPES) {
			expect(await pathExists(temporary.path(bizkaiaComponentFilename(type)))).toBe(true)
		}

		const manifest = await readManifest<ESBizkaiaHarvestManifest>(temporary.path("MANIFEST.json"))

		expect(manifest?.municipalities_listed).toBe(2)
		expect(manifest?.feed_updated).toBe(FEED_UPDATED)
		expect(manifest?.files.map((file) => file.municipality_code)).toStrictEqual(["48001", "48915"])
		expect(manifest?.files[0]!.last_modified).toBe("Thu, 01 Oct 2026 00:01:15 GMT")

		expect(manifest?.components.map((entry) => entry.type_name)).toStrictEqual(
			[...ES_BIZKAIA_COMPONENT_TYPES].toSorted()
		)
	})

	it("skips an archive whose recorded <updated> and byte count the feed still describes", async () => {
		await using temporary = await temporaryDirectory("mailwoman-bizkaia-rerun-")

		const first = stubClient([
			{ body: SERVICE_XML },
			{ body: archiveBody("abadino") },
			{ body: archiveBody("ziortza") },
			...componentOutcomes(),
		])

		await harvestESBizkaia(first, { outputDir: temporary.path })

		const second = stubClient([{ body: SERVICE_XML }, ...componentOutcomes()])
		const summary = await harvestESBizkaia(second, { outputDir: temporary.path })

		expect(summary.skipped).toBe(2)
		// The component documents state no version, so they are read again on every run.
		expect(summary.fetched).toBe(ES_BIZKAIA_COMPONENT_TYPES.length)
		expect(summary.failed).toBe(0)
	})

	it("reports a municipality code the service document does not list as a failure", async () => {
		await using temporary = await temporaryDirectory("mailwoman-bizkaia-unknown-")
		const client = stubClient([{ body: SERVICE_XML }, ...componentOutcomes()])

		const summary = await harvestESBizkaia(client, {
			outputDir: temporary.path,
			municipalities: ["48999"],
		})

		expect(summary.failedCodes).toContain("48999")
		expect(summary.failed).toBe(1)
	})

	it("harvests the archives alone where a caller declines the component documents", async () => {
		await using temporary = await temporaryDirectory("mailwoman-bizkaia-archives-only-")
		const client = stubClient([{ body: SERVICE_XML }, { body: archiveBody("abadino") }])

		const summary = await harvestESBizkaia(client, {
			outputDir: temporary.path,
			limit: 1,
			components: false,
		})

		expect(summary).toStrictEqual({ fetched: 1, skipped: 0, failed: 0, failedCodes: [] })
		expect(await pathExists(temporary.path(bizkaiaComponentFilename("ad:ThoroughfareName")))).toBe(false)
	})

	it("reports an html error page served under http 200 rather than writing it under a .zip name", async () => {
		await using temporary = await temporaryDirectory("mailwoman-bizkaia-error-page-")

		const client = stubClient([
			{ body: SERVICE_XML },
			{ body: "<html><body>Service unavailable</body></html>" },
			...componentOutcomes(),
		])

		const summary = await harvestESBizkaia(client, { outputDir: temporary.path, limit: 1 })

		expect(summary.failedCodes).toStrictEqual(["48001"])
		expect(await pathExists(temporary.path("ES.BFA.AD.001.zip"))).toBe(false)
	})

	it("refuses a service exception report rather than reading it as a feed", async () => {
		await using temporary = await temporaryDirectory("mailwoman-bizkaia-exception-")

		const exception =
			`<?xml version="1.0"?><ExceptionReport xmlns="http://www.opengis.net/ows/1.1" version="2.0.0">` +
			`<Exception exceptionCode="NoApplicableCode"><ExceptionText>Service unavailable</ExceptionText>` +
			`</Exception></ExceptionReport>`

		await expect(harvestESBizkaia(stubClient([{ body: exception }]), { outputDir: temporary.path })).rejects.toThrow(
			/Service unavailable/u
		)
	})
})
