// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { ProvenanceManifest, ProvenancePayload } from "@mailwoman/license/product/provenance"
import { resolvePath } from "path-ts"
import { describe, expect, it } from "vitest"

import { fromBase64URL, utf8Text } from "#crypto/base64url"
import { readLocalBuffer, readLocalJSONFile } from "#fs/readers"
import { temporaryDirectory } from "#fs/temporary"
import { copyFileTo, removePath, writeLocalBuffer, writeLocalJSONFile } from "#fs/writers"
import { bindArtifacts, encodeProvenanceManifest, verifyProvenanceManifest } from "#license/provenance"
import { resolvePackagePath } from "#module/resolvers"
import { parseJSONStrict } from "#values/json"

interface ProvenanceFixtures {
	trusted_provenance_keys: Record<string, string>
	cases: Array<{ name: string; manifest: string; require_signature: boolean; expect: string }>
}

const directory = resolvePackagePath("@mailwoman/license", "test", "fixtures", "product", "provenance")

const fixtures = await readLocalJSONFile<ProvenanceFixtures>(
	resolvePackagePath("@mailwoman/license", "test", "fixtures", "product", "provenance.json")
)

const keys = await readLocalJSONFile<Record<string, { kid: string; privateKeyPEM: string }>>(
	resolvePackagePath("@mailwoman/license", "test", "fixtures", "product", "keys.json")
)

const trustedKeys = fixtures.trusted_provenance_keys

const FILES = ["model.onnx", "CORPUS.json", "TRAINING.json", "model.provenance.json"]

/**
 * A temporary copy of the signed fixture, removed when the test's scope ends.
 */
async function copied(): Promise<Awaited<ReturnType<typeof temporaryDirectory>> & { target: string }> {
	const scratch = await temporaryDirectory()
	const target = scratch.path.toString()

	for (const file of FILES) {
		await copyFileTo(resolvePath(directory, file), resolvePath(target, file))
	}

	return scratch.moveWith({ target })
}

function code(result: Awaited<ReturnType<typeof verifyProvenanceManifest>>): string {
	return result.status === "verified" ? "verified" : result.refusal
}

describe("the shared provenance fixtures", () => {
	// The Rust verifier runs the same cases in packages/license/crates/product-license/tests/fixtures.rs.
	it.each(fixtures.cases)("$name", async ({ manifest, require_signature, expect: expected }) => {
		const result = await verifyProvenanceManifest(resolvePath(directory, manifest), {
			trustedKeys,
			requireSignature: require_signature,
		})

		expect(code(result)).toBe(expected)
	})
})

describe("provenance binding", () => {
	it.each(["model.onnx", "CORPUS.json", "TRAINING.json"])("refuses the manifest once %s changes", async (file) => {
		await using scratch = await copied()
		const { target } = scratch
		const bytes = await readLocalBuffer(resolvePath(target, file))

		bytes[0]! ^= 1
		await writeLocalBuffer(bytes, resolvePath(target, file))

		const result = await verifyProvenanceManifest(resolvePath(target, "model.provenance.json"), { trustedKeys })

		expect(code(result)).toBe("artifact_mismatch")
	})

	it("refuses a manifest moved beside another model", async () => {
		await using scratch = await copied()
		const { target } = scratch

		await writeLocalBuffer(Buffer.from("another model's graph\n"), resolvePath(target, "model.onnx"))

		expect(code(await verifyProvenanceManifest(resolvePath(target, "model.provenance.json"), { trustedKeys }))).toBe(
			"artifact_mismatch"
		)
	})

	it("refuses a manifest whose sidecar is missing", async () => {
		await using scratch = await copied()
		const { target } = scratch

		await removePath(resolvePath(target, "CORPUS.json"))

		expect(code(await verifyProvenanceManifest(resolvePath(target, "model.provenance.json"), { trustedKeys }))).toBe(
			"artifact_mismatch"
		)
	})

	it("refuses a payload altered under the original signature, and keeps the expired grant as history", async () => {
		await using scratch = await copied()
		const { target } = scratch
		const path = resolvePath(target, "model.provenance.json")
		const manifest = await readLocalJSONFile<ProvenanceManifest>(path)
		const payload = parseJSONStrict<ProvenancePayload>(utf8Text(fromBase64URL(manifest.payload)))

		// The grant in the record expired on 2027-01-31, and the manifest still verifies: it records history.
		const grant = payload.training!.grant!

		expect(grant.expires).toBe("2027-01-31")
		expect(code(await verifyProvenanceManifest(path, { trustedKeys }))).toBe("verified")

		grant.expires = "2099-12-31"

		const resigned = await encodeProvenanceManifest(payload, keys.provenance!)

		await writeLocalJSONFile({ ...resigned, signature: manifest.signature }, path)

		expect(code(await verifyProvenanceManifest(path, { trustedKeys }))).toBe("bad_signature")
	})

	it("binds the bytes of a manifest it signs, and the result verifies", async () => {
		await using scratch = await copied()
		const { target } = scratch
		const manifest = await readLocalJSONFile<ProvenanceManifest>(resolvePath(target, "model.provenance.json"))
		const payload = parseJSONStrict<ProvenancePayload>(utf8Text(fromBase64URL(manifest.payload)))

		await writeLocalBuffer(Buffer.from("a re-exported graph\n"), resolvePath(target, "model.onnx"))
		payload.artifacts = await bindArtifacts(target, ["model.onnx", "CORPUS.json", "TRAINING.json"])

		await writeLocalJSONFile(
			await encodeProvenanceManifest(payload, keys.provenance!),
			resolvePath(target, "model.provenance.json")
		)

		expect(code(await verifyProvenanceManifest(resolvePath(target, "model.provenance.json"), { trustedKeys }))).toBe(
			"verified"
		)
	})
})
