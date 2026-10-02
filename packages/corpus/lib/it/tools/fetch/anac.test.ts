/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { gzip } from "@mailwoman/core/fs/compression"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { silentLogger } from "@mailwoman/core/logging"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import { createITANACAdapter } from "#it/adapters/anac/adapter"
import {
	type ANACEditionManifest,
	anacEditionURL,
	decompressToJSONL,
	downloadITANAC,
	IT_ANAC_PUBLICATION_ID,
	isANACEditionCurrent,
	itANACInputPath,
	readANACEditionHead,
} from "#it/tools/fetch/anac"
import { writeManifest } from "#tools/fetch/download"

/**
 * One OCDS release, in the publisher's own shape, as a line of an edition.
 */
const RELEASE = stringifyJSON({
	ocid: "ocds-hu01ve-3913112",
	parties: [
		{
			name: "AGENZIA INTERREGIONALE PER IL FIUME PO AIPO",
			roles: ["buyer"],
			address: {
				locality: "PARMA",
				postalCode: "43121",
				countryName: "ITALY",
				streetAddress: "VIA GIUSEPPE GARIBALDI 75",
			},
		},
	],
})

/**
 * An `APIClient` over a scripted transport, with the dispatched URLs recorded on `calls`.
 */
function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "it-anac test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

describe("anacEditionURL", () => {
	it("names the publication the registry serves ANAC under", () => {
		expect(IT_ANAC_PUBLICATION_ID).toBe(117)

		expect(anacEditionURL("2025")).toBe(
			"https://data.open-contracting.org/en/publication/117/download?name=2025.jsonl.gz"
		)

		expect(anacEditionURL("full")).toBe(
			"https://data.open-contracting.org/en/publication/117/download?name=full.jsonl.gz"
		)
	})
})

describe("itANACInputPath", () => {
	it("answers the directory the adapter reads, rather than one edition inside it", () => {
		const outRoot = PathBuilder.from("/tmp/sources")

		expect(itANACInputPath(outRoot).toString()).toBe("/tmp/sources/it-anac")
	})
})

describe("readANACEditionHead", () => {
	it("reads the two headers the re-run check compares", async () => {
		await using client = stubClient([
			{ headers: { "content-length": "3963957", "last-modified": "Sat, 19 Sep 2026 03:31:23 GMT" } },
		])

		expect(await readANACEditionHead(client, "2025")).toEqual({
			lastModified: "Sat, 19 Sep 2026 03:31:23 GMT",
			contentLength: 3_963_957,
			contentType: null,
		})
	})

	it("reports a header the host does not send as null rather than as a value", async () => {
		await using client = stubClient([{ headers: {} }])

		expect(await readANACEditionHead(client, "full")).toEqual({
			lastModified: null,
			contentLength: null,
			contentType: null,
		})
	})
})

describe("decompressToJSONL", () => {
	it("keeps an accented place name whole across a gzip chunk boundary", async () => {
		await using scratch = await temporaryDirectory("mailwoman-it-anac-gunzip-")

		// Two releases whose locality names carry accented characters, padded
		// so the compressed stream is written in more than one chunk.
		const lines = Array.from({ length: 4000 }, (_, index) =>
			stringifyJSON({
				ocid: `ocds-hu01ve-${index}`,
				parties: [{ name: "COMUNE DI FORLÌ", roles: ["buyer"], address: { locality: "FORLÌ", postalCode: "47121" } }],
			})
		)

		const text = `${lines.join("\n")}\n`
		const compressed = scratch.path("2025.jsonl.gz")

		await writeLocalFile(await gzip(Buffer.from(text, "utf8")), compressed)
		await decompressToJSONL(compressed, scratch.path("2025.jsonl"))

		const written = await readLocalTextFile(scratch.path("2025.jsonl"))

		expect(written).toBe(text)
		expect(written).not.toContain("�")
	})
})

