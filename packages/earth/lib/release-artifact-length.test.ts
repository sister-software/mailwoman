// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The service worker's torn-body length lookup reads a release file's length from its locale's manifest.
 */

import { describe, expect, it, vi } from "vitest"

import { createReleaseArtifactLengthLookup, releaseFileLocation } from "#release-artifact-length"

const MODEL_URL = "https://public.mailwoman.post/mailwoman/en-us/v10.8.0/model.onnx"
const MANIFEST_URL = "https://public.mailwoman.post/mailwoman/en-us/releases.json"
const SHA256 = "a".repeat(64)

const manifest = {
	locale: "en-us",
	defaultVersion: "v10.8.0",
	releases: [
		{ version: "v10.8.0", artifacts: { "model.onnx": { bytes: 29_800_000, sha256: SHA256 } } },
		{ version: "v9.1.0" },
	],
}

describe("releaseFileLocation", () => {
	it("splits a release file URL into its locale manifest, version and file", () => {
		expect(releaseFileLocation(new URL(MODEL_URL))).toEqual({
			manifestURL: MANIFEST_URL,
			version: "v10.8.0",
			file: "model.onnx",
		})
	})
})

describe("createReleaseArtifactLengthLookup", () => {
	it("answers the recorded length of a file the release's manifest lists", async () => {
		const readManifest = vi.fn(async (url: string) => (url === MANIFEST_URL ? manifest : null))
		const lookup = createReleaseArtifactLengthLookup(readManifest)

		await expect(lookup(new Request(MODEL_URL))).resolves.toBe(29_800_000)
		expect(readManifest).toHaveBeenCalledWith(MANIFEST_URL)
	})

	it("answers null for an unlisted file, a release without the table, and a locale without a cached manifest", async () => {
		const lookup = createReleaseArtifactLengthLookup(async (url) => (url === MANIFEST_URL ? manifest : null))

		await expect(lookup(new Request(MODEL_URL.replace("model.onnx", "tokenizer.model")))).resolves.toBeNull()
		await expect(lookup(new Request(MODEL_URL.replace("v10.8.0", "v9.1.0")))).resolves.toBeNull()
		await expect(lookup(new Request(MODEL_URL.replace("en-us", "cjk")))).resolves.toBeNull()
	})

	it("answers null with a warning naming the manifest for a malformed table", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		const malformed = { releases: [{ version: "v10.8.0", artifacts: { "model.onnx": { bytes: "29" } } }] }
		const lookup = createReleaseArtifactLengthLookup(async () => malformed)

		try {
			await expect(lookup(new Request(MODEL_URL))).resolves.toBeNull()
			expect(warn).toHaveBeenCalledWith(expect.stringContaining(MANIFEST_URL))
		} finally {
			warn.mockRestore()
		}
	})
})
