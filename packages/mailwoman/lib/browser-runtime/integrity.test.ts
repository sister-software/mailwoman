// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A download from a release directory is checked against the manifest's byte length and digest,
 *   reloaded once on a mismatch, and refused with the file's name when the reload also differs.
 */

import { sha256Hex } from "@mailwoman/core/hash"
import { describe, expect, it } from "vitest"

import { ArtifactLoadError } from "#browser-runtime/artifact-ledger"
import {
	type ArtifactIntegrity,
	ArtifactIntegrityError,
	artifactLookup,
	artifactMismatch,
	expectedArtifactLength,
	readArtifactIntegrityTable,
	verifyingFetch,
} from "#browser-runtime/integrity"

const MODEL_URL = "https://bucket.test/en-us/vX/model.onnx"
const GOOD = "the whole model"
const integrity: ArtifactIntegrity = { bytes: GOOD.length, sha256: sha256Hex(GOOD) }
const expectedFor = artifactLookup({ "model.onnx": integrity }, (file) => `https://bucket.test/en-us/vX/${file}`)

/**
 * A `fetch` that answers each call with the next body in `bodies` and records each call's init.
 */
function scriptedFetch(bodies: string[], status = 200) {
	const inits: Array<RequestInit | undefined> = []

	const fetchImpl: typeof fetch = async (_input, init) => {
		inits.push(init)

		return new Response(bodies.shift() ?? "", { status })
	}

	return { fetchImpl, inits }
}

describe("artifactMismatch", () => {
	it("reports a short body by its length and a same-length corruption by its digest", async () => {
		const encode = (text: string) => new TextEncoder().encode(text)

		await expect(artifactMismatch(encode(GOOD), integrity)).resolves.toBeNull()

		await expect(artifactMismatch(encode("the whole"), integrity)).resolves.toBe(
			`received 9 bytes, expected ${GOOD.length}`
		)

		await expect(artifactMismatch(encode("the whole mode!"), integrity)).resolves.toMatch(
			/^sha256 [0-9a-f]{64}, expected/
		)
	})
})

describe("verifyingFetch", () => {
	it("returns a matching body after one request", async () => {
		const { fetchImpl, inits } = scriptedFetch([GOOD])
		const response = await verifyingFetch(fetchImpl, expectedFor)(MODEL_URL)

		await expect(response.text()).resolves.toBe(GOOD)
		expect(inits).toHaveLength(1)
	})

	it("reloads once with cache: reload after a torn body and returns the reloaded bytes", async () => {
		const { fetchImpl, inits } = scriptedFetch(["the whole", GOOD])
		const response = await verifyingFetch(fetchImpl, expectedFor)(MODEL_URL, { cache: "default" })

		await expect(response.text()).resolves.toBe(GOOD)
		expect(inits.map((init) => init?.cache)).toEqual(["default", "reload"])
	})

	it("keeps a caller's no-store on the reload", async () => {
		const { fetchImpl, inits } = scriptedFetch(["torn", GOOD])

		await verifyingFetch(fetchImpl, expectedFor)(MODEL_URL, { cache: "no-store" })

		expect(inits.map((init) => init?.cache)).toEqual(["no-store", "no-store"])
	})

	it("throws an ArtifactIntegrityError, an ArtifactLoadError, naming the file when the reload also differs", async () => {
		const { fetchImpl } = scriptedFetch(["torn", "still torn"])
		const load = verifyingFetch(fetchImpl, expectedFor)(MODEL_URL)

		await expect(load).rejects.toBeInstanceOf(ArtifactIntegrityError)
		await expect(load).rejects.toBeInstanceOf(ArtifactLoadError)
		await expect(load).rejects.toThrow(/^model\.onnx failed its integrity check after a reload/)
		await expect(load).rejects.toMatchObject({ file: "model.onnx", url: MODEL_URL })
	})

	it("passes an error status and an unlisted URL through with one request each", async () => {
		const missing = scriptedFetch([""], 404)

		expect((await verifyingFetch(missing.fetchImpl, expectedFor)(MODEL_URL)).status).toBe(404)
		expect(missing.inits).toHaveLength(1)

		const { fetchImpl, inits } = scriptedFetch(["anything"])

		await expect(
			(await verifyingFetch(fetchImpl, expectedFor)("https://bucket.test/en-us/vX/other.bin")).text()
		).resolves.toBe("anything")

		expect(inits).toHaveLength(1)
	})
})

describe("readArtifactIntegrityTable", () => {
	it("reads an absent field as no table, for a manifest published before it", () => {
		expect(readArtifactIntegrityTable(undefined, "vX")).toBeUndefined()
		expect(readArtifactIntegrityTable(null, "vX")).toBeUndefined()
	})

	it("refuses a malformed record and identifies the release and the file", () => {
		expect(() => readArtifactIntegrityTable({ "model.onnx": { bytes: "12" } }, "v9.9.9")).toThrow(
			'releases.json entry v9.9.9: artifacts["model.onnx"] is not a { bytes, sha256 } record'
		)

		expect(() => readArtifactIntegrityTable([], "v9.9.9")).toThrow(/artifacts is not an object/)
	})
})

describe("expectedArtifactLength", () => {
	it("answers the recorded length, or null for a file or release without one", () => {
		expect(expectedArtifactLength({ artifacts: { "model.onnx": integrity } }, "model.onnx")).toBe(GOOD.length)
		expect(expectedArtifactLength({ artifacts: { "model.onnx": integrity } }, "tokenizer.model")).toBeNull()
		expect(expectedArtifactLength({}, "model.onnx")).toBeNull()
		expect(expectedArtifactLength(null, "model.onnx")).toBeNull()
	})
})
