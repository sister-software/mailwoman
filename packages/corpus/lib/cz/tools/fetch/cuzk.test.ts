/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { tryStat } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { silentLogger } from "@mailwoman/core/logging"
import { describe, expect, it } from "vitest"

import {
	CZ_CUZK_SERVICE_FEED_URL,
	type CzCuzkHarvestManifest,
	datasetFeedArchiveURL,
	harvestCzCuzk,
	municipalityCodeOf,
	projectionBaseURL,
	readCzCuzkServiceFeed,
} from "#cz/tools/fetch/cuzk"
import { feedChunks, readAtomFeed } from "#tools/fetch/atom"
import { readManifest } from "#tools/fetch/download"

/**
 * One municipality's entry in the service document.
 */
function entryXML(code: string, name: string, updated: string): string {
	return (
		`<entry><id>https://atom.cuzk.cz/AD/datasetFeeds/CZ-00025712-CUZK_AD_${code}.xml</id>` +
		`<title>INSPIRE - adresní místa - obec: ${name} [${code}]</title>` +
		`<updated>${updated}</updated><rights>žádné podmínky neplatí</rights>` +
		`<link href="http://geoportal.cuzk.gov.cz/SDIProCSW/service.svc/get?REQUEST=GetRecordById&amp;SERVICE=CSW` +
		`&amp;Id=CZ-00025712-CUZK_AD_${code}" rel="describedby" type="application/xml"/>` +
		`<link href="https://atom.cuzk.cz/AD/datasetFeeds/CZ-00025712-CUZK_AD_${code}.xml" rel="alternate" ` +
		`title="dataset feed" type="application/atom+xml"/>` +
		`<inspire_dls:spatial_dataset_identifier_code>CZ-00025712-CUZK_AD_${code}` +
		`</inspire_dls:spatial_dataset_identifier_code></entry>`
	)
}

/**
 * Two entries of the service document, as `https://atom.cuzk.gov.cz/AD/AD.xml` served them
 * on 2026-10-02, with the feed-level `rel="next"` links the download URL is composed from.
 */
const SERVICE_XML =
	`<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
	`<feed xmlns="http://www.w3.org/2005/Atom" ` +
	`xmlns:inspire_dls="http://inspire.ec.europa.eu/schemas/inspire_dls/1.0" xml:lang="cs">` +
	`<id>https://atom.cuzk.gov.cz/AD/AD.xml</id><title>INSPIRE … Adresy (AD)</title>` +
	`<rights>žádné podmínky neplatí</rights>` +
	`<link href="https://atom.cuzk.gov.cz/AD/AD.xml" hreflang="cs" rel="self" type="application/atom+xml"/>` +
	`<link href="https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258" rel="next" title="ETRS89" type="text/xml"/>` +
	`<link href="https://services.cuzk.gov.cz/gml/inspire/ad/epsg-5514" rel="next" title="S-JTSK" type="text/xml"/>` +
	entryXML("584061", "Unkovice", "2026-06-04T02:19:33+02:00") +
	entryXML("584282", "Židlochovice", "2026-09-22T02:57:55+02:00") +
	`</feed>`

/**
 * The dataset feed for one municipality, the second ATOM level.
 *
 * Its links advertise `application/gml+xml` on a body the host serves as `application/zip`,
 * which is the publisher's own spelling rather than a simplification.
 */
function datasetFeedXML(code: string): string {
	return (
		`<?xml version="1.0" encoding="UTF-8" standalone="no"?><feed xmlns="http://www.w3.org/2005/Atom">` +
		`<id>https://atom.cuzk.cz/AD/datasetFeeds/CZ-00025712-CUZK_AD_${code}.xml</id>` +
		`<link href="https://atom.cuzk.cz/AD/AD.xml" rel="up" type="application/atom+xml"/>` +
		`<entry><id>https://services.cuzk.gov.cz/gml/inspire/ad/epsg-5514/${code}.zip</id>` +
		`<link href="https://services.cuzk.gov.cz/gml/inspire/ad/epsg-5514/${code}.zip" length="25248" ` +
		`rel="alternate" type="application/gml+xml"/></entry>` +
		`<entry><id>https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/${code}.zip</id>` +
		`<link href="https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/${code}.zip" length="24846" ` +
		`rel="alternate" type="application/gml+xml"/></entry></feed>`
	)
}

