/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Proves how the Wallonia fetcher resolves two Atom feeds to one archive, and what it does where a
 *   feed states less than it needs.
 *
 *   The bodies are the shapes the Service public de Wallonie serves, reduced to the elements this
 *   fetcher reads. Byte counts and the sha256 are the publisher's real values, recorded when the
 *   reader was written, so a change in what the fetcher resolves shows up against them.
 *
 *   `./wallonie.integration.test.ts` would read the live service. This suite stubs the transport and
 *   runs the real `APIClient` over it, so the requests go through the same adapter and error mapping
 *   they do against the publisher.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubResult, stubTransport } from "@mailwoman/core/api/test-transport"
import { silentLogger } from "@mailwoman/core/logging"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	BE_WALLONIE_ARCHIVE_FILENAME,
	BE_WALLONIE_SERVICE_URL,
	resolveWallonieArchive,
	wallonieInputPath,
} from "#be/tools/fetch/wallonie"

const DATASET_FEED_URL =
	"https://geoservices.wallonie.be/inspire/atom/AD_Dataset_b62f8405-2ce3-449f-8a61-5fc2f38d8b73.xml"

const ARCHIVE_URL =
	"https://geoservices.wallonie.be/geotraitement/spwdatadownload/results/b62f8405-2ce3-449f-8a61-5fc2f38d8b73/AD.Addresses.gml.zip"

/**
 * The service document.
 *
 * It lists the region's one dataset feed through a `rel="alternate"` link.
 */
const SERVICE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<id>${BE_WALLONIE_SERVICE_URL}</id>
	<title>INSPIRE - Points d'adresses en Wallonie (BE)</title>
	<entry>
		<id>${DATASET_FEED_URL}</id>
		<title>AD.Addresses</title>
		<updated>2025-12-11T00:00:00Z</updated>
		<link rel="alternate" href="${DATASET_FEED_URL}" type="application/atom+xml"/>
	</entry>
</feed>`

/**
 * The dataset feed.
 * It offers one archive for the whole region.
 */
const DATASET_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<id>${DATASET_FEED_URL}</id>
	<title>AD.Addresses</title>
	<entry>
		<id>${ARCHIVE_URL}</id>
		<title>AD.Addresses.gml.zip</title>
		<updated>2025-12-11T00:00:00Z</updated>
		<link rel="enclosure" href="${ARCHIVE_URL}" type="application/zip" length="106665832"/>
	</entry>
</feed>`

/**
 * The real client over a stubbed transport, so the requests take the production path.
 */
function stubClient(results: StubResult[]): APIClient & { calls: string[] } {
	const transport = stubTransport(results)
	const client = new APIClient({ displayName: "wallonie test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

describe("wallonieInputPath", () => {
	it("states the archive the adapter reads, under the fetcher's own directory", () => {
		const path = wallonieInputPath(PathBuilder.from("/data/corpus/sources"))

		expect(String(path)).toBe(`/data/corpus/sources/wallonie/${BE_WALLONIE_ARCHIVE_FILENAME}`)
	})
})

describe("resolveWallonieArchive", () => {
	it("reads the service document, then the dataset feed it lists, then the archive that feed offers", async () => {
		const client = stubClient([{ body: SERVICE_FEED }, { body: DATASET_FEED }])
		const reference = await resolveWallonieArchive(client)

		expect(reference.datasetFeedURL).toBe(DATASET_FEED_URL)
		expect(reference.archiveURL).toBe(ARCHIVE_URL)

		// `updated` sits on the entry rather than on the feed, and reading the feed's own
		// element would answer undefined on every Wallonian harvest.
		expect(reference.feedUpdated).toBe("2025-12-11T00:00:00Z")

		expect(client.calls[0]).toContain("AD_Service.xml")
		expect(client.calls[1]).toContain("AD_Dataset_b62f8405-2ce3-449f-8a61-5fc2f38d8b73.xml")
		expect(client.calls).toHaveLength(2)
	})

	it("refuses a service document that lists no dataset feed, rather than reporting an empty fetch", async () => {
		const empty = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>${BE_WALLONIE_SERVICE_URL}</id><title>AD</title></feed>`

		await expect(resolveWallonieArchive(stubClient([{ body: empty }]))).rejects.toThrow(/lists no dataset feed/u)
	})

	it("refuses a dataset feed that offers no archive", async () => {
		const noArchive = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<id>${DATASET_FEED_URL}</id>
	<title>AD.Addresses</title>
	<entry><id>x</id><title>no link</title><updated>2025-12-11T00:00:00Z</updated></entry>
</feed>`

		await expect(resolveWallonieArchive(stubClient([{ body: SERVICE_FEED }, { body: noArchive }]))).rejects.toThrow(
			/offers no archive/u
		)
	})

	it("refuses a service exception report rather than reading it as a feed", async () => {
		const exception = `<?xml version="1.0"?>
<ExceptionReport xmlns="http://www.opengis.net/ows/1.1" version="2.0.0">
	<Exception exceptionCode="NoApplicableCode"><ExceptionText>Service unavailable</ExceptionText></Exception>
</ExceptionReport>`

		await expect(resolveWallonieArchive(stubClient([{ body: exception }]))).rejects.toThrow(/Service unavailable/u)
	})

	it("takes a rel=alternate archive link where the feed offers no enclosure", async () => {
		const alternateOnly = DATASET_FEED.replace('rel="enclosure"', 'rel="alternate"')
		const client = stubClient([{ body: SERVICE_FEED }, { body: alternateOnly }])

		expect((await resolveWallonieArchive(client)).archiveURL).toBe(ARCHIVE_URL)
	})
})
