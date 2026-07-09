/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { downloadToFile, isTransientStatus, loadManifestEntries, readManifest, writeManifest } from "./download.ts"

let server: Server
let base: string
let flakyHits = 0

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.url === "/ok") {
			res.writeHead(200)
			res.end("payload")
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
	await new Promise<void>((resolve) => server.listen(0, resolve))
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
	server.close()
})

describe("downloadToFile", () => {
	it("writes the body and reports bytes", async () => {
		const dest = join(mkdtempSync(join(tmpdir(), "dl-")), "ok.txt")
		const { bytes } = await downloadToFile({ url: `${base}/ok`, dest })
		expect(bytes).toBe(7)
		expect(readFileSync(dest, "utf8")).toBe("payload")
	})

	it("retries transient statuses until success", async () => {
		flakyHits = 0
		const dest = join(mkdtempSync(join(tmpdir(), "dl-")), "flaky.txt")
		const { bytes } = await downloadToFile({ url: `${base}/flaky`, dest, retries: 3, retryDelayMs: 10 })
		expect(bytes).toBe(7)
		expect(flakyHits).toBe(3)
	})

	it("throws immediately on a non-transient status", async () => {
		const dest = join(mkdtempSync(join(tmpdir(), "dl-")), "missing.txt")
		await expect(downloadToFile({ url: `${base}/missing`, dest, retries: 2, retryDelayMs: 10 })).rejects.toThrow(
			/HTTP 404/
		)
	})
})

describe("manifest helpers", () => {
	it("round-trips and keys entries; corrupt reads as null", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "manifest-")), "MANIFEST.json")
		const entries = [
			{ id: "a", sha256: "x" },
			{ id: "b", sha256: "y" },
		]
		await writeManifest(path, entries)
		expect(await readManifest(path)).toEqual(entries)

		const keyed = await loadManifestEntries<{ id: string; sha256: string }>(path, (e) => e.id)
		expect(keyed.get("b")?.sha256).toBe("y")

		await writeManifest(path, undefined as never).catch(() => {})
		expect(await readManifest("/nonexistent/MANIFEST.json")).toBeNull()
	})

	it("isTransientStatus covers 429 + 5xx only", () => {
		expect(isTransientStatus(429)).toBe(true)
		expect(isTransientStatus(500)).toBe(true)
		expect(isTransientStatus(503)).toBe(true)
		expect(isTransientStatus(404)).toBe(false)
		expect(isTransientStatus(200)).toBe(false)
	})
})
