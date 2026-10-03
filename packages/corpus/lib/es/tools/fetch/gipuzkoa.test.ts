/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Proves how the Gipuzkoa fetcher resolves the download service to its one archive, and what it
 *   does where the feed states less than it needs.
 *
 *   The feed body is the shape `https://b5m.gipuzkoa.eus/inspire/download/addresses.xml` serves,
 *   reduced to the elements this fetcher reads, with the publisher's own relations kept: the dataset
 *   is a `rel="alternate"` link and the ISO 19139 record is a `rel="describedby"` link beside it.
 *   There is no `rel="enclosure"` link to find, which is the case a reader of INSPIRE feeds gets
 *   wrong.
 *
 *   `./gipuzkoa.integration.test.ts` reads the live service. This suite stubs the transport and runs
 *   the real `APIClient` over it, so the requests go through the same adapter and error mapping they
 *   do against the publisher.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { silentLogger } from "@mailwoman/core/logging"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	ES_GIPUZKOA_ARCHIVE_FILENAME,
	ES_GIPUZKOA_SERVICE_URL,
	esGipuzkoaInputPath,
	type GipuzkoaManifest,
	gipuzkoaPublicationIsRecorded,
	readGipuzkoaPublication,
	resolveGipuzkoaArchive,
} from "#es/tools/fetch/gipuzkoa"

const ARCHIVE_URL = "https://b5m.gipuzkoa.eus/inspire/download/GML/ES.GFA.AD.zip"

const METADATA_URL = "https://b5m.gipuzkoa.eus/metadata_inspire/ES.GFA.AD.MD.xml"

/**
 * The download service, which holds one entry for the whole province.
 *
 * The `describedby` link is written ahead of the `alternate` one, as the publisher writes it,
 * so a reader taking the entry's first link resolves the metadata record instead of the data.
 */
const SERVICE_FEED = `<?xml version='1.0' encoding='utf-8'?>
<feed xmlns="http://www.w3.org/2005/Atom"
	xmlns:inspire_dls="http://inspire.ec.europa.eu/schemas/inspire_dls/1.0" xml:lang="en">
	<title>Gipuzkoa Provincial Council Addresses Download Service </title>
	<id>${ES_GIPUZKOA_SERVICE_URL}</id>
	<rights>Access to this service is permitted in all cases, provided that the authorship and ownership of DFG are referred to as follows: «© Gipuzkoa Provincial Council»</rights>
	<updated>2014-11-05T08:08:00Z</updated>
	<entry>
		<title>Addresses</title>
		<inspire_dls:spatial_dataset_identifier_code>ES.GFA.AD.MD</inspire_dls:spatial_dataset_identifier_code>
		<id>${ES_GIPUZKOA_SERVICE_URL}</id>
		<link href="${METADATA_URL}" rel="describedby" type="application/xml"/>
		<link rel="alternate" href="${ARCHIVE_URL}" type="application/x-gmz" hreflang="en"/>
		<rights type="html"><![CDATA[<p>Open access - Creative Commons Citation: CC-BY-SA </p> ]]></rights>
		<updated>2017-01-01T08:08:00Z</updated>
	</entry>
</feed>`

/**
 * The real client over a stubbed transport, so the requests take the production path.
 */
function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "gipuzkoa test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

/**
 * A manifest recording one earlier download, for the freshness comparisons.
 */
function recordedManifest(overrides: Partial<GipuzkoaManifest> = {}): GipuzkoaManifest {
	return {
		source_url: ARCHIVE_URL,
		service_url: ES_GIPUZKOA_SERVICE_URL,
		filename: ES_GIPUZKOA_ARCHIVE_FILENAME,
		bytes: 7_959_103,
		sha256: "0".repeat(64),
		last_modified: "Sat, 08 Aug 2026 03:48:12 GMT",
		feed_updated: "2017-01-01T08:08:00Z",
		attribution: "«© Gipuzkoa Provincial Council»",
		downloaded_at: "2026-10-03T00:00:00.000Z",
		...overrides,
	}
}

describe("esGipuzkoaInputPath", () => {
	it("states the archive the adapter reads, under the fetcher's own directory", () => {
		const path = esGipuzkoaInputPath(PathBuilder.from("/data/corpus/sources"))

		expect(String(path)).toBe(`/data/corpus/sources/es-gipuzkoa/${ES_GIPUZKOA_ARCHIVE_FILENAME}`)
	})
})

