/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it, vi } from "vitest"

import {
	IMMUTABLE_CACHE_CONTROL,
	MUTABLE_CACHE_CONTROL,
	planPublicBucketUploads,
	publishToPublicBucket,
	writePairIndexManifests,
} from "#tools/publish/public-bucket"

describe("publishToPublicBucket", () => {
	it("plans stable keys and the cache metadata used by browser range requests", async () => {
		await using directory = await temporaryDirectory("mw-public-bucket-")
		await makeDirectories(directory.path("en-us", "v10.0.0"))
		await writeLocalFile("model", directory.path("en-us", "v10.0.0", "model.onnx"))
		await writeLocalFile("{}", directory.path("en-us", "releases.json"))

		const uploads = await planPublicBucketUploads(directory.path, "mailwoman")

		expect(
			uploads.map(({ relativePath, key, contentType, cacheControl }) => ({
				relativePath,
				key,
				contentType,
				cacheControl,
			}))
		).toEqual([
			{
				relativePath: "en-us/releases.json",
				key: "mailwoman/en-us/releases.json",
				contentType: "application/json",
				cacheControl: MUTABLE_CACHE_CONTROL,
			},
			{
				relativePath: "en-us/v10.0.0/model.onnx",
				key: "mailwoman/en-us/v10.0.0/model.onnx",
				contentType: "application/octet-stream",
				cacheControl: IMMUTABLE_CACHE_CONTROL,
			},
		])
	})

	it("gzip-encodes whole-fetch binaries and leaves range-read databases identity-encoded", async () => {
		await using directory = await temporaryDirectory("mw-public-bucket-")
		await makeDirectories(directory.path("en-us", "v10.0.0"))
		await writeLocalFile("fst", directory.path("en-us", "v10.0.0", "fst-en-US.bin"))
		await writeLocalFile("db", directory.path("en-us", "v10.0.0", "candidate.db"))
		await writeLocalFile("model", directory.path("en-us", "v10.0.0", "model.onnx"))
		await writeLocalFile("rows", directory.path("en-us", "v10.0.0", "embeddings.rows"))

		const uploads = await planPublicBucketUploads(directory.path, "mailwoman")
		const encodings = Object.fromEntries(uploads.map((upload) => [upload.relativePath, upload.contentEncoding]))

		expect(encodings).toEqual({
			"en-us/v10.0.0/candidate.db": null,
			"en-us/v10.0.0/embeddings.rows": null,
			"en-us/v10.0.0/fst-en-US.bin": "gzip",
			"en-us/v10.0.0/model.onnx": "gzip",
		})
	})

	it("refuses a flat pair-index key before invoking the upload transport", async () => {
		await using directory = await temporaryDirectory("mw-public-bucket-")
		await makeDirectories(directory.path("pair-index"))
		await writeLocalFile("index", directory.path("pair-index", "pair-index-gb.bin"))
		const upload = vi.fn()

		await expect(publishToPublicBucket({ src: directory.path, upload })).rejects.toThrow(
			/pair-index\/2026-10-17\/pair-index-gb\.bin/
		)

		expect(upload).not.toHaveBeenCalled()
	})

	it("writes each pair-index generation's manifest from its staged binaries and publishes it beside them", async () => {
		await using directory = await temporaryDirectory("mw-public-bucket-")
		await makeDirectories(directory.path("pair-index", "2026-10-17"))
		await writeLocalFile("nz", directory.path("pair-index", "2026-10-17", "pair-index-nz.bin"))
		await writeLocalFile("gb", directory.path("pair-index", "2026-10-17", "pair-index-gb.bin"))
		await writeLocalFile("us", directory.path("pair-index", "2026-10-17", "pair-index-us.bin"))

		const upload = vi.fn()
		const result = await publishToPublicBucket({ src: directory.path, upload })

		const manifest = upload.mock.calls
			.map(([asset]) => asset as { relativePath: string; contentType: string; cacheControl: string })
			.find((asset) => asset.relativePath === "pair-index/2026-10-17/index.json")

		expect(result.objects).toBe(4)
		expect(manifest).toMatchObject({ contentType: "application/json", cacheControl: IMMUTABLE_CACHE_CONTROL })

		await expect(readLocalJSONFile(directory.path("pair-index", "2026-10-17", "index.json"))).resolves.toEqual({
			version: "2026-10-17",
			countries: ["gb", "nz", "us"],
		})
	})

	it("leaves a staged manifest alone when its generation holds no binary, so a manifest can ship by itself", async () => {
		await using directory = await temporaryDirectory("mw-public-bucket-")
		await makeDirectories(directory.path("pair-index", "2026-10-17"))

		await writeLocalFile(
			'{"version":"2026-10-17","countries":["gb"]}',
			directory.path("pair-index", "2026-10-17", "index.json")
		)

		await expect(writePairIndexManifests(directory.path)).resolves.toEqual([])

		const uploads = await planPublicBucketUploads(directory.path, "mailwoman")

		expect(uploads.map((upload) => upload.relativePath)).toEqual(["pair-index/2026-10-17/index.json"])
	})

	it("refuses to plan a pair-index generation that lacks its manifest", async () => {
		await using directory = await temporaryDirectory("mw-public-bucket-")
		await makeDirectories(directory.path("pair-index", "2026-10-17"))
		await writeLocalFile("gb", directory.path("pair-index", "2026-10-17", "pair-index-gb.bin"))

		await expect(planPublicBucketUploads(directory.path, "mailwoman")).rejects.toThrow(
			/pair-index\/2026-10-17 without its index\.json/
		)
	})

	it("does not read credentials or invoke the transport during a dry run", async () => {
		await using directory = await temporaryDirectory("mw-public-bucket-")
		await writeLocalFile("{}", directory.path("releases.json"))

		const upload = vi.fn()
		const lines: string[] = []

		const result = await publishToPublicBucket({
			src: directory.path,
			dryRun: true,
			env: {},
			upload,
			onObject: (line) => lines.push(line),
		})

		expect(result).toMatchObject({ bucket: "mailwoman-public", prefix: "mailwoman", objects: 1, bytes: 2 })
		expect(upload).not.toHaveBeenCalled()
		expect(lines[0]).toContain("[dry-run] mailwoman/releases.json")
	})
})
