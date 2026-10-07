/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Proves which link of a Navarran entry the harvest downloads, how it tells one partition from
 *   another when every entry is titled alike, and what it does where the feed states less than it
 *   needs.
 *
 *   The bodies are the shapes `filescartografia.navarra.es` served on 2026-10-03, reduced to the
 *   elements this harvest reads. Each entry keeps all six of its links, because the one that must
 *   not be downloaded is among them: the entry's first `alternate` link is the dataset feed rather
 *   than the archive.
 *
 *   `./navarra.integration.test.ts` reads the live service. This suite stubs the transport and runs
 *   the real `APIClient` over it, so the requests go through the same adapter and error mapping
 *   they do against the publisher.
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
	ES_NAVARRA_SERVICE_FEED_URL,
	type ESNavarraHarvestManifest,
	esNavarraInputPath,
	harvestESNavarra,
	readESNavarraServiceFeed,
} from "#es/tools/fetch/navarra"
import { feedChunks, readAtomFeed } from "#tools/fetch/atom"
import { readManifest } from "#tools/fetch/download"

const PUBLICATION = "2026-04-14T12:06:58Z"

const FILES_BASE =
	"https://filescartografia.navarra.es/2_CARTOGRAFIA_TEMATICA/2_7_CATASTRO/2_7_3_INSPIRE_ATOM/2_7_3_3_AD/files"

const RIGHTS =
	"This layer is published under the terms of the license Creative Commons Attribution 4.0 International(CC BY 4.0)."

function archiveURL(partition: number): string {
	return `${FILES_BASE}/AD_Navarra_${partition}.gml.zip`
}

/**
 * One partition's entry, with the six links the publisher writes.
 *
 * The `length` is the same 34,987 the publisher states on every entry.
 * That is why no byte count here is read from it.
 */
function entryXML(partition: number, updated = PUBLICATION): string {
	const archive = archiveURL(partition)

	return (
		`<entry><title>Address Navarra</title><id></id><updated>${updated}</updated>` +
		`<rights>${RIGHTS}</rights>` +
		`<link rel="describedby" type="application/xml" href="https://idena.navarra.es/ogc/csw?SERVICE=CSW&amp;REQUEST=GetRecordById&amp;ID=engSITNAINSPIRE_ES_SITNA_AD"/>` +
		`<link rel="alternate" type="application/atom+xml" title="dataset link" href="Addresses_DatasetATOM_Navarra.xml"/>` +
		`<link rel="related" type="application/xml" title="Service implementing Direct Access operations" href="https://inspire.navarra.es/services/AD/wfs?service=WFS&amp;request=getcapabilities"/>` +
		`<link rel="enclosure" type="application/x-gmz" title="Zipped GML Addresses" href="${archive}"/>` +
		`<link rel="section" type="application/x-gmz" title="Zipped GML Addresses" href="${archive}"/>` +
		`<link rel="alternate" type="application/x-gmz" length="34987" title="The dataset encoded as a dataset in WGS84 in zip format" href="${archive}"/>` +
		`<inspire_dls:spatial_dataset_identifier_code>AD:Address</inspire_dls:spatial_dataset_identifier_code>` +
		`</entry>`
	)
}

function serviceXML(entries = entryXML(1) + entryXML(100)): string {
	return (
		`<?xml version="1.0" encoding="UTF-8"?>` +
		`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:inspire_dls="http://inspire.ec.europa.eu/schemas/inspire_dls/1.0">` +
		`<title>Addresses Navarra</title><updated>${PUBLICATION}</updated><rights>${RIGHTS}</rights>` +
		`<link rel="self" type="application/atom+xml" title="This document" href="Addresses_ServiceATOM_Navarra.xml"/>` +
		entries +
		`</feed>`
	)
}

/**
 * A body that is a zip archive as far as the harvest reads it.
 */
function archiveBody(payload: string): Buffer {
	return Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.from(payload, "utf8")])
}

function archiveOutcome(payload: string, lastModified?: string): StubOutcome {
	return {
		body: archiveBody(payload),
		headers: lastModified === undefined ? {} : { "last-modified": lastModified },
	}
}

/**
 * The real client over a scripted transport, with the dispatched URLs recorded on `calls`.
 */
function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "es-navarra test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