describe("isANACEditionCurrent", () => {
	/**
	 * A manifest entry and an edition file that agree, as a completed run would have left them.
	 */
	async function recordRun(directory: PathBuilder): Promise<{ recorded: ANACEditionManifest; path: PathBuilder }> {
		const path = directory("2025.jsonl")
		const text = `${RELEASE}\n`

		await writeLocalFile(text, path)

		return {
			path,
			recorded: {
				source_url: anacEditionURL("2025"),
				downloaded_at: "2026-10-02T06:00:00.000Z",
				filename: "2025.jsonl",
				sha256: await sha256File(path),
				bytes: Buffer.byteLength(text),
				last_modified: "Sat, 19 Sep 2026 03:31:23 GMT",
				compressed_bytes: 3_963_957,
			},
		}
	}

	const HEAD = { lastModified: "Sat, 19 Sep 2026 03:31:23 GMT", contentLength: 3_963_957, contentType: null }

	it("reads an edition the host and the manifest agree on as current", async () => {
		await using scratch = await temporaryDirectory("mailwoman-it-anac-current-")

		const { recorded, path } = await recordRun(scratch.path)

		expect(await isANACEditionCurrent(recorded, HEAD, path, false)).toBe(true)
		expect(await isANACEditionCurrent(recorded, HEAD, path, true)).toBe(true)
	})

	it("refuses an edition the host republished, by either header", async () => {
		await using scratch = await temporaryDirectory("mailwoman-it-anac-republished-")

		const { recorded, path } = await recordRun(scratch.path)

		expect(
			await isANACEditionCurrent(recorded, { ...HEAD, lastModified: "Fri, 2 Oct 2026 03:31:23 GMT" }, path, false)
		).toBe(false)

		expect(await isANACEditionCurrent(recorded, { ...HEAD, contentLength: 4_000_000 }, path, false)).toBe(false)
	})

	it("refuses an edition whose file on disk is not the recorded length", async () => {
		await using scratch = await temporaryDirectory("mailwoman-it-anac-truncated-")

		const { recorded, path } = await recordRun(scratch.path)

		await writeLocalFile("", path)

		expect(await isANACEditionCurrent(recorded, HEAD, path, false)).toBe(false)
	})

	it("refuses when the host states neither header, rather than reading the absence as a match", async () => {
		await using scratch = await temporaryDirectory("mailwoman-it-anac-headerless-")

		const { recorded, path } = await recordRun(scratch.path)

		expect(
			await isANACEditionCurrent(recorded, { lastModified: null, contentLength: null, contentType: null }, path, false)
		).toBe(false)
	})

	it("refuses an edition the manifest does not record", async () => {
		await using scratch = await temporaryDirectory("mailwoman-it-anac-unrecorded-")

		const { path } = await recordRun(scratch.path)

		expect(await isANACEditionCurrent(undefined, HEAD, path, false)).toBe(false)
	})
})

describe("downloadITANAC", () => {
	it("asks for no body when the HEAD agrees with the manifest and the edition is on disk", async () => {
		await using scratch = await temporaryDirectory("mailwoman-it-anac-rerun-")

		const editionPath = scratch.path("2025.jsonl")
		const text = `${RELEASE}\n`

		await writeLocalFile(text, editionPath)

		const recorded: ANACEditionManifest = {
			source_url: anacEditionURL("2025"),
			downloaded_at: "2026-10-02T06:00:00.000Z",
			filename: "2025.jsonl",
			sha256: await sha256File(editionPath),
			bytes: Buffer.byteLength(text),
			last_modified: "Sat, 19 Sep 2026 03:31:23 GMT",
			compressed_bytes: 3_963_957,
		}

		await writeManifest(scratch.path("MANIFEST.json"), {
			source: "it-anac",
			source_url: `https://data.open-contracting.org/en/publication/${IT_ANAC_PUBLICATION_ID}`,
			license: "CC-BY-4.0",
			attribution: "Autorità Nazionale Anticorruzione (ANAC), via the OCP Data Registry",
			downloaded_at: recorded.downloaded_at,
			files: [recorded],
		})

		await using client = stubClient([
			{ headers: { "content-length": "3963957", "last-modified": "Sat, 19 Sep 2026 03:31:23 GMT" } },
		])

		const summary = await downloadITANAC(client, { outputDir: scratch.path, editions: ["2025"] })

		expect(summary).toMatchObject({ fetched: 0, skipped: 1, failed: 0 })
		// The HEAD alone.
		// No request for the body was dispatched.
		expect(client.calls).toHaveLength(1)
		// The edition on disk is untouched, and the adapter still reads it.
		expect(await readLocalTextFile(editionPath)).toBe(text)
	})

	it("reports a failed edition and keeps the others' manifest entries", async () => {
		await using scratch = await temporaryDirectory("mailwoman-it-anac-failed-")

		await using client = stubClient([{ throws: { message: "socket hang up", code: "ERR_NETWORK" } }])

		const summary = await downloadITANAC(client, { outputDir: scratch.path, editions: ["2025"] })

		expect(summary).toMatchObject({ fetched: 0, skipped: 0, failed: 1, failedCodes: ["2025"] })
	})
})

describe("createITANACAdapter over a fetched directory", () => {
	it("reads every edition in the directory the fetcher writes", async () => {
		await using scratch = await temporaryDirectory("mailwoman-it-anac-directory-")

		await writeLocalFile(`${RELEASE}\n`, scratch.path("2024.jsonl"))
		await writeLocalFile(`${RELEASE}\n`, scratch.path("2025.jsonl"))

		const rows = await Array.fromAsync(createITANACAdapter().rows({ inputPath: scratch.path }))

		// One release per edition, and the two editions hold the same release, so the two rows are identical.
		// `runAdapter` owns deduplication, and the adapter emits one row per party occurrence.
		expect(rows).toHaveLength(2)
		expect(rows[0]?.raw).toBe("AGENZIA INTERREGIONALE PER IL FIUME PO AIPO, VIA GIUSEPPE GARIBALDI 75, 43121 PARMA")
	})

	it("raises on a directory holding no edition, rather than reading as a publisher with none", async () => {
		await using scratch = await temporaryDirectory("mailwoman-it-anac-empty-")

		await expect(Array.fromAsync(createITANACAdapter().rows({ inputPath: scratch.path }))).rejects.toThrow(
			/holds no \.jsonl edition/u
		)
	})
})
