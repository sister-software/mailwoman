/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reaches paikkatiedot.ymparisto.fi. In the slow suite, so the fast suite stays offline.
 *
 *   The body is 351 MB and the file is republished daily, so this measures what the host states
 *   about it rather than transferring it. The two statements the module depends on are both here:
 *   that the host answers a `HEAD` with a length and a modification time, and that it ignores
 *   `Range`, which is what rules out a resumed transfer.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { describe, expect, it } from "vitest"

import {
	assertRyhtiColumns,
	FI_RYHTI_CSV_URL,
	type RyhtiManifest,
	readRyhtiHead,
	ryhtiInputPath,
	fetchRyhti,
} from "#fi/tools/fetch/ryhti"
import { readManifest } from "#tools/fetch/download"

const TIMEOUT_MS = 120_000

/**
 * The whole transfer is 351 MB compressed and 793 MB on disk, so it runs only when asked for by name.
 *
 * `MAILWOMAN_RYHTI_FULL_FETCH=1 yarn vitest --run --config vitest.slow.config.ts <this file>`.
 */
// oxlint-disable-next-line sister-software/no-process-globals -- a per-run test switch rather than project configuration, so it has no entry in `@mailwoman/core/env`.
const FULL_FETCH = process.env.MAILWOMAN_RYHTI_FULL_FETCH === "1"

/**
 * Long enough for the whole transfer and the decompression on a lab connection.
 */
const FULL_FETCH_TIMEOUT_MS = 1_800_000

describe("readRyhtiHead against paikkatiedot.ymparisto.fi", () => {
	it(
		"states a length and a modification time, which is what the re-run check compares",
		async () => {
			await using client = new APIClient({ displayName: "ryhti integration", retry: true })
			const head = await readRyhtiHead(client)

			// Both are what the skip decision rests on.
			// A measured value is not asserted: the publisher rewrites the file daily
			// and the length moves with it.
			expect(head.contentLength).toBeGreaterThan(0)
			expect(head.lastModified).not.toBeNull()
			expect(Number.isNaN(new Date(head.lastModified ?? "").getTime())).toBe(false)

			// `application/x-gzip;charset=UTF-8` as served on 2026-10-02.
			// The check is that it is not a page, since an html body under http 200 is
			// what a portal answers when the file is gone.
			expect(head.contentType ?? "").not.toContain("text/html")
		},
		TIMEOUT_MS
	)

	it(
		"ignores Range, so an interrupted transfer restarts rather than resumes",
		async () => {
			const response = await fetch(FI_RYHTI_CSV_URL, { headers: { range: "bytes=0-4095" }, redirect: "follow" })

			await response.body?.cancel()

			// A host honouring the range would answer 206 with a `content-range`.
			// This one answers 200 with the whole length, which is why `resumableDownload` is not on this path.
			expect(response.status).toBe(200)
			expect(response.headers.get("content-range")).toBeNull()
			expect(response.headers.get("accept-ranges")).toBeNull()
			expect(Number(response.headers.get("content-length"))).toBeGreaterThan(4096)
		},
		TIMEOUT_MS
	)
})

describe("fetchRyhti against paikkatiedot.ymparisto.fi", () => {
	it.runIf(FULL_FETCH)(
		"writes the CSV the adapter reads, then asks for nothing on a second run",
		async () => {
			await using scratch = await temporaryDirectory("mailwoman-ryhti-full-")
			const summary = await fetchRyhti({ outRoot: scratch.path }, (line) => process.stderr.write(`${line}\n`))

			expect(summary).toMatchObject({ fetched: 1, failed: 0 })

			const manifest = await readManifest<RyhtiManifest>(scratch.path("ryhti", "MANIFEST.json"))

			// The decompressed count is larger than the compressed one the host stated,
			// and both are read rather than predicted.
			expect(manifest?.bytes).toBeGreaterThan(manifest?.compressed_bytes ?? 0)
			expect(manifest?.sha256).toMatch(/^[0-9a-f]{64}$/u)
			expect(manifest?.last_modified).not.toBeNull()
			expect(() => assertRyhtiColumns(manifest?.columns ?? [], "live")).not.toThrow()

			// The path the adapter is given is the file this run wrote.
			expect(ryhtiInputPath(scratch.path).toString()).toBe(scratch.path("ryhti", manifest?.filename ?? "").toString())

			expect(await fetchRyhti({ outRoot: scratch.path })).toMatchObject({ fetched: 0, skipped: 1 })
		},
		FULL_FETCH_TIMEOUT_MS
	)
})
