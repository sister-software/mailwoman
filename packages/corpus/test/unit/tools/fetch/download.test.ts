/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import {
	attachmentFilename,
	cookieHeader,
	downloadToFile,
	isTransientStatus,
	loadCollectionFiles,
	loadManifestEntries,
	readManifest,
	resumableDownload,
	streamBodyToFile,
	withRetries,
	writeManifest,
} from "@mailwoman/corpus/tools/fetch/download"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let server: Server
let base: string
let flakyHits = 0
let rangeConnections = 0

/**
 * The body the `/range` route serves: 40 bytes, so a 16-byte-per-connection host needs three connections.
 */
const RANGE_BODY = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz!@#$")
const RANGE_CHUNK = 16

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.url === "/ok") {
			res.writeHead(200)
			res.end("payload")
		} else if (req.url === "/range") {
			// A host that answers `Range` with 206 and closes after a few bytes, the shape the Korean address portal
			// has: the client must keep what landed and ask for the remainder. The body ends cleanly rather than by
			// `destroy()`, because a reset can discard bytes the socket already carried and the connection count
			// then depends on timing; the client's path (bytes on disk, next range from there) is the same either way.
			rangeConnections++
			const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? 0)

			if (start >= RANGE_BODY.length) {
				res.writeHead(416, { "content-range": `bytes */${RANGE_BODY.length}` })
				res.end()

				return
			}

			const end = Math.min(start + RANGE_CHUNK, RANGE_BODY.length)
			res.writeHead(206, { "content-range": `bytes ${start}-${RANGE_BODY.length - 1}/${RANGE_BODY.length}` })
			res.end(RANGE_BODY.subarray(start, end))
		} else if (req.url === "/no-range") {
			res.writeHead(200)
			res.end("whole body, no ranges here")
		} else if (req.url === "/flaky") {
			flakyHits++

			if (flakyHits < 3) {
				res.writeHead(503)
				res.end("try later")
			} else {
				res.writeHead(200)
				res.end("finally")
			}
		} else {
			res.writeHead(404)
			res.end("nope")
		}
	})

	await new Promise<void>((resolve) => {
		server.listen(0, resolve)
	})

	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => server[Symbol.asyncDispose]())

describe("downloadToFile", () => {
	it("writes the body and reports bytes", async () => {
		await using scratch = await temporaryDirectory("dl-")
		const dest = scratch.resolve("ok.txt")
		const { bytes } = await downloadToFile({ url: `${base}/ok`, dest })
		expect(bytes).toBe(7)
		expect(await readLocalTextFile(dest)).toBe("payload")
	})

	it("retries transient statuses until success", async () => {
		flakyHits = 0
		await using scratch = await temporaryDirectory("dl-")
		const dest = scratch.resolve("flaky.txt")
		const { bytes } = await downloadToFile({ url: `${base}/flaky`, dest, retries: 3, retryDelayMs: 10 })
		expect(bytes).toBe(7)
		expect(flakyHits).toBe(3)
	})

	it("throws immediately on a non-transient status", async () => {
		await using scratch = await temporaryDirectory("dl-")
		const dest = scratch.resolve("missing.txt")

		await expect(downloadToFile({ url: `${base}/missing`, dest, retries: 2, retryDelayMs: 10 })).rejects.toThrow(
			/HTTP 404/
		)
	})
})

describe("manifest helpers", () => {
	it("round-trips and keys entries; corrupt reads as null", async () => {
		await using scratch = await temporaryDirectory("manifest-")
		const path = scratch.resolve("MANIFEST.json")

		const entries = [
			{ id: "a", sha256: "x" },
			{ id: "b", sha256: "y" },
		]

		await writeManifest(path, entries)
		expect(await readManifest(path)).toEqual(entries)

		const keyed = await loadManifestEntries<{ id: string; sha256: string }>(path, (e) => e.id)
		expect(keyed.get("b")?.sha256).toBe("y")

		await writeManifest(path, undefined).catch(() => {})
		expect(await readManifest("/nonexistent/MANIFEST.json")).toBeNull()
	})

	it("isTransientStatus covers 429 + 5xx only", () => {
		expect(isTransientStatus(429)).toBe(true)
		expect(isTransientStatus(500)).toBe(true)
		expect(isTransientStatus(503)).toBe(true)
		expect(isTransientStatus(404)).toBe(false)
		expect(isTransientStatus(200)).toBe(false)
	})

	it("loadCollectionFiles keys a collection manifest by file name and reads a bare array as empty", async () => {
		await using scratch = await temporaryDirectory("collection-")
		const path = scratch.resolve("MANIFEST.json")

		await writeManifest(path, {
			source: "juso-kr",
			source_url: "https://business.juso.go.kr/",
			license: "KOGL Type 1",
			attribution: "행정안전부",
			downloaded_at: "2026-09-08T00:00:00Z",
			files: [
				{ filename: "202608ALLMTCHG00.zip", sha256: "a", bytes: 1 },
				{ filename: "202608ALLMTCHG01.zip", sha256: "b", bytes: 2 },
			],
		})

		const files = await loadCollectionFiles(path)
		expect([...files.keys()]).toEqual(["202608ALLMTCHG00.zip", "202608ALLMTCHG01.zip"])
		expect(files.get("202608ALLMTCHG01.zip")?.sha256).toBe("b")

		await writeManifest(path, [{ filename: "bare.zip", sha256: "c" }])
		expect((await loadCollectionFiles(path)).size).toBe(0)
		expect((await loadCollectionFiles(scratch.resolve("absent.json"))).size).toBe(0)
	})
})

