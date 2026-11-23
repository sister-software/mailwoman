// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Signs and verifies model provenance manifests (`<graph>.provenance.json`).
 *
 *   `@mailwoman/license/product/provenance` defines the manifest, its payload and the refusal codes.
 *   `trainer-export` writes and signs the manifest in Rust when it exports a graph.
 *
 *   This module verifies it against the files beside it and the provenance keys in the shared
 *   trust register, and it signs the manifest the issuer writes for a customer-submitted model.
 *   That signature attests only to the submitted bytes.
 *
 *   A provenance key is separate from a license key: the trust register keeps them in
 *   separate lists, and a manifest verifies only under a provenance key.
 */

import {
	type BoundArtifact,
	PROVENANCE_PREFIX,
	type ProvenanceManifest,
	ProvenanceManifestSchema,
	type ProvenancePayload,
	ProvenancePayloadSchema,
	ProvenanceRefusal,
	type ProvenanceVerification,
} from "@mailwoman/license/product/provenance"
import { schemaIssue } from "@mailwoman/license/product/token"
import { trustedProvenanceSigningKeys } from "@mailwoman/license/product/trust"
import { dirname, type PathBuilderLike, resolvePath } from "path-ts"

import { fromBase64URL, toBase64URL, utf8Bytes } from "#crypto/base64url"
import { ED25519_SIGNATURE_BYTES, signEd25519, verifyEd25519 } from "#crypto/ed25519"
import { readLocalBuffer, readLocalTextFile } from "#fs/readers"
import { sha256Hex } from "#hash"
import { stringifyJSON } from "#json"

/**
 * A provenance signing key: its key ID and its PKCS8 private half.
 */
export interface ProvenanceSigner {
	kid: string
	privateKeyPEM: string
}

/**
 * Hashes each file under `directory` and returns the entries a manifest binds, in the order given.
 *
 * @throws When a file can't be read.
 */
export async function bindArtifacts(directory: PathBuilderLike, paths: readonly string[]): Promise<BoundArtifact[]> {
	const bound: BoundArtifact[] = []

	for (const path of paths) {
		const bytes = await readLocalBuffer(resolvePath(directory, path))

		bound.push({ path, sha256: sha256Hex(bytes), bytes: bytes.length })
	}

	return bound
}

/**
 * Validates a payload and returns its manifest, signed when a signer is given.
 *
 * An unsigned manifest must declare the `unattested` attestation, and a signed one must declare another.
 */
export async function encodeProvenanceManifest(
	payload: ProvenancePayload,
	signer: ProvenanceSigner | null
): Promise<ProvenanceManifest> {
	const checked = ProvenancePayloadSchema.parse(payload)

	if ((checked.attestation === "unattested") !== (signer == null)) {
		throw new Error(`a manifest with attestation ${checked.attestation} must ${signer ? "not " : ""}be signed`)
	}

	const encoded = toBase64URL(utf8Bytes(stringifyJSON(checked)))

	if (!signer) return { format: "mailwoman-model-provenance/1", payload: encoded, kid: null, signature: null }

	const signature = await signEd25519(utf8Bytes(`${PROVENANCE_PREFIX}.${encoded}`), signer.privateKeyPEM)

	return {
		format: "mailwoman-model-provenance/1",
		payload: encoded,
		kid: signer.kid,
		signature: toBase64URL(signature),
	}
}

function manifestRefusal(refusal: ProvenanceRefusal, reason: string): ProvenanceVerification {
	return { status: "refused", refusal, reason }
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true })

function manifestJSON(text: string): unknown {
	try {
		// oxlint-disable-next-line no-restricted-properties -- an unreadable manifest is a refusal with a reason.
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/**
 * Verifies a manifest file against the files beside it.
 *
 * It checks the manifest and payload schemas, the signature under a trusted provenance key,
 * and each bound file's length and sha256.
 * `requireSignature` refuses an unattested manifest.
 * The commercial production path sets it.
 */
export async function verifyProvenanceManifest(
	manifestPath: PathBuilderLike,
	options: { trustedKeys?: Readonly<Record<string, string>>; requireSignature?: boolean } = {}
): Promise<ProvenanceVerification> {
	const manifest = ProvenanceManifestSchema.safeParse(manifestJSON(await readLocalTextFile(manifestPath)))

	if (!manifest.success) return manifestRefusal(ProvenanceRefusal.Malformed, `manifest: ${schemaIssue(manifest.error)}`)

	let payloadText: string

	try {
		payloadText = STRICT_UTF8.decode(fromBase64URL(manifest.data.payload))
	} catch {
		return manifestRefusal(ProvenanceRefusal.Malformed, "payload is not base64url-encoded UTF-8")
	}

	const payload = ProvenancePayloadSchema.safeParse(manifestJSON(payloadText))

	if (!payload.success) return manifestRefusal(ProvenanceRefusal.Malformed, `payload: ${schemaIssue(payload.error)}`)

	const { kid, signature } = manifest.data

	if (kid == null || signature == null) {
		if (kid != null || signature != null) {
			return manifestRefusal(ProvenanceRefusal.Malformed, "kid and signature must be both present or both null")
		}

		if (payload.data.attestation !== "unattested") {
			return manifestRefusal(
				ProvenanceRefusal.Unsigned,
				`an unsigned manifest declares attestation ${payload.data.attestation}`
			)
		}

		if (options.requireSignature) return manifestRefusal(ProvenanceRefusal.Unsigned, "the manifest is unsigned")
	} else {
		const publicKeyPEM = (options.trustedKeys ?? trustedProvenanceSigningKeys())[kid]

		if (!publicKeyPEM) {
			return manifestRefusal(
				ProvenanceRefusal.UnknownKey,
				`signed by provenance key id ${kid}, which this build does not trust`
			)
		}

		const signatureBytes = fromBase64URL(signature)

		const signed =
			signatureBytes.length === ED25519_SIGNATURE_BYTES &&
			(await verifyEd25519(utf8Bytes(`${PROVENANCE_PREFIX}.${manifest.data.payload}`), publicKeyPEM, signatureBytes))

		if (!signed) return manifestRefusal(ProvenanceRefusal.BadSignature, `signature does not verify under key id ${kid}`)

		if (payload.data.attestation === "unattested") {
			return manifestRefusal(ProvenanceRefusal.Malformed, "a signed manifest declares attestation unattested")
		}
	}

	const directory = dirname(resolvePath(manifestPath))

	for (const artifact of payload.data.artifacts) {
		let bytes: Buffer

		try {
			bytes = await readLocalBuffer(resolvePath(directory, artifact.path))
		} catch {
			return manifestRefusal(ProvenanceRefusal.ArtifactMismatch, `${artifact.path} is missing beside the manifest`)
		}

		if (bytes.length !== artifact.bytes || sha256Hex(bytes) !== artifact.sha256) {
			return manifestRefusal(
				ProvenanceRefusal.ArtifactMismatch,
				`${artifact.path} differs from the bytes the manifest binds`
			)
		}
	}

	return { status: "verified", kid, payload: payload.data }
}
