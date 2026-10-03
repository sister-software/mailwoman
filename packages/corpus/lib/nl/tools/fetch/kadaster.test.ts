/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Proves how the Kadaster fetcher resolves the ATOM download service to its one file, and what it
 *   does where the feed states less than it needs.
 *
 *   The bodies are the shape PDOK serves, reduced to the elements this fetcher reads. The byte count
 *   and the `<updated>` value are the publisher's real ones, recorded when the reader was written, so
 *   a change in what the fetcher resolves shows up against them.
 *
 *   `./kadaster.integration.test.ts` reads the live service. This suite stubs the transport and runs
 *   the real `APIClient` over it, so the requests go through the same adapter and error mapping they
 *   do against the publisher.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { silentLogger } from "@mailwoman/core/logging"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	NL_KADASTER_DOWNLOAD_FILENAME,
	NL_KADASTER_FEED_URL,
	nlKadasterInputPath,
	nlKadasterPublicationIsRecorded,
	readNLKadasterPublication,
	type NLKadasterManifest,
} from "#nl/tools/fetch/kadaster"

const DOWNLOAD_URL = "https://service.pdok.nl/kadaster/ad/atom/downloads/addresses.gml.gz"

const RIGHTS = "https://creativecommons.org/publicdomain/zero/1.0/deed.nl"

const UPDATED = "2026-09-02T11:45:47Z"

/**
 * The download service feed, whose one entry's `rel="alternate"` link is the whole country.
 *
 * The entry's `<id>` names a sibling feed rather than the data, and that feed answers HTTP 404,
 * so the id is written here as the publisher writes it to keep a reader from following it.
 */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="nl">
	<id>${NL_KADASTER_FEED_URL}</id>
	<title>Adressen (INSPIRE geharmoniseerd)</title>
	<link href="${NL_KADASTER_FEED_URL}" rel="self" hreflang="nl"></link>
	<rights>${RIGHTS}</rights>
	<updated>${UPDATED}</updated>
	<entry>
		<id>https://service.pdok.nl/kadaster/ad/atom/adressen_inspire_geharmoniseerd_epsg4258.xml</id>
		<title>Adressen (INSPIRE geharmoniseerd)</title>
		<link href="${DOWNLOAD_URL}" rel="alternate" type="application/octet-stream" hreflang="nl" length="819465603" title="addresses.gml.gz"></link>
		<rights>${RIGHTS}</rights>
		<updated>${UPDATED}</updated>
	</entry>
