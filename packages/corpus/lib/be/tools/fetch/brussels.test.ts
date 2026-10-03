/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Proves what the Brussels fetcher reads from the publisher's HEAD response, and when it decides
 *   the archive on disk is already the one the service holds.
 *
 *   Paradigm publishes no INSPIRE ATOM feed for this theme, so `last-modified` carries the whole
 *   freshness decision. There is no `<updated>` element to compare and no dataset feed to resolve.
 *   The values here are the publisher's own, recorded when the reader was written: 11,521,182 bytes
 *   and `Thu, 01 Dec 2022 07:57:50 GMT`.
 *
 *   The download itself runs on global `fetch`, which a unit test cannot intercept, so these drive
 *   {@linkcode readBrusselsPublication} and the skip decision rather than a transfer.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { silentLogger } from "@mailwoman/core/logging"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	BE_BRUSSELS_ARCHIVE_FILENAME,
	type BrusselsManifest,
	brusselsInputPath,
	brusselsPublicationIsRecorded,
	readBrusselsPublication,
} from "#be/tools/fetch/brussels"

/**
 * What the publisher answered when this reader was written.
 */
const PUBLISHER_HEADERS = {
	"last-modified": "Thu, 01 Dec 2022 07:57:50 GMT",
	"content-length": "11521182",
}

const RECORDED: BrusselsManifest = {
	source_url: "https://urbisdownload.datastore.brussels/INSPIRE/URBIS_ADM_Adresses.zip",
	filename: BE_BRUSSELS_ARCHIVE_FILENAME,
	bytes: 11_521_182,
	sha256: "4a93ae1992c12234202a0d92affa7d9794a337f04a22b6ef68bef8aea4c9fc00",
	last_modified: "Thu, 01 Dec 2022 07:57:50 GMT",
	attribution: "Paradigm",
	downloaded_at: "2026-10-03T00:00:00.000Z",
}

/**
 * The real client over a stubbed transport, so the request takes the production path.
 */
function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "brussels test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

describe("brusselsInputPath", () => {
	it("states the archive the adapter reads, under the fetcher's own directory", () => {
		const path = brusselsInputPath(PathBuilder.from("/data/corpus/sources"))

		expect(String(path)).toBe(`/data/corpus/sources/brussels/${BE_BRUSSELS_ARCHIVE_FILENAME}`)
	})
})

describe("readBrusselsPublication", () => {
	it("reads the publisher's last-modified and byte count from one HEAD request", async () => {
		const client = stubClient([{ headers: PUBLISHER_HEADERS }])
		const publication = await readBrusselsPublication(client)

		expect(publication.lastModified).toBe("Thu, 01 Dec 2022 07:57:50 GMT")
		expect(publication.reportedBytes).toBe(11_521_182)
		expect(client.calls).toHaveLength(1)
	})

	it("reads an absent last-modified as unstated rather than as an empty string", async () => {
		const publication = await readBrusselsPublication(stubClient([{ headers: { "content-length": "11521182" } }]))

		expect(publication.lastModified).toBeNull()
	})

	it("reads an absent content-length as unstated rather than as zero bytes", async () => {
		const client = stubClient([{ headers: { "last-modified": PUBLISHER_HEADERS["last-modified"] } }])

		expect((await readBrusselsPublication(client)).reportedBytes).toBeNull()
	})
})

describe("brusselsPublicationIsRecorded", () => {
	it("holds where the manifest and the file on disk both match the publisher", () => {
		expect(
			brusselsPublicationIsRecorded(RECORDED, 11_521_182, {
				lastModified: RECORDED.last_modified,
				reportedBytes: 11_521_182,
			})
		).toBe(true)
	})

	it("fails where the publisher reports a different last-modified", () => {
		expect(
			brusselsPublicationIsRecorded(RECORDED, 11_521_182, {
				lastModified: "Fri, 02 Oct 2026 05:20:14 GMT",
				reportedBytes: 11_521_182,
			})
		).toBe(false)
	})

	it("fails where the file on disk is a different size from the one recorded", () => {
		expect(
			brusselsPublicationIsRecorded(RECORDED, 11_000_000, {
				lastModified: RECORDED.last_modified,
				reportedBytes: 11_521_182,
			})
		).toBe(false)
	})

	it("fails where the publisher states no last-modified, so a stale archive is never kept on silence", () => {
		expect(
			brusselsPublicationIsRecorded({ ...RECORDED, last_modified: null }, 11_521_182, {
				lastModified: null,
				reportedBytes: 11_521_182,
			})
		).toBe(false)
	})
})