/**
 * A body that is a zip archive as far as the fetcher reads it: the local-file-header
 * signature and some payload.
 *
 * The fetcher stores the archive for the adapter rather than opening it,
 * so what the members hold is the adapter's test's business.
 */
function archiveBody(payload: string): Buffer {
	return Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.from(payload, "utf8")])
}

/**
 * The scripted outcome for one archive request.
 */
function archiveOutcome(payload: string, lastModified?: string): StubOutcome {
	return {
		body: archiveBody(payload),
		headers: lastModified === undefined ? {} : { "last-modified": lastModified },
	}
}

/**
 * An `APIClient` over a scripted transport, with the dispatched URLs recorded on `calls`.
 *
 * The real client rather than a stubbed `fetch`, so the harvest's requests go through the
 * same adapter, error mapping and `responseType` handling they do against ČÚZK.
 * This stub sets no interval, because the caller chooses it and {@linkcode harvestCzCuzk} sets none.
 */
function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "cz-cuzk test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

describe("municipalityCodeOf", () => {
	it("reads the code off the INSPIRE identifier and checks it against the title", () => {
		expect(
			municipalityCodeOf({
				title: "INSPIRE - adresní místa - obec: Unkovice [584061]",
				identifierCode: "CZ-00025712-CUZK_AD_584061",
			})
		).toBe("584061")
	})

	it("refuses an entry whose title and identifier name different municipalities", () => {
		// The code is the file name the archive is stored under, so a disagreement would
		// store one municipality's addresses under another's name.
		expect(() =>
			municipalityCodeOf({ title: "… obec: Unkovice [584061]", identifierCode: "CZ-00025712-CUZK_AD_584282" })
		).toThrow(/states municipality 584061 in its title and 584282 in its dataset identifier/)
	})

	it("refuses an entry that states no code rather than inventing one", () => {
		expect(() => municipalityCodeOf({ title: "… obec: Unkovice", identifierCode: null })).toThrow(
			/ends in no municipality code/
		)

		expect(() =>
			municipalityCodeOf({ title: "… obec: Unkovice", identifierCode: "CZ-00025712-CUZK_AD_584061" })
		).toThrow(/states no municipality code in brackets/)
	})
})

describe("projectionBaseURL", () => {
	it("takes the base whose last path segment is the EPSG code rather than the one its title reads", async () => {
		const feed = await readAtomFeed(feedChunks(SERVICE_XML))

		expect(projectionBaseURL(feed, "epsg-4258")).toBe("https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258")
		expect(projectionBaseURL(feed, "epsg-5514")).toBe("https://services.cuzk.gov.cz/gml/inspire/ad/epsg-5514")
	})

	it("refuses a feed declaring no base for the projection, naming what it does declare", async () => {
		const withoutETRS = SERVICE_XML.replace(/<link[^>]*epsg-4258[^>]*\/>/u, "")
		const feed = await readAtomFeed(feedChunks(withoutETRS))

		expect(() => projectionBaseURL(feed, "epsg-4258")).toThrow(/declares no download base ending in \/epsg-4258/u)
		expect(() => projectionBaseURL(feed, "epsg-4258")).toThrow(/epsg-5514/u)
	})
})

describe("readCzCuzkServiceFeed", () => {
	it("composes each archive URL from the base the feed declares", async () => {
		const feed = await readAtomFeed(feedChunks(SERVICE_XML))
		const datasets = readCzCuzkServiceFeed(feed, "epsg-4258")

		// The count comes from the feed rather than from a number written here:
		// the publisher merges and adds municipalities.
		expect(datasets).toHaveLength(feed.entries.length)

		expect(datasets[0]).toMatchObject({
			code: "584061",
			updated: "2026-06-04T02:19:33+02:00",
			downloadURL: "https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/584061.zip",
			datasetFeedURL: "https://atom.cuzk.cz/AD/datasetFeeds/CZ-00025712-CUZK_AD_584061.xml",
			filename: "584061.zip",
		})
	})

	it("takes the dataset feed from the alternate link rather than the describedby link beside it", async () => {
		const feed = await readAtomFeed(feedChunks(SERVICE_XML))
		const [first] = readCzCuzkServiceFeed(feed, "epsg-4258")

		expect(first?.datasetFeedURL).toContain("atom.cuzk.cz")
		expect(first?.datasetFeedURL).not.toContain("geoportal.cuzk.gov.cz")
	})

	it("refuses a feed listing one municipality twice, which would overwrite one archive", async () => {
		const duplicated = SERVICE_XML.replace(
			"</feed>",
			entryXML("584061", "Unkovice", "2026-06-04T02:19:33+02:00") + "</feed>"
		)

		const feed = await readAtomFeed(feedChunks(duplicated))

		expect(() => readCzCuzkServiceFeed(feed, "epsg-4258")).toThrow(/584061 is listed twice/)
	})

	it("refuses a service document holding no entry rather than harvesting nothing", async () => {
		const feed = await readAtomFeed(feedChunks("<feed><title>Adresy</title></feed>"))

		expect(() => readCzCuzkServiceFeed(feed, "epsg-4258")).toThrow(/holds no <entry>/)
	})
})