</feed>`

/**
 * The real client over a stubbed transport, so the requests take the production path.
 */
function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "nl-kadaster test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

/**
 * A manifest describing a run that recorded the feed's current `<updated>`.
 */
function recordedManifest(overrides: Partial<NLKadasterManifest> = {}): NLKadasterManifest {
	return {
		source_url: DOWNLOAD_URL,
		feed_url: NL_KADASTER_FEED_URL,
		filename: NL_KADASTER_DOWNLOAD_FILENAME,
		bytes: 819_465_603,
		sha256: "7ea1e45ee200327468eab8c8089a46ad99c334606cae19df7ba334cfae34cd5f",
		feed_updated: UPDATED,
		rights: RIGHTS,
		license: "CC0-1.0",
		attribution: "Kadaster",
		downloaded_at: "2026-10-03T00:00:00.000Z",
		...overrides,
	}
}

describe("nlKadasterInputPath", () => {
	it("states the gzipped GML the adapter reads, under the fetcher's own directory", () => {
		const path = nlKadasterInputPath(PathBuilder.from("/data/corpus/sources"))

		expect(String(path)).toBe(`/data/corpus/sources/nl-kadaster/${NL_KADASTER_DOWNLOAD_FILENAME}`)
	})

	it("keeps the .gz suffix, which is what makes the adapter inflate the file", () => {
		expect(NL_KADASTER_DOWNLOAD_FILENAME.endsWith(".gml.gz")).toBe(true)
	})
})

describe("readNLKadasterPublication", () => {
	it("reads the feed and answers the entry's data link rather than its id", async () => {
		const client = stubClient([{ body: FEED }])
		const publication = await readNLKadasterPublication(client)

		expect(publication.downloadURL).toBe(DOWNLOAD_URL)
		expect(publication.feedUpdated).toBe(UPDATED)
		expect(publication.rights).toBe(RIGHTS)
		expect(publication.claimedBytes).toBe(819_465_603)

		expect(client.calls[0]).toContain("adressen_inspire_geharmoniseerd.xml")
		expect(client.calls).toHaveLength(1)
	})

	it("refuses a feed that offers no download, rather than reporting an empty fetch", async () => {
		const empty = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>${NL_KADASTER_FEED_URL}</id><title>Adressen</title></feed>`

		await expect(readNLKadasterPublication(stubClient([{ body: empty }]))).rejects.toThrow(/offers no download/u)
	})

	it("refuses an entry carrying no link at all", async () => {
		const linkless = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<id>${NL_KADASTER_FEED_URL}</id>
	<entry><id>x</id><title>no link</title><updated>${UPDATED}</updated></entry>
</feed>`

		await expect(readNLKadasterPublication(stubClient([{ body: linkless }]))).rejects.toThrow(/offers no download/u)
	})

	it("refuses a service exception report rather than reading it as a feed", async () => {
		const exception = `<?xml version="1.0"?>
<ExceptionReport xmlns="http://www.opengis.net/ows/1.1" version="2.0.0">
	<Exception exceptionCode="NoApplicableCode"><ExceptionText>Service unavailable</ExceptionText></Exception>
</ExceptionReport>`

		await expect(readNLKadasterPublication(stubClient([{ body: exception }]))).rejects.toThrow(/Service unavailable/u)
	})

	it("takes a rel=enclosure link where the feed offers one", async () => {
		const enclosure = FEED.replace('rel="alternate"', 'rel="enclosure"')

		expect((await readNLKadasterPublication(stubClient([{ body: enclosure }]))).downloadURL).toBe(DOWNLOAD_URL)
	})

	it("reads an absent updated as null rather than as an empty string", async () => {
		const undated = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<id>${NL_KADASTER_FEED_URL}</id>
	<entry>
		<id>x</id>
		<link href="${DOWNLOAD_URL}" rel="alternate" type="application/octet-stream"></link>
	</entry>
</feed>`

		const publication = await readNLKadasterPublication(stubClient([{ body: undated }]))

		expect(publication.feedUpdated).toBeNull()
		expect(publication.claimedBytes).toBeNull()
	})
})

describe("nlKadasterPublicationIsRecorded", () => {
	const publication = { downloadURL: DOWNLOAD_URL, feedUpdated: UPDATED, rights: RIGHTS, claimedBytes: 819_465_603 }

	it("holds where the feed reports the recorded updated and the file is the recorded length", () => {
		expect(nlKadasterPublicationIsRecorded(recordedManifest(), 819_465_603, publication)).toBe(true)
	})

	it("refuses a skip where the feed states no updated, so a silent publisher is downloaded again", () => {
		expect(
			nlKadasterPublicationIsRecorded(recordedManifest({ feed_updated: null }), 819_465_603, {
				...publication,
				feedUpdated: null,
			})
		).toBe(false)
	})

	it("refuses a skip where the feed reports a later updated", () => {
		expect(
			nlKadasterPublicationIsRecorded(recordedManifest(), 819_465_603, {
				...publication,
				feedUpdated: "2026-10-01T00:00:00Z",
			})
		).toBe(false)
	})

	it("refuses a skip where the file on disk is shorter than the manifest records", () => {
		expect(nlKadasterPublicationIsRecorded(recordedManifest(), 12, publication)).toBe(false)
	})
})
