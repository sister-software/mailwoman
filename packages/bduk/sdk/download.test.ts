/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The download step over a stubbed `fetch` that answers with a ZIP built from the reader's fixture.
 */

import { readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { sha256Hex } from "@mailwoman/core/hash"
import { workspacePath } from "@mailwoman/core/paths"
import ADMZip from "adm-zip"
import { afterEach, describe, expect, test, vi } from "vitest"

import { BDUK_EXTRACTED_DIRECTORY } from "#paths"
import { downloadBDUKRegion } from "#sdk/download"

const URL_OF_ARCHIVE = "https://assets.publishing.service.gov.uk/media/0000/2026-09-10_zipped_files_release_test.zip"
const MEMBER = "202605_BDUK_uprn_release_test_sample.csv"

async function readFixtureText(): Promise<string> {
	return readLocalTextFile(workspacePath("bduk", "test", "fixtures", "202605_BDUK_uprn_release_sample.csv"))
}

/**
 * An archive laid out as BDUK publishes a region, with its members at the archive's root.
 */
function regionArchive(members: Record<string, string>): Buffer {
	const zip = new ADMZip()

	for (const [name, text] of Object.entries(members)) {
		zip.addFile(name, Buffer.from(text))
	}

	return zip.toBuffer()
}

/**
 * A stub for `fetch` that answers every request with the archive's bytes.
 */
function answerWith(body: Buffer): () => Promise<Response> {
	return async () => new Response(new Uint8Array(body), { status: 200 })
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("downloadBDUKRegion", () => {
	test("stores the archive under its release and region, extracts its CSV files and reports its size and SHA-256", async () => {
		const text = await readFixtureText()
		const archive = regionArchive({ [MEMBER]: text, "notes.txt": "not a release file" })

		vi.stubGlobal("fetch", answerWith(archive))
		await using scratch = await temporaryDirectory("bduk-download-")

		const report = await downloadBDUKRegion({
			url: URL_OF_ARCHIVE,
			expectedBytes: archive.length,
			release: "2026-05",
			region: "test",
			root: scratch.path(),
		})

		expect(report).toEqual({
			url: URL_OF_ARCHIVE,
			archive: scratch.path("2026-05", "test", "2026-09-10_zipped_files_release_test.zip").toString(),
			bytes: archive.length,
			sha256: sha256Hex(archive),
			transferred: true,
			extracted: scratch.path("2026-05", "test", BDUK_EXTRACTED_DIRECTORY).toString(),
			files: [MEMBER],
		})

		expect(sha256Hex(await readLocalBuffer(report.archive))).toBe(report.sha256)
		expect(await readLocalTextFile(scratch.path("2026-05", "test", BDUK_EXTRACTED_DIRECTORY, MEMBER))).toBe(text)
		expect(await pathExists(scratch.path("2026-05", "test", BDUK_EXTRACTED_DIRECTORY, "notes.txt"))).toBe(false)
	})

	test("reuses an archive already on disk without a transfer and hashes the bytes it holds", async () => {
		const archive = regionArchive({ [MEMBER]: await readFixtureText() })
		const options = { url: URL_OF_ARCHIVE, expectedBytes: archive.length, release: "2026-05", region: "test" }

		vi.stubGlobal("fetch", answerWith(archive))
		await using scratch = await temporaryDirectory("bduk-download-")

		const first = await downloadBDUKRegion({ ...options, root: scratch.path() })

		vi.stubGlobal("fetch", async () => {
			throw new Error("the second call must not transfer")
		})

		const second = await downloadBDUKRegion({ ...options, root: scratch.path() })

		expect(second).toEqual({ ...first, transferred: false })
	})

	test("a transfer of another size than the content item states throws and removes the archive", async () => {
		const archive = regionArchive({ [MEMBER]: await readFixtureText() })

		vi.stubGlobal("fetch", answerWith(archive))
		await using scratch = await temporaryDirectory("bduk-download-")

		await expect(
			downloadBDUKRegion({
				url: URL_OF_ARCHIVE,
				expectedBytes: archive.length + 1,
				release: "2026-05",
				region: "test",
				root: scratch.path(),
			})
		).rejects.toThrow(
			`bduk download: ${URL_OF_ARCHIVE} gave ${archive.length} bytes where the content item states ${archive.length + 1}; the archive was removed.`
		)

		expect(await pathExists(scratch.path("2026-05", "test", "2026-09-10_zipped_files_release_test.zip"))).toBe(false)
	})

	test("a refused request and an archive without a CSV file throw", async () => {
		await using scratch = await temporaryDirectory("bduk-download-")

		vi.stubGlobal("fetch", async () => new Response("absent", { status: 404 }))

		const options = { url: URL_OF_ARCHIVE, release: "2026-05", region: "test", root: scratch.path() }

		await expect(downloadBDUKRegion({ ...options, expectedBytes: 6 })).rejects.toThrow(/answered HTTP 404/)

		const empty = regionArchive({ "notes.txt": "not a release file" })

		vi.stubGlobal("fetch", answerWith(empty))

		await expect(downloadBDUKRegion({ ...options, expectedBytes: empty.length })).rejects.toThrow(
			/2026-09-10_zipped_files_release_test\.zip holds no CSV file/
		)
	})
})