describe("readESNavarraServiceFeed", () => {
	it("takes the enclosure link rather than the first alternate link, which is the dataset feed", async () => {
		const partitions = readESNavarraServiceFeed(await readAtomFeed(feedChunks(serviceXML())))

		expect(partitions.map((partition) => partition.partition)).toEqual(["1", "100"])
		expect(partitions[0]?.archiveURL).toBe(archiveURL(1))
		expect(partitions[0]?.archiveURL).not.toContain("Addresses_DatasetATOM_Navarra.xml")
		expect(partitions[0]?.filename).toBe("AD_Navarra_1.gml.zip")
		expect(partitions[0]?.updated).toBe(PUBLICATION)
	})

	it("reads the partition off the archive's file name, which is the feed's only statement of it", async () => {
		const feed = await readAtomFeed(feedChunks(serviceXML(entryXML(1) + entryXML(100) + entryXML(908))))
		const partitions = readESNavarraServiceFeed(feed)

		// Every title is `Address Navarra` and every id is empty. The published numbers
		// are not contiguous, so the count comes from the feed rather than from a number here.
		expect(partitions).toHaveLength(feed.entries.length)
		expect(new Set(feed.entries.map((entry) => entry.title)).size).toBe(1)
		expect(partitions.at(-1)?.partition).toBe("908")
	})

	it("refuses a service document holding no entry rather than reporting a completed run", async () => {
		const feed = await readAtomFeed(feedChunks(`<feed><title>Addresses Navarra</title></feed>`))

		expect(() => readESNavarraServiceFeed(feed)).toThrow(/holds no <entry>/u)
	})

	it("refuses an entry carrying no enclosure link", async () => {
		const withoutEnclosure = entryXML(1).replace(/<link rel="enclosure"[^>]*\/>/u, "")
		const feed = await readAtomFeed(feedChunks(serviceXML(withoutEnclosure)))

		expect(() => readESNavarraServiceFeed(feed)).toThrow(/carries no rel="enclosure" link/u)
	})

	it("refuses an entry linking a file that is not a Navarran partition", async () => {
		const renamed = entryXML(1).replaceAll("AD_Navarra_1.gml.zip", "AD_Navarra.gml.zip")
		const feed = await readAtomFeed(feedChunks(serviceXML(renamed)))

		expect(() => readESNavarraServiceFeed(feed)).toThrow(/is not named AD_Navarra_<n>\.gml\.zip/u)
	})

	it("refuses a feed listing one partition twice, which would overwrite one archive", async () => {
		const feed = await readAtomFeed(feedChunks(serviceXML(entryXML(1) + entryXML(1))))

		expect(() => readESNavarraServiceFeed(feed)).toThrow(/is listed twice/u)
	})
})

describe("esNavarraInputPath", () => {
	it("states the directory the adapter reads, under the fetcher's own slug", () => {
		expect(String(esNavarraInputPath(PathBuilder.from("/data/corpus/sources")))).toBe("/data/corpus/sources/es-navarra")
	})
})

