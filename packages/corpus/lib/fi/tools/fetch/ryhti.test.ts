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
import { silentLogger } from "@mailwoman/core/logging"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	assertRyhtiColumns,
	decompressToCSV,
	downloadRyhti,
	FI_RYHTI_CSV_URL,
	FI_RYHTI_REQUIRED_COLUMNS,
	readRyhtiColumns,
	readRyhtiHead,
	type RyhtiManifest,
} from "#fi/tools/fetch/ryhti"
import { writeManifest } from "#tools/fetch/download"

/**
 * The header SYKE publishes, as the 2026-10-02 edition writes it: every name bare,
 * so a reader that assumed quoting would read `"address_key"` as a column name.
 */
const HEADER = FI_RYHTI_REQUIRED_COLUMNS.join(",")

/**
 * One data row in the publisher's own quoting: `municipality_number`, `postal_code`
 * and the two number-part columns quoted, every name column bare.
 *
 * Taken from the shape measured on the live file rather than from a uniform rule.
 */
const ROW = `0001,Mannerheimintie,Mannerheimvägen,HELSINKI,HELSINGFORS,"091","00100","11","",a,`

/**
 * An `APIClient` over a scripted transport, with the dispatched URLs recorded on `calls`.
 */
function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "ryhti test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

/**
 * A manifest describing a CSV already on disk, as a completed run would have left it.
 */
async function recordRun(
	directory: PathBuilderLike,
	csvPath: PathBuilderLike,
	head: { lastModified: string; compressedBytes: number }
): Promise<void> {
	const text = `${HEADER}\n${ROW}\n`

	await writeLocalFile(text, csvPath)

	const manifest: RyhtiManifest = {
		source_url: FI_RYHTI_CSV_URL,
		downloaded_at: "2026-10-02T06:00:00.000Z",
		filename: "open_address.csv",
		sha256: await sha256File(csvPath),
		bytes: Buffer.byteLength(text),
		license: "CC-BY-4.0",
		attribution: "Lähde: Syke Ryhti",
		last_modified: head.lastModified,
		compressed_bytes: head.compressedBytes,
		columns: FI_RYHTI_REQUIRED_COLUMNS,
	}

	await writeManifest(`${directory.toString()}/MANIFEST.json`, manifest)
}

describe("readRyhtiColumns", () => {
	it("reads the bare header names through the reader the adapter uses", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ryhti-header-")
		const path = scratch.path("open_address.csv")

		await writeLocalFile(`${HEADER}\n${ROW}\n`, path)

		expect(await readRyhtiColumns(path)).toEqual(FI_RYHTI_REQUIRED_COLUMNS)
	})

	it("strips the quotes a publisher puts on a header cell rather than keeping them in the name", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ryhti-quoted-header-")
		const path = scratch.path("open_address.csv")

		// Which columns are quoted is a property of the edition, so an edition that
		// quotes its header must read as the same column names.
		await writeLocalFile(`"address_key","municipality_number"\n"0001","091"\n`, path)

		expect(await readRyhtiColumns(path)).toEqual(["address_key", "municipality_number"])
	})

	it("raises on a file holding no row rather than answering no columns", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ryhti-empty-")
		const path = scratch.path("open_address.csv")

		await writeLocalFile("", path)

		await expect(readRyhtiColumns(path)).rejects.toThrow(/holds no row/)
	})
})

describe("assertRyhtiColumns", () => {
	it("accepts a header that names every column the adapter indexes, in any order", () => {
		expect(() => assertRyhtiColumns([...FI_RYHTI_REQUIRED_COLUMNS].toReversed(), "ctx")).not.toThrow()
	})

	it("accepts a header carrying columns the adapter ignores", () => {
		// The live file publishes 24 columns and the adapter consults a subset,
		// so an added column is not a failure.
		expect(() =>
			assertRyhtiColumns([...FI_RYHTI_REQUIRED_COLUMNS, "address_fin", "location_srid"], "ctx")
		).not.toThrow()
	})

	it("names the renamed column rather than letting the adapter read it as an empty string", () => {
		const renamed = FI_RYHTI_REQUIRED_COLUMNS.map((column) =>
			column === "municipality_number" ? "municipality_code" : column
		)

		expect(() => assertRyhtiColumns(renamed, "ryhti: open_address.csv")).toThrow(/municipality_number/)
	})
})

describe("readRyhtiHead", () => {
	it("reads the length and modification time the host states", async () => {
		await using client = stubClient([
			{ headers: { "content-length": "351290196", "last-modified": "Fri, 2 Oct 2026 05:20:14 GMT" } },
		])

		expect(await readRyhtiHead(client)).toEqual({
			contentLength: 351_290_196,
			lastModified: "Fri, 2 Oct 2026 05:20:14 GMT",
			contentType: null,
		})

		expect(client.calls).toEqual([FI_RYHTI_CSV_URL])
	})

	it("reports a header the host does not send as null rather than as zero", async () => {
		await using client = stubClient([{ headers: {} }])

		// A missing length is not a length of zero: the caller downloads rather than comparing.
		expect(await readRyhtiHead(client)).toMatchObject({ contentLength: null, lastModified: null })
	})

	it("reports a non-numeric content-length as null", async () => {
		await using client = stubClient([{ headers: { "content-length": "unknown" } }])

		expect((await readRyhtiHead(client)).contentLength).toBeNull()
	})
})