describe("resolveGipuzkoaArchive", () => {
	it("takes the entry's rel=alternate link, which is the only relation this dataset is published under", async () => {
		const client = stubClient([{ body: SERVICE_FEED }])
		const reference = await resolveGipuzkoaArchive(client)

		expect(reference.archiveURL).toBe(ARCHIVE_URL)
		expect(reference.entryTitle).toBe("Addresses")
		expect(reference.feedUpdated).toBe("2017-01-01T08:08:00Z")

		expect(client.calls).toHaveLength(1)
		expect(client.calls[0]).toContain("addresses.xml")
	})

	it("does not resolve the describedby link the publisher writes ahead of the alternate", async () => {
		const reference = await resolveGipuzkoaArchive(stubClient([{ body: SERVICE_FEED }]))

		expect(reference.archiveURL).not.toBe(METADATA_URL)
	})

	it("refuses a feed holding no entry, rather than reporting an empty fetch", async () => {
		const empty = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>${ES_GIPUZKOA_SERVICE_URL}</id><title>Addresses</title></feed>`

		await expect(resolveGipuzkoaArchive(stubClient([{ body: empty }]))).rejects.toThrow(/holds no <entry>/u)
	})

	it("refuses an entry that carries no alternate link, naming the relations it does carry", async () => {
		const metadataOnly = SERVICE_FEED.replace(
			`<link rel="alternate" href="${ARCHIVE_URL}" type="application/x-gmz" hreflang="en"/>`,
			""
		)

		await expect(resolveGipuzkoaArchive(stubClient([{ body: metadataOnly }]))).rejects.toThrow(
			/carries no rel="alternate" link.*describedby/su
		)
	})

	it("refuses a service exception report rather than reading it as a feed", async () => {
		const exception = `<?xml version="1.0"?>
<ExceptionReport xmlns="http://www.opengis.net/ows/1.1" version="2.0.0">
	<Exception exceptionCode="NoApplicableCode"><ExceptionText>Service unavailable</ExceptionText></Exception>
</ExceptionReport>`

		await expect(resolveGipuzkoaArchive(stubClient([{ body: exception }]))).rejects.toThrow(/Service unavailable/u)
	})
})

describe("readGipuzkoaPublication", () => {
	it("reads the archive's last-modified and content-length", async () => {
		const client = stubClient([
			{ body: "", headers: { "last-modified": "Sat, 08 Aug 2026 03:48:12 GMT", "content-length": "7959103" } },
		])

		expect(await readGipuzkoaPublication(client, ARCHIVE_URL)).toStrictEqual({
			lastModified: "Sat, 08 Aug 2026 03:48:12 GMT",
			reportedBytes: 7_959_103,
		})
	})

	it("reads an absent header as null rather than as an empty string or a zero", async () => {
		const client = stubClient([{ body: "", headers: {} }])

		expect(await readGipuzkoaPublication(client, ARCHIVE_URL)).toStrictEqual({
			lastModified: null,
			reportedBytes: null,
		})
	})
})

describe("gipuzkoaPublicationIsRecorded", () => {
	it("agrees where the publisher's last-modified and the file's length are the recorded ones", () => {
		const recorded = recordedManifest()

		expect(
			gipuzkoaPublicationIsRecorded(recorded, 7_959_103, {
				lastModified: "Sat, 08 Aug 2026 03:48:12 GMT",
				reportedBytes: 7_959_103,
			})
		).toBe(true)
	})

	it("refuses where the publisher states no last-modified, although the manifest records none either", () => {
		const recorded = recordedManifest({ last_modified: null })

		// `null === null` would hold and freeze one archive on disk for as long as
		// the service declined to state a version.
		expect(gipuzkoaPublicationIsRecorded(recorded, 7_959_103, { lastModified: null, reportedBytes: null })).toBe(false)
	})

	it("refuses where the publisher's last-modified moved", () => {
		expect(
			gipuzkoaPublicationIsRecorded(recordedManifest(), 7_959_103, {
				lastModified: "Mon, 05 Oct 2026 03:48:12 GMT",
				reportedBytes: 7_959_200,
			})
		).toBe(false)
	})

	it("refuses where the file on disk is not the length that was recorded", () => {
		expect(
			gipuzkoaPublicationIsRecorded(recordedManifest(), 12, {
				lastModified: "Sat, 08 Aug 2026 03:48:12 GMT",
				reportedBytes: 7_959_103,
			})
		).toBe(false)
	})
})