describe("streamBodyToFile", () => {
	it("pipes a response the caller built and leaves no .tmp sibling behind", async () => {
		await using scratch = await temporaryDirectory("stream-")
		const dest = scratch.resolve("ok.txt")
		const bytes = await streamBodyToFile(await fetch(`${base}/ok`), dest)
		expect(bytes).toBe(7)
		expect(await readLocalTextFile(dest)).toBe("payload")
		expect(await pathExists(dest + ".tmp")).toBe(false)
	})
})

describe("withRetries", () => {
	it("runs the transfer again after a failure and answers the first success", async () => {
		let attempts = 0
		const lines: string[] = []

		const value = await withRetries(
			async () => {
				attempts++

				if (attempts < 3) throw new TypeError("terminated")

				return "landed"
			},
			{ retries: 3, retryDelayMs: 1, report: (line) => lines.push(line), label: "file.zip" }
		)

		expect(value).toBe("landed")
		expect(attempts).toBe(3)
		expect(lines).toEqual(["  retry 1/3 after 1ms — file.zip", "  retry 2/3 after 1ms — file.zip"])
	})

	it("rethrows the last error once the attempts are spent", async () => {
		let attempts = 0

		await expect(
			withRetries(
				async () => {
					attempts++
					throw new Error(`attempt ${attempts} failed`)
				},
				{ retries: 2, retryDelayMs: 1 }
			)
		).rejects.toThrow("attempt 3 failed")
	})
})

describe("resumableDownload", () => {
	it("keeps the bytes each dropped connection landed and asks for the remainder", async () => {
		await using scratch = await temporaryDirectory("resume-")
		const dest = scratch.resolve("body.bin")
		rangeConnections = 0
		const lines: string[] = []

		const bytes = await resumableDownload({
			url: `${base}/range`,
			dest,
			retryDelayMs: 1,
			report: (line) => lines.push(line),
		})

		expect(bytes).toBe(RANGE_BODY.length)
		expect(await readLocalTextFile(dest)).toBe(RANGE_BODY.toString())
		expect(await pathExists(dest + ".tmp")).toBe(false)
		// 40 bytes at 16 per connection: three connections, one progress line each.
		expect(rangeConnections).toBe(3)
		expect(lines).toHaveLength(3)
	})

	it("reads a 416 past the end as the whole body already on disk", async () => {
		await using scratch = await temporaryDirectory("resume-")
		const dest = scratch.resolve("body.bin")
		await writeLocalTextFile(RANGE_BODY.toString(), dest + ".tmp")
		rangeConnections = 0
		const bytes = await resumableDownload({ url: `${base}/range`, dest, retryDelayMs: 1 })
		expect(bytes).toBe(RANGE_BODY.length)
		expect(rangeConnections).toBe(1)
		expect(await readLocalTextFile(dest)).toBe(RANGE_BODY.toString())
	})

	it("throws when the host answers a range request with anything but 206", async () => {
		await using scratch = await temporaryDirectory("resume-")

		await expect(
			resumableDownload({ url: `${base}/no-range`, dest: scratch.resolve("body.bin"), retryDelayMs: 1 })
		).rejects.toThrow(/HTTP 200 for a range request/)
	})
})

describe("response header helpers", () => {
	it("cookieHeader folds every Set-Cookie value without its attributes", () => {
		const headers = new Headers()
		headers.append("set-cookie", "JSESSIONID=abc; Path=/; HttpOnly")
		headers.append("set-cookie", "XSRF-TOKEN=xyz; Path=/")
		expect(cookieHeader(new Response(null, { headers }))).toBe("JSESSIONID=abc; XSRF-TOKEN=xyz")
		expect(cookieHeader(new Response(null))).toBe("")
	})

	it("attachmentFilename prefers the RFC 5987 form, then the plain one, then the fallback", () => {
		const extended = new Response(null, {
			headers: {
				"content-disposition": `attachment; filename="fallback.zip"; filename*=UTF-8''%EC%A3%BC%EC%86%8C.zip`,
			},
		})

		expect(attachmentFilename(extended, "x.zip")).toBe("주소.zip")
		const plain = new Response(null, { headers: { "content-disposition": 'attachment; filename="report%20a.csv"' } })
		expect(attachmentFilename(plain, "x.zip")).toBe("report a.csv")
		const bare = new Response(null, { headers: { "content-disposition": "attachment; filename=list.txt" } })
		expect(attachmentFilename(bare, "x.zip")).toBe("list.txt")
		expect(attachmentFilename(new Response(null), "x.zip")).toBe("x.zip")
	})
})
