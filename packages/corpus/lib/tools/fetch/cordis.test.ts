/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { silentLogger } from "@mailwoman/core/logging"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	type CORDISArchiveManifest,
	cordisArchiveFilename,
	cordisArchiveURL,
	cordisInputPath,
	CORDIS_PROGRAMMES,
	downloadCORDIS,
	isCORDISArchiveCurrent,
	readCORDISArchiveHead,
} from "#tools/fetch/cordis"
import { writeManifest } from "#tools/fetch/download"

/**
 * An `APIClient` over a scripted transport, with the dispatched URLs recorded on `calls`.
 */
function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "cordis test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

const H2020_HEAD = { "content-length": "55219250", "last-modified": "Tue, 22 Sep 2026 07:46:58 GMT" }

describe("cordisArchiveURL", () => {
	it("names the three programme archives in the spelling the host serves", () => {
		expect(CORDIS_PROGRAMMES.map(cordisArchiveURL)).toEqual([
			"https://cordis.europa.eu/data/cordis-fp7projects-csv.zip",
			"https://cordis.europa.eu/data/cordis-h2020projects-csv.zip",
			"https://cordis.europa.eu/data/cordis-HORIZONprojects-csv.zip",
		])

		expect(cordisArchiveFilename("h2020")).toBe("cordis-h2020projects-csv.zip")
	})
})

describe("cordisInputPath", () => {
	it("answers the directory the adapter reads", () => {
		expect(cordisInputPath(PathBuilder.from("/tmp/sources")).toString()).toBe("/tmp/sources/cordis")
	})
})

describe("readCORDISArchiveHead", () => {
	it("reads the two headers the re-run check compares", async () => {
		await using client = stubClient([{ headers: H2020_HEAD }])

		expect(await readCORDISArchiveHead(client, "h2020")).toEqual({
			lastModified: "Tue, 22 Sep 2026 07:46:58 GMT",
			contentLength: 55_219_250,
		})
	})

	it("reports a header the host does not send as null", async () => {
		await using client = stubClient([{ headers: {} }])

		expect(await readCORDISArchiveHead(client, "fp7")).toEqual({ lastModified: null, contentLength: null })
	})
})

/**
 * A manifest entry and an archive file that agree, as a completed run leaves them,
 * with the recorded length set to the host's stated length so the `HEAD` matches.
 */
async function recordRun(
	directory: PathBuilder,
	bytes: string
): Promise<{ recorded: CORDISArchiveManifest; path: PathBuilder }> {
	const path = directory(cordisArchiveFilename("h2020"))

	await writeLocalFile(bytes, path)

	return {
		path,
		recorded: {
			source_url: cordisArchiveURL("h2020"),
			downloaded_at: "2026-10-03T13:52:39.579Z",
			filename: cordisArchiveFilename("h2020"),
			sha256: await sha256File(path),
			bytes: Buffer.byteLength(bytes),
			last_modified: "Tue, 22 Sep 2026 07:46:58 GMT",
		},
	}
}

describe("isCORDISArchiveCurrent", () => {
	it("reads an archive the host and the manifest agree on as current", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cordis-current-")

		const { recorded, path } = await recordRun(scratch.path, "PK archive")
		const head = { lastModified: recorded.last_modified, contentLength: recorded.bytes }

		expect(await isCORDISArchiveCurrent(recorded, head, path, false)).toBe(true)
		expect(await isCORDISArchiveCurrent(recorded, head, path, true)).toBe(true)
	})

	it("refuses an archive the host republished, by either header", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cordis-republished-")

		const { recorded, path } = await recordRun(scratch.path, "PK archive")

		expect(
			await isCORDISArchiveCurrent(
				recorded,
				{ lastModified: "Thu, 01 Oct 2026 07:46:58 GMT", contentLength: recorded.bytes },
				path,
				false
			)
		).toBe(false)

		expect(
			await isCORDISArchiveCurrent(recorded, { lastModified: recorded.last_modified, contentLength: 1 }, path, false)
		).toBe(false)
	})

	it("refuses when the host states neither header, or the manifest records nothing", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cordis-headerless-")

		const { recorded, path } = await recordRun(scratch.path, "PK archive")

		expect(await isCORDISArchiveCurrent(recorded, { lastModified: null, contentLength: null }, path, false)).toBe(false)

		expect(
			await isCORDISArchiveCurrent(undefined, { lastModified: recorded.last_modified, contentLength: 10 }, path, false)
		).toBe(false)
	})

	it("refuses an archive whose file on disk is not the recorded length", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cordis-truncated-")

		const { recorded, path } = await recordRun(scratch.path, "PK archive")

		await writeLocalFile("PK", path)

		expect(
			await isCORDISArchiveCurrent(
				recorded,
				{ lastModified: recorded.last_modified, contentLength: recorded.bytes },
				path,
				false
			)
		).toBe(false)
	})
})

describe("downloadCORDIS", () => {
	it("asks for no body when the HEAD agrees with the manifest and the archive is on disk", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cordis-rerun-")

		const { recorded, path } = await recordRun(scratch.path, "PK archive")

		await writeManifest(scratch.path("MANIFEST.json"), {
			source: "cordis",
			source_url: "https://cordis.europa.eu/about/legal",
			license: "CC-BY-4.0",
			attribution: "© European Union, CORDIS (Publications Office of the European Union)",
			downloaded_at: recorded.downloaded_at,
			files: [recorded],
		})

		await using client = stubClient([
			{ headers: { "content-length": String(recorded.bytes), "last-modified": recorded.last_modified! } },
		])

		const summary = await downloadCORDIS(client, { outputDir: scratch.path, programmes: ["h2020"] })

		expect(summary).toMatchObject({ fetched: 0, skipped: 1, failed: 0 })
		// Only the HEAD.
		expect(client.calls).toHaveLength(1)
		expect(await readLocalTextFile(path)).toBe("PK archive")
	})

	it("reports a programme whose HEAD fails and writes the manifest it already holds", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cordis-failed-")

		await using client = stubClient([{ throws: { message: "socket hang up", code: "ERR_NETWORK" } }])

		const summary = await downloadCORDIS(client, { outputDir: scratch.path, programmes: ["fp7"] })

		expect(summary).toMatchObject({ fetched: 0, skipped: 0, failed: 1, failedCodes: ["fp7"] })
		expect(await readLocalTextFile(scratch.path("MANIFEST.json"))).toContain('"license": "CC-BY-4.0"')
	})
})
