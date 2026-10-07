/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Proves that one archive transfer counts what arrived rather than what a header claimed, and
 *   that a body which is not an archive is refused instead of being written under an archive's name.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { tryStat } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { sha256Hex } from "@mailwoman/core/hash"
import { silentLogger } from "@mailwoman/core/logging"
import { describe, expect, it } from "vitest"

import { downloadZipArchive } from "#tools/fetch/zip-archive"

const ARCHIVE_URL = "https://example.invalid/AD.zip"

const BODY = Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.from("member", "utf8")])

function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "zip archive test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

describe("downloadZipArchive", () => {
	it("writes the archive and answers the byte count, digest and served modification time", async () => {
		await using scratch = await temporaryDirectory("mailwoman-zip-archive-")

		await using client = stubClient([
			{
				body: BODY,
				// The claimed length disagrees with the delivered body. Several INSPIRE
				// feeds behave this way through their own `length` attribute.
				headers: { "last-modified": "Tue, 14 Apr 2026 10:08:19 GMT", "content-length": "34987" },
			},
		])

		const delivered = await downloadZipArchive(client, { url: ARCHIVE_URL, dest: scratch.path("AD.zip") })

		expect(delivered).toEqual({
			bytes: BODY.byteLength,
			sha256: sha256Hex(BODY),
			lastModified: "Tue, 14 Apr 2026 10:08:19 GMT",
		})

		expect((await tryStat(scratch.path("AD.zip")))?.size).toBe(BODY.byteLength)
	})

	it("answers a null modification time where the host serves none", async () => {
		await using scratch = await temporaryDirectory("mailwoman-zip-archive-undated-")
		await using client = stubClient([{ body: BODY }])

		expect(
			(await downloadZipArchive(client, { url: ARCHIVE_URL, dest: scratch.path("AD.zip") })).lastModified
		).toBeNull()
	})

	it("refuses a body that is not an archive and writes no file", async () => {
		await using scratch = await temporaryDirectory("mailwoman-zip-archive-errorpage-")

		// An html page under http 200 is what several of these hosts answer for a path that
		// does not exist, so the status does not tell the two bodies apart.
		await using client = stubClient([
			{ body: "<html><body>Error</body></html>", headers: { "content-type": "text/html" } },
		])

		await expect(downloadZipArchive(client, { url: ARCHIVE_URL, dest: scratch.path("AD.zip") })).rejects.toThrow(
			/do not begin with a zip signature/u
		)

		expect(await tryStat(scratch.path("AD.zip"))).toBeNull()
	})
})