describe("downloadRyhti", () => {
	it("makes no request for the body where the HEAD agrees with the manifest", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ryhti-rerun-")

		await recordRun(scratch.path, scratch.path("open_address.csv"), {
			lastModified: "Fri, 2 Oct 2026 05:20:14 GMT",
			compressedBytes: 351_290_196,
		})

		await using client = stubClient([
			{ headers: { "content-length": "351290196", "last-modified": "Fri, 2 Oct 2026 05:20:14 GMT" } },
		])

		const summary = await downloadRyhti(client, { outputDir: scratch.path })

		expect(summary).toMatchObject({ fetched: 0, skipped: 1, failed: 0 })

		// Only the HEAD.
		// A body request against the real host would be 351 MB.
		expect(client.calls).toEqual([FI_RYHTI_CSV_URL])
	})

	it("does not skip where the host states a modification time the manifest does not record", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ryhti-republished-")

		await recordRun(scratch.path, scratch.path("open_address.csv"), {
			lastModified: "Thu, 1 Oct 2026 05:20:03 GMT",
			compressedBytes: 351_288_399,
		})

		await using client = stubClient([
			// The publisher republishes daily, and both the time and the length move when it does.
			{ headers: { "content-length": "351290196", "last-modified": "Fri, 2 Oct 2026 05:20:14 GMT" } },
			{ throws: { message: "the body must be requested", code: "ERR_NETWORK" } },
		])

		const summary = await downloadRyhti(client, {
			outputDir: scratch.path,
			signal: AbortSignal.abort(),
			retries: 0,
		})

		// The aborted signal refuses the transfer rather than skipping it.
		// That proves the re-run check did not match.
		expect(summary).toMatchObject({ fetched: 0, skipped: 0, failed: 1, failedCodes: ["ryhti"] })
	})

	it("does not skip where the recorded CSV is no longer on disk at its recorded length", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ryhti-truncated-")
		const csvPath = scratch.path("open_address.csv")

		await recordRun(scratch.path, csvPath, {
			lastModified: "Fri, 2 Oct 2026 05:20:14 GMT",
			compressedBytes: 351_290_196,
		})

		await writeLocalFile(`${HEADER}\n`, csvPath)

		await using client = stubClient([
			{ headers: { "content-length": "351290196", "last-modified": "Fri, 2 Oct 2026 05:20:14 GMT" } },
		])

		const summary = await downloadRyhti(client, {
			outputDir: scratch.path,
			signal: AbortSignal.abort(),
			retries: 0,
		})

		expect(summary).toMatchObject({ skipped: 0, failed: 1 })
	})

	it("does not skip where the host states neither a length nor a modification time", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ryhti-noheaders-")

		await recordRun(scratch.path, scratch.path("open_address.csv"), {
			lastModified: "Fri, 2 Oct 2026 05:20:14 GMT",
			compressedBytes: 351_290_196,
		})

		await using client = stubClient([{ headers: {} }])

		const summary = await downloadRyhti(client, {
			outputDir: scratch.path,
			signal: AbortSignal.abort(),
			retries: 0,
		})

		// A host that states neither value gives the check no term to compare. That is not agreement.
		expect(summary).toMatchObject({ skipped: 0, failed: 1 })
	})
})

describe("decompressToCSV", () => {
	it("decompresses stream to stream, and a character split across two gzip chunks arrives whole", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ryhti-gunzip-")
		const source = scratch.path("open_address.csv.gz")
		const destination = scratch.path("open_address.csv")

		// Finnish and Swedish place names are multi-byte, and `Ähtäri`/`Pedersöre` repeated
		// past any chunk boundary is what a per-chunk `toString("utf8")` turns into U+FFFD.
		// The file itself holds none: 60,014,592 decompressed bytes were scanned for `EF BF BD` with 0 found.
		const rows = Array.from({ length: 20_000 }, (_, index) => `${index},Ähtäri,Pedersöre,ÄHTÄRI,PEDERSÖRE`)
		const text = `${HEADER}\n${rows.join("\n")}\n`

		await writeLocalFile(await gzip(text), source)
		await decompressToCSV(source, destination)

		const restored = await readLocalTextFile(destination)

		expect(restored).toBe(text)
		expect(restored).not.toContain("�")
	})

	it("raises on a source that is not gzip rather than writing its bytes through", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ryhti-notgzip-")
		const source = scratch.path("open_address.csv.gz")

		const destination = scratch.path("open_address.csv")

		await writeLocalFile("<html><body>Service unavailable</body></html>", source)

		// `DecompressionStream` rejects a body that is not gzip with a bare `TypeError`,
		// so the class is what there is to assert on.
		await expect(decompressToCSV(source, destination)).rejects.toThrow(TypeError)

		// What matters is that the page's own bytes are not written through as though they were the CSV.
		expect(await readLocalTextFile(destination)).toBe("")
	})
})
