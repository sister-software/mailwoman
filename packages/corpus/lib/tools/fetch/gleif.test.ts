/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { silentLogger } from "@mailwoman/core/logging"
import { describe, expect, it } from "vitest"

import {
	gleifArchiveFilename,
	type GLEIFGoldenCopyReceipt,
	type GLEIFPublishedFile,
	isGLEIFArchiveCurrent,
	readGLEIFLatestPublish,
} from "#tools/fetch/gleif"

const ARCHIVE_URL =
	"https://goldencopy.gleif.org/storage/golden-copy-files/2026/10/03/1283915/20261003-0800-gleif-goldencopy-lei2-golden-copy.csv.zip"

/**
 * The publish API's answer for the 2026-10-03 08:00 publish, cut to the fields this module reads.
 */
const PUBLISH_BODY = {
	data: {
		publish_date: "2026-10-03 08:00:00",
		lei2: {
			type: "lei2",
			publish_date: "2026-10-03 08:00:00",
			full_file: {
				csv: {
					type: "lei2",
					format: "csv",
					record_count: 3_451_350,
					size: 507_006_221,
					url: ARCHIVE_URL,
					cdf_version: "LEI_3.1",
				},
			},
		},
	},
}

function stubClient(outcomes: StubOutcome[]): APIClient {
	const transport = stubTransport(outcomes)

	return new APIClient({ displayName: "gleif test", logger: silentLogger(), axios: transport.axios })
}

describe("readGLEIFLatestPublish", () => {
	it("reads the Level 1 CSV file the API names", async () => {
		await using client = stubClient([{ body: PUBLISH_BODY }])

		expect(await readGLEIFLatestPublish(client)).toEqual({
			publishDate: "2026-10-03 08:00:00",
			url: ARCHIVE_URL,
			bytes: 507_006_221,
			recordCount: 3_451_350,
			cdfVersion: "LEI_3.1",
		})
	})

	it("names the field an answer lacks rather than downloading an unchecked file", async () => {
		const body = structuredClone(PUBLISH_BODY) as { data: { lei2: { full_file: { csv: Record<string, unknown> } } } }

		delete body.data.lei2.full_file.csv["size"]

		await using client = stubClient([{ body }])

		await expect(readGLEIFLatestPublish(client)).rejects.toThrow(/data\.lei2\.full_file\.csv\.size/)
	})
})

describe("gleifArchiveFilename", () => {
	it("keeps the publisher's date-prefixed name", () => {
		expect(gleifArchiveFilename(ARCHIVE_URL)).toBe("20261003-0800-gleif-goldencopy-lei2-golden-copy.csv.zip")
	})

	it("refuses a URL naming another file", () => {
		expect(() =>
			gleifArchiveFilename(
				"https://goldencopy.gleif.org/storage/x/20261003-0800-gleif-goldencopy-rr-golden-copy.csv.zip"
			)
		).toThrow(/does not name a golden-copy archive/)
	})
})

describe("isGLEIFArchiveCurrent", () => {
	const PUBLISHED: GLEIFPublishedFile = {
		publishDate: "2026-10-03 08:00:00",
		url: ARCHIVE_URL,
		bytes: 4,
		recordCount: 1,
		cdfVersion: "LEI_3.1",
	}

	it("reads a recorded publish still on disk as current, and a new publish as not", async () => {
		await using scratch = await temporaryDirectory("mailwoman-gleif-current-")

		const path = scratch.path("archive.zip")

		await writeLocalFile("PK..", path)

		const recorded: GLEIFGoldenCopyReceipt = {
			source: "gleif-lei",
			source_url: ARCHIVE_URL,
			api_url: "",
			publish_date: PUBLISHED.publishDate,
			cdf_version: "LEI_3.1",
			record_count: 1,
			downloaded_at: "2026-10-03T13:51:30.051Z",
			filename: "archive.zip",
			bytes: 4,
			sha256: await sha256File(path),
			csv_member: "x.csv",
			csv_member_bytes: 1,
			license: "CC0-1.0",
			license_url: "",
			attribution: "",
		}

		expect(await isGLEIFArchiveCurrent(recorded, PUBLISHED, path, true)).toBe(true)

		expect(
			await isGLEIFArchiveCurrent(recorded, { ...PUBLISHED, publishDate: "2026-10-03 16:00:00" }, path, false)
		).toBe(false)

		expect(await isGLEIFArchiveCurrent(null, PUBLISHED, path, false)).toBe(false)

		await writeLocalFile("", path)

		expect(await isGLEIFArchiveCurrent(recorded, PUBLISHED, path, false)).toBe(false)
	})
})
