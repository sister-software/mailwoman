/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it, vi } from "vitest"

import {
	IMMUTABLE_CACHE_CONTROL,
	MUTABLE_CACHE_CONTROL,
	planDemoAssetUploads,
	publishDemoAssets,
} from "#release-tools/publish/demo-assets"

describe("publishDemoAssets", () => {
	it("plans stable keys and the cache metadata used by browser range requests", async () => {
		await using directory = await temporaryDirectory("mw-demo-assets-")
		await makeDirectories(directory.path("en-us", "v10.0.0"))
		await writeLocalFile("model", directory.path("en-us", "v10.0.0", "model.onnx"))
		await writeLocalFile("{}", directory.path("en-us", "releases.json"))

		const uploads = await planDemoAssetUploads(directory.path, "mailwoman")

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

	it("refuses a flat pair-index key before invoking the upload transport", async () => {
		await using directory = await temporaryDirectory("mw-demo-assets-")
		await makeDirectories(directory.path("pair-index"))
		await writeLocalFile("index", directory.path("pair-index", "pair-index-gb.bin"))
		const upload = vi.fn()

		await expect(publishDemoAssets({ src: directory.path, upload })).rejects.toThrow(
			/pair-index\/2026-08-05\/pair-index-gb\.bin/
		)

		expect(upload).not.toHaveBeenCalled()
	})

	it("does not read credentials or invoke the transport during a dry run", async () => {
		await using directory = await temporaryDirectory("mw-demo-assets-")
		await writeLocalFile("{}", directory.path("releases.json"))
		const upload = vi.fn()
		const lines: string[] = []

		const result = await publishDemoAssets({
			src: directory.path,
			dryRun: true,
			env: {},
			upload,
			onObject: (line) => lines.push(line),
		})

		expect(result).toMatchObject({ bucket: "nexus-public", prefix: "mailwoman", objects: 1, bytes: 2 })
		expect(upload).not.toHaveBeenCalled()
		expect(lines[0]).toContain("[dry-run] mailwoman/releases.json")
	})
})