describe("harvestESNavarra", () => {
	it("writes one archive per partition and a manifest recording each one's provenance", async () => {
		await using scratch = await temporaryDirectory("mailwoman-navarra-harvest-")

		await using client = stubClient([
			{ body: serviceXML() },
			archiveOutcome("partition 1", "Tue, 14 Apr 2026 10:08:19 GMT"),
			archiveOutcome("partition 100"),
		])

		const summary = await harvestESNavarra(client, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 2, skipped: 0, failed: 0 })

		expect(client.calls).toEqual([ES_NAVARRA_SERVICE_FEED_URL, archiveURL(1), archiveURL(100)])

		expect((await tryStat(scratch.path("AD_Navarra_1.gml.zip")))?.size).toBe(archiveBody("partition 1").byteLength)

		const manifest = await readManifest<ESNavarraHarvestManifest>(scratch.path("MANIFEST.json"))

		expect(manifest).toMatchObject({ source: "es-navarra", partitions_listed: 2 })
		expect(manifest?.license).toBe("CC-BY-4.0")
		expect(manifest?.attribution).toBe("Gobierno de Navarra")

		expect(manifest?.files[0]).toMatchObject({
			partition: "1",
			filename: "AD_Navarra_1.gml.zip",
			source_url: archiveURL(1),
			bytes: archiveBody("partition 1").byteLength,
			feed_updated: PUBLICATION,
			last_modified: "Tue, 14 Apr 2026 10:08:19 GMT",
		})

		// The digest is over the delivered body rather than over the length every entry claims.
		expect(manifest?.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u)
		expect(manifest?.files[0]?.bytes).not.toBe(34_987)
	})

	it("orders the manifest by partition number rather than by the file name's spelling", async () => {
		await using scratch = await temporaryDirectory("mailwoman-navarra-order-")

		await using client = stubClient([
			{ body: serviceXML(entryXML(100) + entryXML(2)) },
			archiveOutcome("partition 100"),
			archiveOutcome("partition 2"),
		])

		await harvestESNavarra(client, { outputDir: scratch.path })

		const manifest = await readManifest<ESNavarraHarvestManifest>(scratch.path("MANIFEST.json"))

		expect(manifest?.files.map((file) => file.partition)).toEqual(["2", "100"])
	})

	it("makes no archive request on a re-run where the feed states the recorded date", async () => {
		await using scratch = await temporaryDirectory("mailwoman-navarra-rerun-")

		await using first = stubClient([{ body: serviceXML() }, archiveOutcome("one"), archiveOutcome("hundred")])

		await harvestESNavarra(first, { outputDir: scratch.path })

		await using second = stubClient([{ body: serviceXML() }, archiveOutcome("must not be requested")])
		const summary = await harvestESNavarra(second, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 0, skipped: 2, failed: 0 })
		expect(second.calls).toEqual([ES_NAVARRA_SERVICE_FEED_URL])
	})

	it("re-fetches only the partition whose stated publication date moved", async () => {
		await using scratch = await temporaryDirectory("mailwoman-navarra-republished-")

		await using first = stubClient([{ body: serviceXML() }, archiveOutcome("one"), archiveOutcome("hundred")])

		await harvestESNavarra(first, { outputDir: scratch.path })

		const republished = serviceXML(entryXML(1) + entryXML(100, "2026-09-30T08:00:00Z"))

		await using second = stubClient([{ body: republished }, archiveOutcome("hundred rebuilt")])
		const summary = await harvestESNavarra(second, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 1, skipped: 1, failed: 0 })
		expect(second.calls).toEqual([ES_NAVARRA_SERVICE_FEED_URL, archiveURL(100)])
	})

	it("downloads again where the feed states no publication date at all", async () => {
		await using scratch = await temporaryDirectory("mailwoman-navarra-silent-")
		const undated = serviceXML(entryXML(1, ""))

		await using first = stubClient([{ body: undated }, archiveOutcome("one")])

		await harvestESNavarra(first, { outputDir: scratch.path })

		await using second = stubClient([{ body: undated }, archiveOutcome("one")])

		// Both sides read an empty string, so an equality test would hold and keep an
		// archive of unknown age for as long as the publisher stayed silent.
		const summary = await harvestESNavarra(second, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 1, skipped: 0 })
		expect(second.calls).toEqual([ES_NAVARRA_SERVICE_FEED_URL, archiveURL(1)])
	})

	it("re-fetches an archive that is no longer on disk at its recorded length", async () => {
		await using scratch = await temporaryDirectory("mailwoman-navarra-truncated-")

		await using first = stubClient([{ body: serviceXML(entryXML(1)) }, archiveOutcome("one")])

		await harvestESNavarra(first, { outputDir: scratch.path })

		await writeLocalFile(archiveBody("short"), scratch.path("AD_Navarra_1.gml.zip"))

		await using second = stubClient([{ body: serviceXML(entryXML(1)) }, archiveOutcome("one")])
		const summary = await harvestESNavarra(second, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 1, skipped: 0 })
		expect(second.calls.at(-1)).toBe(archiveURL(1))
	})

	it("refuses a body that is not an archive, so an html page is never stored under a .zip name", async () => {
		await using scratch = await temporaryDirectory("mailwoman-navarra-errorpage-")

		await using client = stubClient([
			{ body: serviceXML() },
			{ body: "<html><body>Not found</body></html>", headers: { "content-type": "text/html" } },
			archiveOutcome("hundred"),
		])

		const summary = await harvestESNavarra(client, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 1, failed: 1, failedCodes: ["1"] })
		expect(await tryStat(scratch.path("AD_Navarra_1.gml.zip"))).toBeNull()

		// The partition that answered an archive is still recorded, so one failure does not lose the run.
		const manifest = await readManifest<ESNavarraHarvestManifest>(scratch.path("MANIFEST.json"))

		expect(manifest?.files.map((file) => file.partition)).toEqual(["100"])
	})

	it("harvests a bounded subset, which is how the mechanism is proved without a full harvest", async () => {
		await using scratch = await temporaryDirectory("mailwoman-navarra-limit-")
		await using client = stubClient([{ body: serviceXML() }, archiveOutcome("one")])

		const summary = await harvestESNavarra(client, { outputDir: scratch.path, limit: 1 })

		expect(summary).toMatchObject({ fetched: 1, skipped: 0, failed: 0 })
		expect(client.calls).toEqual([ES_NAVARRA_SERVICE_FEED_URL, archiveURL(1)])
	})

	it("reports a named partition the service document does not list rather than ignoring it", async () => {
		await using scratch = await temporaryDirectory("mailwoman-navarra-unknown-")
		await using client = stubClient([{ body: serviceXML() }, archiveOutcome("one")])

		const summary = await harvestESNavarra(client, { outputDir: scratch.path, partitions: ["1", "909"] })

		expect(summary).toMatchObject({ fetched: 1, failed: 1, failedCodes: ["909"] })
		expect(client.calls).toEqual([ES_NAVARRA_SERVICE_FEED_URL, archiveURL(1)])
	})

	it("raises when the service document answers an exception report under http 200", async () => {
		await using scratch = await temporaryDirectory("mailwoman-navarra-exception-")

		await using client = stubClient([
			{
				body:
					`<?xml version="1.0"?><ExceptionReport xmlns="http://www.opengis.net/ows/1.1" version="2.0.0">` +
					`<Exception exceptionCode="NoApplicableCode"><ExceptionText>Service unavailable</ExceptionText>` +
					`</Exception></ExceptionReport>`,
			},
		])

		await expect(harvestESNavarra(client, { outputDir: scratch.path })).rejects.toThrow(/Service unavailable/u)
	})
})