describe("datasetFeedArchiveURL", () => {
	it("takes the entry whose href names the requested projection", async () => {
		const feed = await readAtomFeed(feedChunks(datasetFeedXML("584061")))

		expect(datasetFeedArchiveURL(feed, "epsg-4258", "cz-cuzk dataset feed 584061")).toBe(
			"https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/584061.zip"
		)
	})

	it("refuses a dataset feed that offers only the other projection", async () => {
		const onlySJTSK = datasetFeedXML("584061").replace(/<entry>[^]*?epsg-4258[^]*?<\/entry>/u, "")
		const feed = await readAtomFeed(feedChunks(onlySJTSK))

		expect(() => datasetFeedArchiveURL(feed, "epsg-4258", "cz-cuzk dataset feed 584061")).toThrow(
			/states no alternate link under \/epsg-4258\//u
		)
	})
})

describe("harvestCzCuzk", () => {
	it("writes one archive per municipality and a manifest recording each one's provenance", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cuzk-harvest-")

		await using client = stubClient([
			{ body: SERVICE_XML },
			archiveOutcome("unkovice", "Thu, 04 Jun 2026 00:19:33 GMT"),
			archiveOutcome("zidlochovice", "Tue, 22 Sep 2026 00:57:55 GMT"),
		])

		const summary = await harvestCzCuzk(client, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 2, skipped: 0, failed: 0 })

		// One request for the service document, then one per municipality, and no dataset feed.
		expect(client.calls).toEqual([
			CZ_CUZK_SERVICE_FEED_URL,
			"https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/584061.zip",
			"https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/584282.zip",
		])

		expect((await tryStat(scratch.path("584061.zip")))?.size).toBe(archiveBody("unkovice").byteLength)

		const manifest = await readManifest<CzCuzkHarvestManifest>(scratch.path("MANIFEST.json"))

		expect(manifest).toMatchObject({ source: "cz-cuzk", projection: "epsg-4258", municipalities_listed: 2 })
		expect(manifest?.license).toBe("no conditions apply to access and use")

		expect(manifest?.files[0]).toMatchObject({
			municipality_code: "584061",
			filename: "584061.zip",
			source_url: "https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/584061.zip",
			bytes: archiveBody("unkovice").byteLength,
			feed_updated: "2026-06-04T02:19:33+02:00",
			last_modified: "Thu, 04 Jun 2026 00:19:33 GMT",
		})

		// The digest is over the delivered body rather than over a length the feed claimed.
		expect(manifest?.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u)
		expect(manifest?.files[0]?.downloaded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
	})

	it("makes no archive request on a re-run where the feed states the recorded modification time", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cuzk-rerun-")

		await using first = stubClient([{ body: SERVICE_XML }, archiveOutcome("unkovice"), archiveOutcome("zidlochovice")])

		await harvestCzCuzk(first, { outputDir: scratch.path })

		await using second = stubClient([{ body: SERVICE_XML }, archiveOutcome("must not be requested")])

		const summary = await harvestCzCuzk(second, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 0, skipped: 2, failed: 0 })
		expect(second.calls).toEqual([CZ_CUZK_SERVICE_FEED_URL])
	})

	it("re-fetches only the municipality whose stated modification time moved", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cuzk-changed-")

		await using first = stubClient([{ body: SERVICE_XML }, archiveOutcome("unkovice"), archiveOutcome("zidlochovice")])

		await harvestCzCuzk(first, { outputDir: scratch.path })

		const republished = SERVICE_XML.replace("2026-09-22T02:57:55+02:00", "2026-10-02T03:11:04+02:00")

		await using second = stubClient([{ body: republished }, archiveOutcome("zidlochovice rebuilt")])

		const summary = await harvestCzCuzk(second, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 1, skipped: 1, failed: 0 })

		expect(second.calls).toEqual([
			CZ_CUZK_SERVICE_FEED_URL,
			"https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/584282.zip",
		])

		const manifest = await readManifest<CzCuzkHarvestManifest>(scratch.path("MANIFEST.json"))

		expect(manifest?.files.find((file) => file.municipality_code === "584282")?.feed_updated).toBe(
			"2026-10-02T03:11:04+02:00"
		)
	})

	it("re-fetches an archive that is no longer on disk at its recorded length", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cuzk-truncated-")

		await using first = stubClient([{ body: SERVICE_XML }, archiveOutcome("unkovice"), archiveOutcome("zidlochovice")])

		await harvestCzCuzk(first, { outputDir: scratch.path })

		// A transfer that ends early leaves a shorter file at the final name, and the
		// recorded byte count is what tells that file apart from the archive.
		await writeLocalFile(archiveBody("short"), scratch.path("584061.zip"))

		await using second = stubClient([{ body: SERVICE_XML }, archiveOutcome("unkovice")])

		const summary = await harvestCzCuzk(second, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 1, skipped: 1 })
		expect(second.calls.at(-1)).toBe("https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/584061.zip")
	})

	it("refuses a body that is not an archive, so an error page is never stored under a .zip name", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cuzk-errorpage-")

		await using client = stubClient([
			{ body: SERVICE_XML },
			// An html page under http 200 is what a host answers for a withdrawn file.
			{ body: "<html><body>Chyba 404</body></html>", headers: { "content-type": "text/html" } },
			archiveOutcome("zidlochovice"),
		])

		const summary = await harvestCzCuzk(client, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 1, failed: 1, failedCodes: ["584061"] })
		expect(await tryStat(scratch.path("584061.zip"))).toBeNull()

		// The municipality that answered an archive is still recorded, so one failure does not lose the run.
		const manifest = await readManifest<CzCuzkHarvestManifest>(scratch.path("MANIFEST.json"))

		expect(manifest?.files.map((file) => file.municipality_code)).toEqual(["584282"])
	})

	it("harvests a bounded subset, which is how the mechanism is proved without a national harvest", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cuzk-limit-")
		await using client = stubClient([{ body: SERVICE_XML }, archiveOutcome("unkovice")])

		const summary = await harvestCzCuzk(client, { outputDir: scratch.path, limit: 1 })

		expect(summary).toMatchObject({ fetched: 1, skipped: 0, failed: 0 })
		expect(client.calls).toHaveLength(2)
	})

	it("reports a named municipality the service document does not list rather than ignoring it", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cuzk-unknown-")
		await using client = stubClient([{ body: SERVICE_XML }, archiveOutcome("unkovice")])

		const summary = await harvestCzCuzk(client, {
			outputDir: scratch.path,
			municipalities: ["584061", "999999"],
		})

		expect(summary).toMatchObject({ fetched: 1, failed: 1, failedCodes: ["999999"] })
		expect(client.calls).toHaveLength(2)
	})

	it("takes the archive URL from the dataset feed when asked, at one extra request each", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cuzk-twolevel-")

		await using client = stubClient([
			{ body: SERVICE_XML },
			{ body: datasetFeedXML("584061") },
			archiveOutcome("unkovice"),
		])

		const summary = await harvestCzCuzk(client, {
			outputDir: scratch.path,
			limit: 1,
			resolveThroughDatasetFeed: true,
		})

		expect(summary).toMatchObject({ fetched: 1, failed: 0 })

		expect(client.calls).toEqual([
			CZ_CUZK_SERVICE_FEED_URL,
			"https://atom.cuzk.cz/AD/datasetFeeds/CZ-00025712-CUZK_AD_584061.xml",
			"https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/584061.zip",
		])
	})

	it("raises when the service document answers an exception report under http 200", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cuzk-exception-")

		await using client = stubClient([
			{
				body:
					`<?xml version="1.0"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1">` +
					`<ows:Exception exceptionCode="NoApplicableCode"><ows:ExceptionText>service unavailable` +
					`</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`,
			},
		])

		await expect(harvestCzCuzk(client, { outputDir: scratch.path })).rejects.toThrow(
			/NoApplicableCode: service unavailable/
		)
	})
})
